"""WHIT-385 — adversarial GAP tests for reconciling dead "bal:" markers (shared/milestones.py).

The implementer's test_milestones_custom_plan.py + test_repository_notify.py already lock:
core re-target sweep, the non-authoritative no-delete guards (read-fail / unset / None repo),
empty-plan clears-all, sprint markers preserved, no-delete-when-live, once-ever dedup for a
live marker, and the repo DELETE/empty-guard/no-TTL/error surface. This file adds ONLY the
gaps they leave:
  - a stale sweep AND a genuine fresh crossing in the SAME poll (moved-up `fired` still dedups,
    swept key not re-added);
  - reconcile on a SEED poll (old_balance is None) — runs before crossed_milestones;
  - duplicate targets collapsing in `live` — a dup-target live marker is not falsely swept;
  - malformed "bal:" keys ("bal:", "bal:oops") swept as dead (self-heal);
  - reconcile runs BEFORE the device-token check (no device → still reconciles).
"""

from decimal import Decimal

import pytest


class FakeLoanFactsRepo:
    def __init__(self, facts=None):
        self._facts = facts

    def get_loanfacts(self):
        return self._facts


class FakeDeviceRepo:
    def __init__(self, tokens=("tok",)):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


class FakeNotifyRepo:
    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.removed = set()

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        assert isinstance(key, str), "marker must be a string (String Set)"
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        assert keys, "must guard empty before calling remove_milestone_markers"
        self.removed |= set(keys)
        self.fired -= set(keys)


class FakeMilestoneRepo:
    def __init__(self, stored=None, raises=None):
        self._stored = stored
        self._raises = raises

    def get_milestones_raw(self):
        if self._raises is not None:
            raise self._raises
        return self._stored


FACTS = {"original": 600000.0, "homeValue": 770000.0, "lvr": 0.8,
         "ratePct": 5.95, "baseRepay": 3570.0, "extra": 12000.0, "payoffGoalDate": None}


def _row(label, balance, id="m1", date="2027-01-01"):
    return {"id": id, "label": label, "targetBalance": Decimal(str(balance)), "targetDate": date}


@pytest.fixture
def recorder(shared, monkeypatch):
    calls = []

    def fake(title, body, tokens, **kw):
        calls.append((title, body, tokens))
        return {"sent": len(tokens), "ok": len(tokens), "pruned": []}

    monkeypatch.setattr(shared.milestones, "send_push", fake)
    return calls


def _run(shared, *, old, new, milestone_repo, notify, tokens=("tok",)):
    return shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(FACTS),
        device_repo=FakeDeviceRepo(tokens=tokens),
        notify_repo=notify,
        milestone_repo=milestone_repo,
    )


# --- Gap A: stale sweep AND a genuine fresh crossing in the SAME poll ------------------------

def test_stale_swept_and_fresh_crossing_fires_same_poll(shared, recorder):
    # [G-A1] milestone m1 was re-targeted 300000 → 280000; its old "id:m1:bal:300000.00" marker is
    # stale and the plan now points at 280000, which this poll crosses. Reconcile must sweep the
    # dead key AND the fresh crossing must fire — the swept key must NOT be re-added by the mark.
    notify = FakeNotifyRepo({"id:m1:bal:300000.00"})
    sent = _run(shared, old="285000", new="280000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("House", "280000")]), notify=notify)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — House!"
    assert notify.removed == {"id:m1:bal:300000.00"}
    assert notify.fired == {"id:m1:bal:280000.00"}    # stale gone, fresh added, stale not re-added


def test_reconcile_and_dedup_coexist_live_fired_not_refired(shared, recorder):
    # [G-A2] Hardest interleave: fired = {id:x:300000 (stale), id:d:480000 (LIVE + already fired)};
    # plan = [480000 id:d (already), 280000 id:h (fresh)]; a lump-sum poll crosses BOTH. The moved-up
    # `fired` read must still dedup id:d (no re-fire) while id:x:300000 is swept and id:h fires.
    notify = FakeNotifyRepo({"id:x:bal:300000.00", "id:d:bal:480000.00"})
    sent = _run(shared, old="500000", new="280000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("Deposit", "480000", id="d"), _row("House", "280000", id="h")]),
                notify=notify)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — House!"   # furthest FRESH (480000 suppressed)
    assert notify.removed == {"id:x:bal:300000.00"}
    assert notify.fired == {"id:d:bal:480000.00", "id:h:bal:280000.00"}   # id:d kept (not re-fired)


# --- Gap B: reconcile runs on the SEED poll (old_balance is None) ----------------------------

def test_reconcile_runs_on_seed_poll_old_balance_none(shared, recorder):
    # [G-B1] Characterization: reconcile is placed BEFORE crossed_milestones, so even a seed poll
    # (old_balance None → nothing can cross) still sweeps a dead custom marker. Desirable/harmless.
    notify = FakeNotifyRepo({"bal:300000.00"})
    sent = _run(shared, old=None, new="250000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("House", "280000")]), notify=notify)
    assert sent == 0
    assert recorder == []
    assert notify.removed == {"bal:300000.00"}


# --- Gap C: duplicate targets collapse in `live`; a dup-target live marker is not swept -------

def test_duplicate_live_target_preserved_while_stale_removed(shared, recorder):
    # [G-C1] Two rows share target 280000 but with distinct ids → two DISTINCT live markers (id-
    # keying, WHIT-369, so no collapse). Both live markers must be preserved, while a genuinely
    # dead one (id:z:300000) is swept.
    notify = FakeNotifyRepo({"id:a:bal:280000.00", "id:b:bal:280000.00", "id:z:bal:300000.00"})
    _run(shared, old="285000", new="284000",
         milestone_repo=FakeMilestoneRepo(stored=[_row("A", "280000", id="a"), _row("B", "280000", id="b")]),
         notify=notify)
    assert notify.removed == {"id:z:bal:300000.00"}
    assert notify.fired == {"id:a:bal:280000.00", "id:b:bal:280000.00"}


# --- Gap D: malformed / legacy "bal:" keys are swept as dead (self-heal) ---------------------

def test_malformed_bal_keys_are_swept_as_stale(shared, recorder):
    # [G-D1] Characterization: any custom-namespaced key not in the plan is dead — including garbage
    # like "bal:" (no amount) or "bal:oops". Reconcile sweeps them, self-healing the set. Here the
    # plan row is a LEGACY row with no id, so its live marker is the amount-only "bal:280000.00",
    # which is preserved while the garbage keys are swept.
    legacy_row = {"label": "House", "targetBalance": Decimal("280000"), "targetDate": "2027-01-01"}
    notify = FakeNotifyRepo({"bal:", "bal:oops", "bal:280000.00"})
    _run(shared, old="285000", new="284000",
         milestone_repo=FakeMilestoneRepo(stored=[legacy_row]), notify=notify)
    assert notify.removed == {"bal:", "bal:oops"}
    assert notify.fired == {"bal:280000.00"}


# --- Gap E: reconcile runs BEFORE the device-token check -------------------------------------

def test_reconcile_runs_even_when_no_device_tokens(shared, recorder):
    # [G-E1] No device registered. Reconcile is placed before crossed/dedup/token checks, so a dead
    # marker is still swept even though a would-be fresh crossing sends nothing (and isn't marked).
    notify = FakeNotifyRepo({"bal:300000.00"})
    sent = _run(shared, old="285000", new="280000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("House", "280000")]),
                notify=notify, tokens=())
    assert sent == 0
    assert recorder == []
    assert notify.removed == {"bal:300000.00"}   # reconcile happened before the token short-circuit
    assert notify.fired == set()                 # fresh crossing NOT marked (returned at token check)
