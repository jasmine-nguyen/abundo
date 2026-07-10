"""Unit tests for the home-loan balance poller (lambda_balance_poller/handler.py).

Covers:
    - normalise_balance : sign handling (mortgage amount is negative -> abs),
                          field tolerance, and the failure guards (BalanceError)
    - fetch_balance     : the GET request shape (url, method, headers)
    - lambda_handler    : stores on success; on ANY failure logs, returns
                          {"stored": False}, does NOT raise, does NOT upsert

No network and no AWS: ``urllib.request.urlopen`` is monkeypatched, ``ssm`` is
faked by conftest, and the repository is replaced with a recording fake.
"""

import io
import json
import urllib.error
from decimal import Decimal

import pytest


# --- helpers -----------------------------------------------------------------


class _FakeResponse:
    """Stand-in for urlopen()'s return (used as a context manager; .read() -> bytes)."""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


# The real getBalance payload observed for the mortgage account (2026-07-04).
_OK_PAYLOAD = {
    "success": True,
    "data": {
        "date": "2026-07-04T00:24:37.614Z",
        "bank": "Up",
        "accountName": "🏠 Home loan",
        "accountType": "mortgage",
        "accountId": "T6d8ppsYssBDFCwl1qEb0w",
        "bankId": "fiskil_3",
        "amount": -596642.43,
        "availableBalance": 0,
        "pendingBalance": 0,
        "currency": "AUD",
    },
}


class _FakeRepo:
    """Recording stand-in for HomeLoanBalanceRepository."""

    def __init__(self):
        self.calls = []

    def upsert_balance(self, account_id, balance, as_of, currency):
        self.calls.append((account_id, balance, as_of, currency))


class _FakeAccountRepo:
    """Recording stand-in for AccountBalanceRepository (signed per-account balances)."""

    def __init__(self):
        self.calls = []

    def upsert_balance(self, account_id, amount, available_balance, currency, as_of, account_type):
        self.calls.append((account_id, amount, available_balance, currency, as_of, account_type))


# Real getBalance payloads observed per account (2026-07-08).
_SPENDING_PAYLOAD = {
    "success": True,
    "data": {
        "date": "2026-07-08T09:32:02.405Z", "accountName": "Spending",
        "accountType": "checking", "accountId": "3zVQJ8Btz_IRmqp78VrQnQ",
        "amount": 96270.59, "availableBalance": 96270.59, "currency": "AUD",
    },
}
_ANZ_PAYLOAD = {
    "success": True,
    "data": {
        "date": "2026-07-08T09:32:37.337Z", "accountName": "ANZ Rewards Black Visa",
        "accountType": "unknown", "accountId": "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0",
        "amount": -6492.26, "availableBalance": 8171.88, "currency": "AUD",
    },
}


def _http_error(code):
    return urllib.error.HTTPError(
        url="https://api.banksync.io/x", code=code, msg="boom", hdrs=None, fp=io.BytesIO(b"")
    )


# --- normalise_balance -------------------------------------------------------


def test_normalise_balance_takes_absolute_value_of_negative_amount(handler):
    out = handler.normalise_balance(_OK_PAYLOAD)
    # The mortgage amount is -596642.43; the stored outstanding balance is positive.
    assert out == {
        "balance": Decimal("596642.43"),
        "as_of": "2026-07-04T00:24:37.614Z",
        "currency": "AUD",
    }


def test_normalise_balance_tolerates_missing_optional_fields(handler):
    # No availableBalance/pendingBalance, no accountType — still fine.
    payload = {"success": True, "data": {"amount": -400000, "date": "2026-07-04T00:00:00Z"}}
    out = handler.normalise_balance(payload)
    assert out["balance"] == Decimal("400000")
    assert out["currency"] == "AUD"  # defaulted when absent


def test_normalise_balance_raises_on_failure_response(handler):
    payload = {"success": False, "error": "Provider fiskil:au does not support loans"}
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance(payload)


def test_normalise_balance_raises_on_missing_data(handler):
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance({"success": True})


def test_normalise_balance_raises_on_missing_amount(handler):
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance({"success": True, "data": {"date": "2026-07-04T00:00:00Z"}})


def test_normalise_balance_raises_on_missing_date(handler):
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance({"success": True, "data": {"amount": -1}})


def test_normalise_balance_raises_on_non_mortgage_account(handler):
    payload = {"success": True, "data": {"amount": -1, "date": "d", "accountType": "transaction"}}
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance(payload)


# --- fetch_balance -----------------------------------------------------------


def test_fetch_balance_builds_correct_get_request(handler, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["req"] = req
        captured["timeout"] = timeout
        return _FakeResponse(_OK_PAYLOAD)

    monkeypatch.setattr(handler.urllib.request, "urlopen", fake_urlopen)

    out = handler.fetch_balance("fiskil_3", "T6d8ppsYssBDFCwl1qEb0w", "the-key")

    req = captured["req"]
    assert req.method == "GET"
    assert req.full_url == "https://api.banksync.io/v1/banks/fiskil_3/accounts/T6d8ppsYssBDFCwl1qEb0w/balances"
    # urllib title-cases header keys, so "X-API-Key" is stored as "X-api-key".
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "whittle-homeloan-request"
    assert captured["timeout"] == handler.HOMELOAN_BALANCE_TIMEOUT_SECONDS
    assert out == _OK_PAYLOAD


# --- normalise_account_balance (WHIT-212) ------------------------------------


def test_normalise_account_balance_keeps_amount_signed_with_extras(handler):
    # The signed path keeps the NEGATIVE mortgage amount (no abs) and captures the extras.
    out = handler.normalise_account_balance(_OK_PAYLOAD)
    assert out == {
        "amount": Decimal("-596642.43"),
        "available_balance": Decimal("0"),
        "currency": "AUD",
        "as_of": "2026-07-04T00:24:37.614Z",
        "account_type": "mortgage",
    }


def test_normalise_account_balance_has_no_mortgage_guard(handler):
    # Unlike normalise_balance, a non-mortgage account normalises fine (positive spending).
    out = handler.normalise_account_balance(_SPENDING_PAYLOAD)
    assert out["amount"] == Decimal("96270.59")
    assert out["account_type"] == "checking"
    assert out["available_balance"] == Decimal("96270.59")


def test_normalise_account_balance_tolerates_missing_optionals(handler):
    payload = {"success": True, "data": {"amount": -6492.26, "date": "2026-07-08T00:00:00Z"}}
    out = handler.normalise_account_balance(payload)
    assert out["amount"] == Decimal("-6492.26")
    assert out["available_balance"] is None  # absent -> dropped, not fatal
    assert out["account_type"] is None
    assert out["currency"] == "AUD"  # defaulted


def test_normalise_account_balance_raises_on_failure_and_missing_fields(handler):
    for bad in (
        {"success": False, "error": "nope"},
        {"success": True},
        {"success": True, "data": {"date": "d"}},          # missing amount
        {"success": True, "data": {"amount": -1}},          # missing date
    ):
        with pytest.raises(handler.BalanceError):
            handler.normalise_account_balance(bad)


# --- lambda_handler ----------------------------------------------------------


def test_lambda_handler_stores_homeloan_and_every_account_on_success(handler, monkeypatch):
    homeloan = _FakeRepo()
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: homeloan)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    # Return a per-account payload keyed by the aid in the request URL.
    payloads = {
        "3zVQJ8Btz_IRmqp78VrQnQ": _SPENDING_PAYLOAD,
        "T6d8ppsYssBDFCwl1qEb0w": _OK_PAYLOAD,
        "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": _ANZ_PAYLOAD,
    }
    monkeypatch.setattr(handler.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(next(p for aid, p in payloads.items() if aid in req.full_url)))

    result = handler.lambda_handler({}, None)

    assert result == {"homeloan_stored": True, "accounts_stored": 3}
    # The abs home-loan row (Goal screen) is still written exactly as before.
    assert homeloan.calls == [("up-homeloan", Decimal("596642.43"), "2026-07-04T00:24:37.614Z", "AUD")]
    # A signed row per account, each under its internal id.
    stored = {c[0]: c[1] for c in accounts.calls}
    assert stored == {
        "up-spending": Decimal("96270.59"),
        "up-homeloan": Decimal("-596642.43"),
        "anz-rewards-black-visa": Decimal("-6492.26"),
    }


def test_lambda_handler_swallows_http_error_and_keeps_last_good(handler, monkeypatch):
    homeloan = _FakeRepo()
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: homeloan)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    def boom(req, timeout=None):
        raise _http_error(500)

    monkeypatch.setattr(handler.urllib.request, "urlopen", boom)

    # Never raises, never writes — every reader keeps serving its last-good row.
    result = handler.lambda_handler({}, None)
    assert result == {"homeloan_stored": False, "accounts_stored": 0}
    assert homeloan.calls == []
    assert accounts.calls == []


def test_lambda_handler_swallows_failure_payload_without_writing(handler, monkeypatch):
    homeloan = _FakeRepo()
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: homeloan)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    fail = {"success": False, "error": "Provider fiskil:au does not support loans"}
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: _FakeResponse(fail))

    result = handler.lambda_handler({}, None)
    assert result == {"homeloan_stored": False, "accounts_stored": 0}
    assert homeloan.calls == []
    assert accounts.calls == []


def test_lambda_handler_swallows_an_api_key_fetch_failure(handler, monkeypatch):
    # An SSM/get_param failure (throttle, missing param, IAM) must not error the
    # invocation — it's best-effort like the polls, so nothing is stored, nothing is
    # zeroed, and every last-good row survives.
    homeloan = _FakeRepo()
    accounts = _FakeAccountRepo()

    def boom(path):
        raise RuntimeError("SSM throttled")

    monkeypatch.setattr(handler, "get_param", boom)
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: homeloan)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    result = handler.lambda_handler({}, None)
    assert result == {"homeloan_stored": False, "accounts_stored": 0}
    assert homeloan.calls == []
    assert accounts.calls == []


def test_poll_account_balances_isolates_a_single_account_failure(handler, monkeypatch):
    # One account's poll blows up; the others must still store (best-effort per account).
    accounts = _FakeAccountRepo()
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)

    def fetch(bid, aid, api_key):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":
            raise RuntimeError("mortgage balance timed out")
        return _SPENDING_PAYLOAD if aid == "3zVQJ8Btz_IRmqp78VrQnQ" else _ANZ_PAYLOAD

    monkeypatch.setattr(handler, "fetch_balance", fetch)

    stored = handler._poll_account_balances("the-key")

    assert stored == 2  # spending + anz stored; the mortgage poll was skipped
    ids = {c[0] for c in accounts.calls}
    assert ids == {"up-spending", "anz-rewards-black-visa"}
