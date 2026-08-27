"""BankSync getBalance fetch + normalise, shared by the daily poller and the
on-demand refresh endpoint (WHIT — live balance refresh).

Kept as a flat top-level module (not a package dir) so the non-recursive
``cp shared/*.py`` layer staging picks it up. It imports NO constants: callers
pass ``base_url``/``timeout``/``user_agent`` in, so this module never needs a
matching entry in ``lambda_api/constants.py`` (the runtime constants shadow).
"""

import json
import urllib.request
from decimal import Decimal, InvalidOperation


class BalanceError(Exception):
    """A getBalance response we can't turn into a stored balance (BankSync reported
    failure, or the payload was missing a required field). Raised by the normalisers
    so a caller keeps this account's last-good row instead of storing garbage."""


def fetch_balance(bid: str, aid: str, api_key: str, *, base_url: str, timeout: float, user_agent: str) -> dict:
    """GET /v1/banks/{bid}/accounts/{aid}/balances -> the parsed JSON payload."""
    url = f"{base_url}/v1/banks/{bid}/accounts/{aid}/balances"
    req = urllib.request.Request(
        url,
        headers={
            "X-API-Key": api_key,
            # BankSync sits behind Cloudflare, which blocks the default
            # "Python-urllib" User-Agent with a 403 (error 1010). Send our own.
            "User-Agent": user_agent,
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def normalise_account_balance(payload: dict) -> dict:
    """Turn a getBalance payload into a SIGNED per-account balance row (WHIT-212).

    Keeps BankSync's ``amount`` SIGNED as-is — spending positive, a loan or credit-card
    balance negative — and also captures ``availableBalance``, ``currency`` and
    ``accountType`` for the Accounts tab. Only ``amount``/``date`` are required; a failure
    response or a missing required field raises BalanceError so the caller keeps this
    account's last-good row. There is NO account-type guard here: this path stores every
    account, not just the mortgage.
    """
    # BankSync is external: a non-object payload (a JSON array/string/number from an error
    # page or proxy) must raise BalanceError like any other bad reading, so the caller keeps
    # this account's last-good row instead of crashing on `.get` and taking the others down.
    if not isinstance(payload, dict):
        raise BalanceError(f"getBalance payload was not an object: {type(payload).__name__}")
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
