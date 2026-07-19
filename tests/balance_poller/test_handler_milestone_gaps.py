"""Adversarial GAP test for the poller's milestone hook (lambda_balance_poller/handler.py).

test_handler.py already proves the detector receives (old, new) after a store, gets
None on the first poll, and that a detector exception is swallowed with the balance
still stored. The gap: the detector must run ONLY after a SUCCESSFUL upsert — when the
upsert itself raises, the balance write failed, so no crossing may be celebrated.
"""

from decimal import Decimal

import pytest


class _FakeRepoRaisesOnUpsert:
    """HomeLoanBalanceRepository stand-in whose upsert blows up (DynamoDB down)."""

    def __init__(self, prior):
        self.prior = prior
        self.calls = []

    def get_balance(self, account_id):
        return self.prior

    def upsert_balance(self, *a):
        self.calls.append(a)
        raise RuntimeError("dynamo down")


# WHIT-301 — [A25] fail-on-revert: detector is NOT called when the upsert raises (no store -> no push).

def test_milestone_detector_not_called_when_upsert_fails(handler, monkeypatch):
    repo = _FakeRepoRaisesOnUpsert(prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: repo)
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: {
        "success": True,
        "data": {"amount": -544000, "date": "2026-07-04T00:00:00Z", "accountType": "mortgage"},
    })
    called = []
    monkeypatch.setattr(handler, "notify_milestone_crossing", lambda *a, **k: called.append((a, k)))

    assert handler._poll_homeloan("key") is False   # store failed -> best-effort False
    assert repo.calls, "upsert was attempted"
    assert called == [], "the crossing detector must not run when the balance was never stored"
