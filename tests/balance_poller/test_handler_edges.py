"""Adversarial GAP tests for the balance poller (lambda_balance_poller/handler.py).

The implementer's test_handler.py locks the negative-amount abs, the missing-field
guards, the request shape, and the http-error / failure-payload isolation. These
add the edges it doesn't:

    normalise_balance :
        - POSITIVE amount (what if BankSync ever flips the mortgage sign) -> abs
          keeps it positive (documents a potential silent wrong-sign assumption)
        - amount == 0 (a paid-off loan) is a VALID reading, stored as 0
        - amount given as a STRING (JSON-number-as-text) parses via Decimal(str())
        - empty-string currency ("" is falsy) falls back to AUD
        - empty-string date raises BalanceError (falsy `as_of` guard)
    lambda_handler (the breadth of `except Exception`) :
        - a repository upsert that RAISES is swallowed (stored:False, no re-raise)
        - a garbage non-numeric amount (BalanceError) is still swallowed by the
          same broad guard -> stored:False, no upsert

No network / no AWS: urlopen is monkeypatched and the repository is a fake.
"""

import json
from decimal import Decimal

import pytest


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


class _FakeRepo:
    def __init__(self, raise_on_upsert=False):
        self.calls = []
        self._raise = raise_on_upsert

    def upsert_balance(self, account_id, balance, as_of, currency):
        self.calls.append((account_id, balance, as_of, currency))
        if self._raise:
            raise RuntimeError("dynamo down")


class _FakeAccountRepo:
    """No-op AccountBalanceRepository stand-in — these tests isolate the home-loan
    path, so the account poll is stubbed out to keep the handler's return deterministic."""

    def upsert_balance(self, *a, **k):
        pass


def _mortgage(amount, **over):
    data = {"amount": amount, "date": "2026-07-04T00:00:00Z", "accountType": "mortgage"}
    data.update(over)
    return {"success": True, "data": data}


# --- normalise_balance sign / type edges -------------------------------------


def test_normalise_positive_amount_stays_positive(handler):
    # If BankSync ever returned the mortgage as a positive number, abs() is a no-op
    # and we store it positive — the wrong-sign case is silently indistinguishable.
    out = handler.normalise_balance(_mortgage(596642.43))
    assert out["balance"] == Decimal("596642.43")


def test_normalise_zero_amount_is_a_valid_paid_off_balance(handler):
    out = handler.normalise_balance(_mortgage(0))
    assert out["balance"] == Decimal("0")


def test_normalise_amount_as_string_parses(handler):
    out = handler.normalise_balance(_mortgage("-596642.43"))
    assert out["balance"] == Decimal("596642.43")


def test_normalise_empty_currency_defaults_to_aud(handler):
    out = handler.normalise_balance(_mortgage(-400000, currency=""))
    assert out["currency"] == "AUD"


def test_normalise_empty_date_raises(handler):
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance(_mortgage(-400000, date=""))


def test_normalise_garbage_amount_raises_balance_error(handler):
    # A non-numeric amount is bad input like any other guard — normalise_balance
    # surfaces it as its own BalanceError (not a raw decimal.InvalidOperation).
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance(_mortgage("not-a-number"))


# --- lambda_handler: the breadth of `except Exception` -----------------------


def test_lambda_handler_stores_a_zero_balance_on_a_paid_off_loan(handler, monkeypatch):
    # Contrast with the "never writes a zero" failure comment: a REAL 0 reading is
    # written; only failure paths avoid zeroing.
    repo = _FakeRepo()
    monkeypatch.setattr(handler, "get_param", lambda path: "k")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: _FakeAccountRepo())
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: _FakeResponse(_mortgage(0)))

    assert handler.lambda_handler({}, None)["homeloan_stored"] is True
    assert repo.calls[0][1] == Decimal("0")


def test_lambda_handler_swallows_a_repository_upsert_failure(handler, monkeypatch):
    # The DynamoDB write itself failing must not raise out of the poller.
    repo = _FakeRepo(raise_on_upsert=True)
    monkeypatch.setattr(handler, "get_param", lambda path: "k")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: _FakeAccountRepo())
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: _FakeResponse(_mortgage(-400000)))

    assert handler.lambda_handler({}, None)["homeloan_stored"] is False
    assert len(repo.calls) == 1  # attempted once, then swallowed


def test_lambda_handler_swallows_a_garbage_amount_without_writing(handler, monkeypatch):
    # A malformed amount (now a BalanceError) is isolated by the failure handling —
    # no upsert, no raise, last-good row untouched.
    repo = _FakeRepo()
    monkeypatch.setattr(handler, "get_param", lambda path: "k")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: _FakeAccountRepo())
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: _FakeResponse(_mortgage("not-a-number")))

    assert handler.lambda_handler({}, None)["homeloan_stored"] is False
    assert repo.calls == []
