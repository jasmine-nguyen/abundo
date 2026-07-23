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

import calendar
import json
import logging
import time
import urllib.request
from decimal import Decimal, InvalidOperation
from typing import Optional

from constants import (
    ACCOUNT_ID_MAP,
    BALANCE_SOURCES,
    BANKSYNC_API_KEY_PATH,
    BANKSYNC_BASE_URL,
    HOMELOAN_ACCOUNT_ID,
    HOMELOAN_BALANCE_SOURCE,
    HOMELOAN_BALANCE_TIMEOUT_SECONDS,
    MAX_PAGE_SIZE,
    MIN_REPAYMENT_NOTIFY,
    REPAYMENT_DROP_THRESHOLD,
    REPAYMENT_INCOMING_TYPE,
    REPAYMENT_MISS_LOOKBACK_DAYS,
)
from milestones import notify_milestone_crossing
from repository import (
    AccountBalanceRepository,
    DeviceRepository,
    HomeLoanBalanceRepository,
    LoanFactsRepository,
    TransactionRepository,
)
from repository_notify import NotifyRepository
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
            "User-Agent": "abundo-homeloan-request",
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


def normalise_account_balance(payload: dict) -> dict:
    """Turn a getBalance payload into a SIGNED per-account balance row (WHIT-212).

    Unlike ``normalise_balance`` (mortgage-only, abs), this keeps BankSync's ``amount``
    SIGNED as-is — spending positive, a loan or credit-card balance negative — and also
    captures ``availableBalance``, ``currency`` and ``accountType`` for the Accounts tab.
    Only ``amount``/``date`` are required; a failure response or a missing required field
    raises BalanceError so the caller keeps this account's last-good row. There is NO
    account-type guard here: this path is meant to store every account, not just the
    mortgage.
    """
    if payload.get("success") is not True:
        raise BalanceError(f"getBalance returned failure: {payload.get('error')!r}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise BalanceError("getBalance payload missing `data`")

    # `is None` (not just missing) so a JSON `null` amount raises a clean BalanceError
    # rather than an opaque Decimal("None") InvalidOperation.
    if data.get("amount") is None:
        raise BalanceError("getBalance `data` missing `amount`")
    try:
        amount = Decimal(str(data["amount"]))
    except InvalidOperation as e:
        raise BalanceError(f"getBalance `amount` is not a number: {data['amount']!r}") from e

    as_of = data.get("date")
    if not as_of:
        raise BalanceError("getBalance `data` missing `date`")

    # availableBalance is a secondary display field (credit-card "available credit"). A
    # missing or malformed one is non-fatal — drop it rather than lose the whole reading.
    available_raw = data.get("availableBalance")
    try:
        available = None if available_raw is None else Decimal(str(available_raw))
    except InvalidOperation:
        available = None

    return {
        "amount": amount,
        "available_balance": available,
        "currency": data.get("currency") or "AUD",
        "as_of": as_of,
        "account_type": data.get("accountType"),
    }


def check_repayment_landed_but_no_push(
    old_balance: Optional[Decimal], new_balance: Decimal, notify_repo
) -> None:
    """Alarm backstop (WHIT-316): if the mortgage balance dropped like a repayment landed
    but no repayment push fired recently, log the line the CloudWatch alarm watches.

    The direct Up webhook (lambda/up_webhook.py) is the sole repayment notifier now, and
    its silent failure modes (re-linked account, deregistered webhook) leave no error. This
    catches them via the balance, which comes from the bank feed — independent of the Up
    webhook — so the drop is still seen when the webhook is broken. A repayment LOWERS the
    outstanding balance; interest raises it and a redraw raises it, so neither false-fires.
    """
    if old_balance is None:
        return
    drop = old_balance - new_balance
    if drop < REPAYMENT_DROP_THRESHOLD:
        return
    last_fired_at = notify_repo.last_repayment_fired_at()
    cutoff = int(time.time()) - REPAYMENT_MISS_LOOKBACK_DAYS * 24 * 60 * 60
    if last_fired_at is not None and last_fired_at >= cutoff:
        return
    logger.error(
        "UP_WEBHOOK_REPAYMENT_MISSED mortgage balance dropped %s but no repayment push "
        "fired in the last %s days (last_fired_at=%s)",
        drop, REPAYMENT_MISS_LOOKBACK_DAYS, last_fired_at,
    )


def _is_repayment_credit(row: dict) -> bool:
    """True for a stored home-loan repayment leg worth an alert: an incoming transfer
    credit at or above the $10 notify floor (same predicate the webhook fires on). A
    malformed row (missing amount/date) is skipped, never a crash."""
    amount = row.get("amount")
    if row.get("type") != REPAYMENT_INCOMING_TYPE or not row.get("date"):
        return False
    if amount is None or amount <= 0 or amount < MIN_REPAYMENT_NOTIFY:
        return False
    return True


def check_ingested_repayment_without_push(notify_repo, transaction_repo, now: int) -> None:
    """Precise miss-detector (WHIT-317): alarm if a home-loan repayment was ingested in the
    last REPAYMENT_MISS_LOOKBACK_DAYS but no push alerted it.

    Keys on the actual repayment TRANSACTION, not the net balance drop, so it survives the
    edges that defeat check_repayment_landed_but_no_push: interest posting the same day, two
    repayments in one window, a repayment split across polls, a pre-upsert balance-read
    hiccup. Matches by amount in integer cents (the store keeps dollars, the push keeps cents
    — both normalised here), consuming one push per repayment, so two same-amount repayments
    need two pushes or one alarms. Reads only DynamoDB; best-effort, the caller swallows.

    The store window is by UTC date (whole days), so the push cutoff is aligned to MIDNIGHT
    of the oldest day — not `now - 7d` — making the push window at least as broad as the
    store window. Otherwise a repayment pushed earlier on the boundary day would sit inside
    the store window but outside a mid-day push cutoff and spuriously alarm.
    """
    window_start = now - REPAYMENT_MISS_LOOKBACK_DAYS * 24 * 60 * 60
    start_date = time.strftime("%Y-%m-%d", time.gmtime(window_start))
    end_date = time.strftime("%Y-%m-%d", time.gmtime(now))
    cutoff = calendar.timegm(time.strptime(start_date, "%Y-%m-%d"))  # midnight of start_date

    rows, _cursor = transaction_repo.get_transactions_by_date_range(
        HOMELOAN_ACCOUNT_ID, start_date, end_date, MAX_PAGE_SIZE
    )
    repayment_cents = [int(round(row["amount"] * 100)) for row in rows if _is_repayment_credit(row)]
    if not repayment_cents:
        return

    unmatched_pushes = notify_repo.repayment_push_amounts_since(cutoff)
    for cents in repayment_cents:
        if cents in unmatched_pushes:
            unmatched_pushes.remove(cents)  # this repayment did alert — consume its push
            continue
        logger.error(
            "UP_WEBHOOK_REPAYMENT_MISSED source=txn a repayment of %s cents was ingested in "
            "the last %s days with no matching push",
            cents, REPAYMENT_MISS_LOOKBACK_DAYS,
        )


def _poll_homeloan(api_key: str) -> bool:
    """Poll + upsert the mortgage's ABS outstanding-principal balance (WHIT-8, Goal
    screen). Best-effort: any failure is logged and swallowed, leaving the last-good row
    (never zeroes it). Returns whether a fresh reading was stored this run."""
    # WHIT-317: precise repayment-miss detector. Reads only DynamoDB (transaction store +
    # push markers), so it runs BEFORE the balance fetch — a getBalance outage must not blind
    # this backstop. Best-effort, isolated so a check failure can't affect the balance poll.
    try:
        check_ingested_repayment_without_push(
            NotifyRepository(), TransactionRepository(), int(time.time())
        )
    except Exception as e:
        logger.error("precise repayment-miss check failed: %s", e)

    source = HOMELOAN_BALANCE_SOURCE
    try:
        payload = fetch_balance(source["bid"], source["aid"], api_key)
        normalised = normalise_balance(payload)
        repo = HomeLoanBalanceRepository()
        try:
            previous = repo.get_balance(HOMELOAN_ACCOUNT_ID)  # read BEFORE the upsert
            old_balance = previous["balance"] if previous else None
        except Exception as e:
            # Milestone detection is best-effort — a read hiccup must never skip the store.
            logger.warning("pre-upsert balance read failed, skipping milestone check: %s", e)
            old_balance = None
        repo.upsert_balance(
            HOMELOAN_ACCOUNT_ID,
            normalised["balance"],
            normalised["as_of"],
            normalised["currency"],
        )
    except Exception as e:
        logger.error("home-loan balance poll failed, keeping last-good: %s", e)
        return False

    logger.info(
        "home-loan balance stored: %s %s (as of %s)",
        normalised["currency"],
        normalised["balance"],
        normalised["as_of"],
    )

    notify_repo = NotifyRepository()

    # WHIT-301: celebrate crossing a payoff milestone. Best-effort — a push failure must
    # never flip the stored-balance result, so it's isolated in its own try/except.
    try:
        notify_milestone_crossing(
            old_balance,
            normalised["balance"],
            loanfacts_repo=LoanFactsRepository(),
            device_repo=DeviceRepository(),
            notify_repo=notify_repo,
        )
    except Exception as e:
        logger.error("milestone push failed (balance still stored): %s", e)

    # WHIT-316: alarm backstop — a repayment clearly landed (balance dropped) but no push
    # fired. Best-effort, isolated so a check failure can't flip the stored-balance result.
    try:
        check_repayment_landed_but_no_push(old_balance, normalised["balance"], notify_repo)
    except Exception as e:
        logger.error("repayment-miss check failed (balance still stored): %s", e)

    return True


def _poll_account_balances(api_key: str) -> int:
    """Poll + upsert a SIGNED live balance for every account (WHIT-212, Accounts tab).

    Best-effort PER account: one account's failure (transport, `success:false`, missing
    fields) is logged and skipped — it leaves that account's last-good row and never blocks
    the others. Each raw BankSync `aid` is mapped to its internal id so the balance lands
    under the same id the account's transactions carry. Returns how many were stored.
    """
    repo = AccountBalanceRepository()
    stored = 0
    for source in BALANCE_SOURCES:
        aid = source["aid"]
        internal_id = ACCOUNT_ID_MAP.get(aid)
        if internal_id is None:
            # Guarded at import by the BALANCE_SOURCES assert; stay defensive anyway.
            logger.error("balance source aid %s has no internal-id mapping, skipping", aid)
            continue
        try:
            payload = fetch_balance(source["bid"], aid, api_key)
            n = normalise_account_balance(payload)
            repo.upsert_balance(
                internal_id,
                n["amount"],
                n["available_balance"],
                n["currency"],
                n["as_of"],
                n["account_type"],
            )
        except Exception as e:
            logger.error("account balance poll failed for %s, keeping last-good: %s", internal_id, e)
            continue
        stored += 1
        logger.info(
            "account balance stored: %s %s %s (as of %s)",
            internal_id, n["currency"], n["amount"], n["as_of"],
        )
    return stored


def lambda_handler(event, context):
    """Poll the live balances and upsert them.

    Two independent, best-effort concerns share one daily poll:
      - the mortgage's ABS outstanding principal (the Goal screen's `/homeloan` row), and
      - a SIGNED balance per account (the Accounts tab's `/accounts/balances` rows).
    Each is isolated — a failure (transport, non-200, `success:false`, missing/malformed
    fields) is logged and swallowed, leaves the last-good row untouched (a bad tick can't
    zero it), and never blocks the other. A genuine 0 reading is a success and IS written.
    The API key is fetched once and shared by both — and that fetch is itself
    best-effort: an SSM failure (throttle, missing param, IAM) is logged and swallowed so
    the invocation never errors out and every last-good row survives, rather than a
    credential blip taking down the whole poll.
    """
    try:
        api_key = get_api_key()
    except Exception as e:
        logger.error("balance poll skipped, could not fetch the BankSync API key: %s", e)
        return {"homeloan_stored": False, "accounts_stored": 0}
    homeloan_stored = _poll_homeloan(api_key)
    accounts_stored = _poll_account_balances(api_key)
    return {"homeloan_stored": homeloan_stored, "accounts_stored": accounts_stored}
