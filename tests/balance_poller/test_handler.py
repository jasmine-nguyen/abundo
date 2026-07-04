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
    assert req.get_header("User-agent") == "whittle-balance-poller"
    assert captured["timeout"] == handler.HOMELOAN_BALANCE_TIMEOUT_SECONDS
    assert out == _OK_PAYLOAD


# --- lambda_handler ----------------------------------------------------------


def test_lambda_handler_stores_the_balance_on_success(handler, monkeypatch):
    repo = _FakeRepo()
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: repo)
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: _FakeResponse(_OK_PAYLOAD))

    result = handler.lambda_handler({}, None)

    assert result == {"stored": True}
    assert repo.calls == [("up-homeloan", Decimal("596642.43"), "2026-07-04T00:24:37.614Z", "AUD")]


def test_lambda_handler_swallows_http_error_and_keeps_last_good(handler, monkeypatch):
    repo = _FakeRepo()
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: repo)

    def boom(req, timeout=None):
        raise _http_error(500)

    monkeypatch.setattr(handler.urllib.request, "urlopen", boom)

    # Never raises, never writes — the read API keeps serving the last-good row.
    result = handler.lambda_handler({}, None)
    assert result == {"stored": False}
    assert repo.calls == []


def test_lambda_handler_swallows_failure_payload_without_writing(handler, monkeypatch):
    repo = _FakeRepo()
    monkeypatch.setattr(handler, "get_param", lambda path: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: repo)
    fail = {"success": False, "error": "Provider fiskil:au does not support loans"}
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: _FakeResponse(fail))

    result = handler.lambda_handler({}, None)
    assert result == {"stored": False}
    assert repo.calls == []
