"""WHIT-369 GAP — the poller wiring under the NEW notify_milestone_crossing signature.

test_handler_milestone_repo_wiring_gaps.py locks that _poll_homeloan threads a real
MilestoneRepository. WHIT-369 added a `scope` seam that defaults to None (the single shared
tenant). This pins that the poller stays single-tenant: it must NOT pin a scope, so BOTH the
plan read and the fired-state route to the same shared owner via the None default. If multi-
user later lands, this test is the one that flips to a per-user loop — a deliberate change.
"""

from decimal import Decimal

import pytest


class _FakeRepo:
    def __init__(self, prior=None):
        self.calls = []
        self.prior = prior

    def get_balance(self, account_id):
        return self.prior

    def upsert_balance(self, account_id, balance, as_of, currency):
        self.calls.append((account_id, balance, as_of, currency))


_OK_PAYLOAD = {
    "success": True,
    "data": {
        "date": "2026-07-04T00:24:37.614Z", "accountName": "Home loan",
        "accountType": "mortgage", "accountId": "T6d8ppsYssBDFCwl1qEb0w",
        "bankId": "fiskil_3", "amount": -596642.43, "currency": "AUD",
    },
}


def test_poll_leaves_scope_at_the_single_tenant_default(handler, monkeypatch):
    # WHIT-369 — the poller is single-tenant today: it must not pass a scope, so notify defaults
    # to None → the shared owner for BOTH the plan read and the fired-state. A future edit that
    # pins the WRONG scope (or splits plan-owner from fired-owner) trips here.
    fake = _FakeRepo(prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: fake)
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: _OK_PAYLOAD)

    seen = {}
    monkeypatch.setattr(handler, "notify_milestone_crossing",
                        lambda old, new, **kw: seen.update(kw) or 1)

    assert handler._poll_homeloan("key") is True
    assert seen.get("scope") is None                 # not pinned → shared default
    assert "milestone_repo" in seen                  # still threads the saved-plan repo
