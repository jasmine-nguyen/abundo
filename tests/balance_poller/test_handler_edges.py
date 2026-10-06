"""Adversarial GAP tests for the balance poller (lambda_balance_poller/handler.py).

The implementer's test_handler.py locks the signed amount, the missing-field guards, the
request shape, and the http-error / failure-payload isolation. These add the edges it doesn't:

    normalise_account_balance :
        - amount == 0 (a paid-off loan) is a VALID reading, stored as 0
        - amount given as a STRING (JSON-number-as-text) parses via Decimal(str())
        - empty-string currency ("" is falsy) falls back to AUD
        - empty-string date / a garbage amount raise BalanceError
    lambda_handler (the breadth of the per-account `except Exception`) :
        - a repository upsert that RAISES is swallowed (home loan not stored, no re-raise)
        - a garbage non-numeric amount is swallowed the same way -> no upsert

No network / no AWS: urlopen is monkeypatched and the repository is a fake.
"""

import sys
from decimal import Decimal

import pytest

from _http_fakes import FakeResponse


class _FakeAccountRepo:
    """Recording AccountBalanceRepository stand-in with no prior rows."""

    def __init__(self, raise_on_upsert=False):
        self.calls = []
        self._raise = raise_on_upsert

    def list_balances(self, account_ids):
        return []

    def upsert_balance(self, account_id, amount, *rest):
        self.calls.append((account_id, amount))
        if self._raise:
            raise RuntimeError("dynamo down")


def _mortgage(amount, **over):
    data = {"amount": amount, "date": "2026-07-04T00:00:00Z", "accountType": "mortgage"}
    data.update(over)
    return {"success": True, "data": data}


# --- normalise_account_balance edges -----------------------------------------


@pytest.mark.parametrize(
    ("payload", "field", "expected"),
    [
        (_mortgage(0), "amount", Decimal("0")),
        (_mortgage("-596642.43"), "amount", Decimal("-596642.43")),
        (_mortgage(-400000, currency=""), "currency", "AUD"),
    ],
    ids=["zero-is-a-paid-off-balance", "string-amount-parses", "empty-currency-defaults-to-aud"],
)
def test_normalise_accepts_edge_readings(handler, payload, field, expected):
    assert handler.normalise_account_balance(payload)[field] == expected


@pytest.mark.parametrize(
    "payload",
    [_mortgage(-400000, date=""), _mortgage("not-a-number")],
    ids=["empty-date", "garbage-amount"],
)
def test_normalise_rejects_bad_readings_with_balance_error(handler, payload):
    with pytest.raises(sys.modules["balance_fetch"].BalanceError):
        handler.normalise_account_balance(payload)


# --- lambda_handler: the breadth of `except Exception` -----------------------


def _run(handler, monkeypatch, repo, payload):
    monkeypatch.setattr(handler, "get_api_key", lambda: "k")
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    monkeypatch.setattr(handler, "_check_homeloan", lambda deltas: None)
    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda req, timeout=None: FakeResponse(payload))
    return handler.lambda_handler({}, None)


def test_lambda_handler_stores_a_zero_balance_on_a_paid_off_loan(handler, monkeypatch):
    # Contrast with the "never writes a zero" failure comment: a REAL 0 reading is
    # written; only failure paths avoid zeroing.
    repo = _FakeAccountRepo()
    assert _run(handler, monkeypatch, repo, _mortgage(0))["homeloan_stored"] is True
    assert dict(repo.calls)["up-homeloan"] == Decimal("0")


def test_lambda_handler_swallows_a_repository_upsert_failure(handler, monkeypatch):
    # The DynamoDB write itself failing must not raise out of the poller.
    repo = _FakeAccountRepo(raise_on_upsert=True)
    result = _run(handler, monkeypatch, repo, _mortgage(-400000))
    assert result == {"homeloan_stored": False, "accounts_stored": 0}
    assert ("up-homeloan", Decimal("-400000")) in repo.calls  # attempted, then swallowed


def test_lambda_handler_swallows_a_garbage_amount_without_writing(handler, monkeypatch):
    # A malformed amount (a BalanceError) is isolated by the failure handling —
    # no upsert, no raise, last-good row untouched.
    repo = _FakeAccountRepo()
    assert _run(handler, monkeypatch, repo, _mortgage("not-a-number"))["homeloan_stored"] is False
    assert repo.calls == []
