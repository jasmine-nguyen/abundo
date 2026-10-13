"""Tests for the shared BankSync balance fetch/normalise (shared/balance_fetch.py).

Shared by the poller and the on-demand refresh API. `fetch_balance` takes the timeout and
UA as parameters, so each caller sets its own; the base URL is the shared BankSync one.
"""

from decimal import Decimal

import pytest

from _http_fakes import FakeResponse


_OK_PAYLOAD = {
    "success": True,
    "data": {
        "amount": -596642.43, "availableBalance": 0, "currency": "AUD",
        "date": "2026-07-04T00:24:37.614Z", "accountType": "mortgage",
    },
}

# The live Westpac credit-card getBalance response: extra fields no other account sends, and a
# NEGATIVE amount beside a POSITIVE availableBalance (WHIT-490).
_WESTPAC_DATA = {
    "date": "2026-09-05T03:58:13.856Z",
    "retrievedAt": "2026-09-05T03:58:13.856Z",
    "balanceAsOf": None,
    "bank": "Westpac",
    "account": "0908 (unknown)",
    "accountName": "Altitude Qantas Black Card",
    "accountNumber": "0908",
    "accountType": "unknown",
    "accountId": "CC6EE20D-4931-4B10-86CA-EADD45A062DC",
    "bankId": "fiskil_77",
    "amount": -230,
    "availableBalance": 5770,
    "pendingBalance": 0,
    "creditLimit": 6000,
    "currency": "AUD",
}
_WESTPAC_PAYLOAD = {"success": True, "data": _WESTPAC_DATA}


# --- fetch_balance (parameterized) -------------------------------------------


def test_fetch_balance_builds_request_from_params(shared, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["req"] = req
        captured["timeout"] = timeout
        return FakeResponse(_OK_PAYLOAD)

    monkeypatch.setattr(shared.balance_fetch.urllib.request, "urlopen", fake_urlopen)

    out = shared.balance_fetch.fetch_balance(
        "fiskil_9", "acct-1", "the-key",
        timeout=7, user_agent="abundo-app-api",
    )

    req = captured["req"]
    assert req.get_method() == "GET"
    # Timeout and UA come from the params — not hardcoded.
    assert req.full_url == "https://api.banksync.io/v1/banks/fiskil_9/accounts/acct-1/balances"
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "abundo-app-api"
    assert captured["timeout"] == 7
    assert out == _OK_PAYLOAD


# --- normalise_account_balance -----------------------------------------------


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
        {"success": True, "data": {"amount": -1, "date": ""}},   # empty date
        {"success": True, "data": {"amount": "not-a-number", "date": "d"}},
    ):
        with pytest.raises(shared.balance_fetch.BalanceError):
            shared.balance_fetch.normalise_account_balance(bad)


def test_real_westpac_payload_normalises_to_exactly_the_five_stored_fields(shared):
    # The whole row, asserted as an EXACT dict: the negative amount stays negative,
    # the positive availableBalance stays positive next to it (they are not swapped or
    # sign-linked), and every extra field the card sends is dropped rather than written
    # into the balances table under a name the app never reads.
    out = shared.balance_fetch.normalise_account_balance(_WESTPAC_PAYLOAD)

    assert out == {
        "amount": Decimal("-230"),
        "available_balance": Decimal("5770"),
        "currency": "AUD",
        "as_of": "2026-09-05T03:58:13.856Z",
        "account_type": "unknown",
    }


def test_a_card_paid_off_to_zero_keeps_a_signed_zero_amount(shared):
    # The other boundary: a fully paid card reports amount 0. It must normalise to
    # Decimal("0") and NOT raise — the `is None` guard exists precisely so a falsy-but-
    # present amount survives. A truthiness guard would raise BalanceError and the card
    # would keep showing yesterday's debt forever.
    zeroed = {"success": True, "data": {**_WESTPAC_DATA, "amount": 0}}

    out = shared.balance_fetch.normalise_account_balance(zeroed)

    assert out["amount"] == Decimal("0")
