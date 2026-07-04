"""Scheduled Lambda that polls the live Up home-loan balance from BankSync and
stores it in DynamoDB (WHIT-8).

This is an *outbound* half of the BankSync integration (a sibling of
``lambda_sync_trigger/handler.py``), but where the sync trigger POSTs to kick off
a feed sync, this one GETs the account's live balance and persists it:

    EventBridge Scheduler (terraform/scheduler.tf, daily)
        -> this lambda
        -> GET https://api.banksync.io/v1/banks/{bid}/accounts/{aid}/balances
        -> normalise (mortgage amount is negative -> abs) -> upsert one row
           (HomeLoanBalanceRepository) that the read API serves as GET /homeloan.

BankSync's `getLoan` (principalBalance) isn't supported by the fiskil:au provider
yet, so we read `getBalance` and take abs(amount) for the mortgage account.

Invoked only by EventBridge Scheduler, never by API Gateway. ``constants``,
``ssm``, and ``repository`` are provided by the shared Lambda layer.
"""

import json
import logging
import urllib.request
from decimal import Decimal, InvalidOperation

from constants import (
    BANKSYNC_API_KEY_PATH,
    BANKSYNC_BASE_URL,
    HOMELOAN_ACCOUNT_ID,
    HOMELOAN_BALANCE_SOURCE,
    HOMELOAN_BALANCE_TIMEOUT_SECONDS,
)
from repository import HomeLoanBalanceRepository
from ssm import get_param

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_api_key = None


class BalanceError(Exception):
    """A getBalance response we can't turn into a stored balance (BankSync
    reported failure, the payload was missing fields, or it wasn't the mortgage
    account). Raised by normalise_balance and swallowed by lambda_handler so a bad
    poll leaves the last-good row untouched."""


def get_api_key() -> str:
    """Fetch and cache the BankSync API key from SSM for the life of the container."""
    global _api_key
    if _api_key is None:
        _api_key = get_param(BANKSYNC_API_KEY_PATH)
    return _api_key


def fetch_balance(bid: str, aid: str, api_key: str) -> dict:
    """GET /v1/banks/{bid}/accounts/{aid}/balances -> the parsed JSON payload."""
    url = f"{BANKSYNC_BASE_URL}/v1/banks/{bid}/accounts/{aid}/balances"
    req = urllib.request.Request(
        url,
        headers={
            "X-API-Key": api_key,
            # BankSync sits behind Cloudflare, which blocks the default
            # "Python-urllib" User-Agent with a 403 (error 1010). Send our own.
            "User-Agent": "whittle-balance-poller",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=HOMELOAN_BALANCE_TIMEOUT_SECONDS) as resp:
        return json.loads(resp.read())


def normalise_balance(payload: dict) -> dict:
    """Turn a getBalance payload into {"balance", "as_of", "currency"}.

    The mortgage's `amount` is NEGATIVE (a liability owed), so the outstanding
    balance is its absolute value. Only `amount`/`date` are treated as required;
    `availableBalance`/`pendingBalance` are ignored (nullable/absent in practice).
    Raises BalanceError on a failure response, a missing field, or a non-mortgage
    account (a guard against pointing at the wrong account).
    """
    if payload.get("success") is not True:
        raise BalanceError(f"getBalance returned failure: {payload.get('error')!r}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise BalanceError("getBalance payload missing `data`")

    account_type = data.get("accountType")
    if account_type is not None and account_type != "mortgage":
        raise BalanceError(f"expected a mortgage account, got {account_type!r}")

    # `is None` (not just missing key) so a JSON `null` amount raises a clean
    # BalanceError rather than an opaque Decimal("None") InvalidOperation.
    if data.get("amount") is None:
        raise BalanceError("getBalance `data` missing `amount`")

    try:
        # abs() so the negative liability becomes a positive outstanding balance.
        balance = abs(Decimal(str(data["amount"])))
    except InvalidOperation as e:
        # A non-numeric amount is bad input like any other — surface it as the
        # module's own BalanceError, not a raw decimal exception.
        raise BalanceError(f"getBalance `amount` is not a number: {data['amount']!r}") from e
    as_of = data.get("date")
    if not as_of:
        raise BalanceError("getBalance `data` missing `date`")
    currency = data.get("currency") or "AUD"
    return {"balance": balance, "as_of": as_of, "currency": currency}


def lambda_handler(event, context):
    """Poll the home-loan balance and upsert it.

    Every failure mode (transport error, non-200, `success:false`, missing/
    malformed fields) is logged and swallowed — the poll is best-effort and the
    read API keeps serving the last-good balance. It never raises, and on failure
    it never overwrites the stored balance (so a bad tick can't zero it). A
    genuine 0 reading (a paid-off loan) is a success and IS written.
    """
    source = HOMELOAN_BALANCE_SOURCE
    try:
        payload = fetch_balance(source["bid"], source["aid"], get_api_key())
        normalised = normalise_balance(payload)
        HomeLoanBalanceRepository().upsert_balance(
            HOMELOAN_ACCOUNT_ID,
            normalised["balance"],
            normalised["as_of"],
            normalised["currency"],
        )
    except Exception as e:
        # Best-effort: any failure (transport, non-200 HTTPError, success:false,
        # missing fields) leaves the last-good row and never zeroes the balance.
        logger.error("home-loan balance poll failed, keeping last-good: %s", e)
        return {"stored": False}

    logger.info(
        "home-loan balance stored: %s %s (as of %s)",
        normalised["currency"],
        normalised["balance"],
        normalised["as_of"],
    )
    return {"stored": True}
