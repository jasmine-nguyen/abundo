"""Tests for the shared BankSync balance fetch/normalise (shared/balance_fetch.py).

Extracted from the poller so the on-demand refresh API can reuse it. Unlike the poller's
thin wrapper (which hardcodes its base URL / 30s timeout / UA), the shared `fetch_balance`
takes them as parameters — so the request it builds is driven entirely by the caller.
"""

from decimal import Decimal

import pytest


_OK_PAYLOAD = {
    "success": True,
    "data": {
        "amount": -596642.43, "availableBalance": 0, "currency": "AUD",
        "date": "2026-07-04T00:24:37.614Z", "accountType": "mortgage",
    },
}


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def read(self):
        import json
        return json.dumps(self._payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


# --- fetch_balance (parameterized) -------------------------------------------


def test_fetch_balance_builds_request_from_params(shared, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["req"] = req
        captured["timeout"] = timeout
        return _FakeResponse(_OK_PAYLOAD)

    monkeypatch.setattr(shared.balance_fetch.urllib.request, "urlopen", fake_urlopen)

    out = shared.balance_fetch.fetch_balance(
        "fiskil_9", "acct-1", "the-key",
        base_url="https://example.test", timeout=7, user_agent="abundo-app-api",
    )

    req = captured["req"]
    assert req.method == "GET"
    # URL, timeout, and UA all come from the params — not hardcoded.
    assert req.full_url == "https://example.test/v1/banks/fiskil_9/accounts/acct-1/balances"
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "abundo-app-api"
    assert captured["timeout"] == 7
    assert out == _OK_PAYLOAD


# --- normalise_account_balance -----------------------------------------------


def test_normalise_keeps_amount_signed_with_extras(shared):
    out = shared.balance_fetch.normalise_account_balance(_OK_PAYLOAD)
    assert out == {
        "amount": Decimal("-596642.43"),
        "available_balance": Decimal("0"),
        "currency": "AUD",
        "as_of": "2026-07-04T00:24:37.614Z",
        "account_type": "mortgage",
    }


def test_normalise_tolerates_missing_optionals(shared):
    payload = {"success": True, "data": {"amount": 96270.59, "date": "2026-07-08T00:00:00Z"}}
    out = shared.balance_fetch.normalise_account_balance(payload)
    assert out["amount"] == Decimal("96270.59")
    assert out["available_balance"] is None
    assert out["account_type"] is None
    assert out["currency"] == "AUD"  # defaulted


def test_normalise_drops_a_malformed_available_balance(shared):
    # A non-numeric availableBalance is non-fatal — drop it, keep the (required) amount.
    payload = {"success": True, "data": {"amount": -6492.26, "date": "d", "availableBalance": "n/a"}}
    out = shared.balance_fetch.normalise_account_balance(payload)
    assert out["amount"] == Decimal("-6492.26")
    assert out["available_balance"] is None


def test_normalise_raises_balance_error_on_failure_and_missing_fields(shared):
    for bad in (
        [],                                          # non-object payload (array)
        "oops",                                      # non-object payload (string)
        {"success": False, "error": "nope"},
        {"success": True},
        {"success": True, "data": {"date": "d"}},   # missing amount
        {"success": True, "data": {"amount": -1}},   # missing date
        {"success": True, "data": {"amount": "not-a-number", "date": "d"}},
    ):
        with pytest.raises(shared.balance_fetch.BalanceError):
            shared.balance_fetch.normalise_account_balance(bad)
