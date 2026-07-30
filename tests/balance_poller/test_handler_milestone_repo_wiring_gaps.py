"""WHIT-384 GAP — the poller must thread a MilestoneRepository through to the detector.

test_handler.py locks that _poll_homeloan passes (old, new) to notify_milestone_crossing
after a successful upsert. The WHIT-384 gap: it must ALSO pass milestone_repo=MilestoneRepository()
so the detector measures against the user's SAVED plan. Without this kwarg the custom-plan
feature is silently dead (the detector defaults milestone_repo=None -> built-in plan). This
pins that exact wiring at lambda_balance_poller/handler.py:306.
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


def test_poll_threads_a_milestone_repository_into_the_detector(handler, monkeypatch):
    fake = _FakeRepo(prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: fake)
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: _OK_PAYLOAD)

    sentinel = object()
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: sentinel)

    seen = {}
    monkeypatch.setattr(handler, "notify_milestone_crossing",
                        lambda old, new, **kw: seen.update(kw) or 1)

    assert handler._poll_homeloan("key") is True
    # the poller constructed a MilestoneRepository and passed it as the milestone_repo kwarg —
    # so the detector reads the saved plan, not just the built-in default.
    assert seen.get("milestone_repo") is sentinel


def test_poll_milestone_repo_is_a_real_MilestoneRepository_instance(handler, monkeypatch):
    # Guard against the kwarg being wired to the wrong constructor: confirm the object threaded
    # through is an instance of the poller's imported MilestoneRepository class.
    fake = _FakeRepo(prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: fake)
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: _OK_PAYLOAD)

    seen = {}
    monkeypatch.setattr(handler, "notify_milestone_crossing",
                        lambda old, new, **kw: seen.update(kw) or 1)

    assert handler._poll_homeloan("key") is True
    assert isinstance(seen.get("milestone_repo"), handler.MilestoneRepository)
