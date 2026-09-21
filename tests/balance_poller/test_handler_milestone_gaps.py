"""Adversarial GAP tests for the poller's milestone hook (lambda_balance_poller/handler.py).

test_handler.py already proves the detector receives (old, new) after a store, gets None on
the first poll, and that a detector exception is swallowed with the balance still stored. These
gaps pin the wiring around that hook:

  * [WHIT-301] the detector runs ONLY after a SUCCESSFUL upsert — a raising upsert means the
    balance write failed, so no crossing may be celebrated;
  * [WHIT-384] the poller threads a real MilestoneRepository through as milestone_repo, so the
    detector measures against the user's SAVED plan (not the built-in default);
  * [WHIT-369] the poller stays single-tenant — it pins no scope, so both the plan read and the
    fired-state route to the shared owner via the None default.
"""

from decimal import Decimal


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


# WHIT-384 — the poller threads a real MilestoneRepository into the detector (custom-plan wiring).

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


# WHIT-369 — the poller stays single-tenant: it pins no scope (None default → shared owner).

def test_poll_leaves_scope_at_the_single_tenant_default(handler, monkeypatch):
    # A future edit that pins the WRONG scope (or splits plan-owner from fired-owner) trips here.
    fake = _FakeRepo(prior={"balance": Decimal("600000"), "as_of": "x", "currency": "AUD"})
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: fake)
    monkeypatch.setattr(handler, "fetch_balance", lambda *a, **k: _OK_PAYLOAD)

    seen = {}
    monkeypatch.setattr(handler, "notify_milestone_crossing",
                        lambda old, new, **kw: seen.update(kw) or 1)

    assert handler._poll_homeloan("key") is True
    assert seen.get("scope") is None                 # not pinned → shared default
    assert "milestone_repo" in seen                  # still threads the saved-plan repo
