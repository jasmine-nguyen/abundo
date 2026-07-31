"""WHIT-386 — defence in depth: an authoritative EMPTY plan ([]) must sweep NOTHING.

The WHIT-385 reconcile deletes dead custom markers when the resolved plan is authoritative.
An authoritative [] would make EVERY custom marker stale and wipe the whole "already celebrated"
record in one sweep. That [] is API-unreachable today (the save endpoint rejects an empty list),
so the guard (`if authoritative and plan:`) is defence in depth: if that endpoint check ever
regresses, an empty plan sweeps nothing instead of silently erasing the once-ever record.

These add ONLY the gaps the core suite leaves after the guard:
  - [G-386a] fail-on-revert: authoritative [] sweeps nothing and never even calls the delete;
  - [G-386b] regression: a POPULATED authoritative plan still sweeps a dead marker (guard didn't
    over-reach and disable legitimate self-heal).
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
        self.remove_calls = 0  # how many times remove_milestone_markers was invoked

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        assert isinstance(key, str), "marker must be a string (String Set)"
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        assert keys, "must guard empty before calling remove_milestone_markers"
        self.remove_calls += 1
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


def _run(shared, *, old, new, milestone_repo, notify):
    return shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(FACTS),
        device_repo=FakeDeviceRepo(),
        notify_repo=notify,
        milestone_repo=milestone_repo,
    )


def test_authoritative_empty_plan_sweeps_nothing(shared, recorder):
    # [G-386a] fail-on-revert: an authoritative [] with custom markers present must leave EVERY
    # marker intact and never call remove_milestone_markers (the guard short-circuits before any
    # delete I/O). Revert `and plan` at shared/milestones.py and both markers get wiped → this fails.
    notify = FakeNotifyRepo({"id:m1:bal:300000.00", "bal:120000.00", "0"})
    sent = _run(shared, old="250000", new="249000",
                milestone_repo=FakeMilestoneRepo(stored=[]), notify=notify)
    assert sent == 0
    assert notify.removed == set()
    assert notify.remove_calls == 0
    assert notify.fired == {"id:m1:bal:300000.00", "bal:120000.00", "0"}


def test_populated_plan_still_sweeps_a_dead_marker(shared, recorder):
    # [G-386b] regression: the guard must NOT disable legitimate self-heal. A populated authoritative
    # plan (one row) with a dead custom marker still reconciles it away, exactly as WHIT-385 does.
    notify = FakeNotifyRepo({"id:m1:bal:300000.00"})
    _run(shared, old="250000", new="249000",
         milestone_repo=FakeMilestoneRepo(stored=[_row("House", "280000")]), notify=notify)
    assert notify.removed == {"id:m1:bal:300000.00"}
    assert notify.remove_calls == 1


# --- QA gap tests (adversarial) — added alongside the implementer's G-386a/b -----------------
# These cover the edges the implementer's two tests leave: an empty plan colliding with a genuine
# DEFAULT crossing in the same poll, and the "no notify I/O at all" short-circuit. Each is proven
# fail-on-revert (revert `and plan` -> it goes red).


def test_empty_plan_suppresses_a_default_crossing_and_sweeps_nothing(shared, recorder):
    # [G-386c] An authoritative [] must NOT fall back to the built-in default for CROSSING (nothing
    # fires) AND must not sweep (WHIT-386). old=545000 -> new=544000 WOULD cross the built-in
    # "Kickoff" (544000) if the empty plan leaked to the default. A live custom marker is seeded so a
    # reverted `and plan` wipes it. Guarded: sent==0, removed==set(). Revert `and plan` -> the
    # custom marker is swept -> removed != set() -> fails.
    # NB: no built-in sprint marker is seeded, so `sent == 0` genuinely discriminates the leak — if
    # an empty [] fell back to the default and crossed Kickoff (544000), it WOULD fire (sent==1).
    notify = FakeNotifyRepo({"id:m1:bal:400000.00"})
    sent = _run(shared, old="545000", new="544000",
                milestone_repo=FakeMilestoneRepo(stored=[]), notify=notify)
    assert sent == 0                       # empty plan does NOT fall back to the default crossing
    assert recorder == []
    assert notify.remove_calls == 0
    assert notify.removed == set()
    assert notify.fired == {"id:m1:bal:400000.00"}


def test_empty_plan_never_touches_the_notify_store(shared, recorder):
    # [G-386e] The guard short-circuits BEFORE the reconcile try, so on an authoritative [] the
    # notify store is never read (fired_milestones is never called) -- a raising repo is never even
    # entered. The read counter is the fail-on-revert lever: revert `and plan` -> the reconcile
    # enters the try and calls fired_milestones -> read_calls==1 -> fails. (A raising
    # fired_milestones alone would NOT distinguish: the reconcile try swallows the exception and
    # still returns 0.)
    class CountingNotifyRepo(FakeNotifyRepo):
        def __init__(self, fired=None):
            super().__init__(fired)
            self.read_calls = 0

        def fired_milestones(self, scope=None):
            self.read_calls += 1
            raise RuntimeError("notify store must not be read on the empty-plan path")

    notify = CountingNotifyRepo({"id:m1:bal:400000.00"})
    sent = _run(shared, old="250000", new="249000",
                milestone_repo=FakeMilestoneRepo(stored=[]), notify=notify)
    assert sent == 0
    assert notify.read_calls == 0          # short-circuited before ANY notify I/O
    assert notify.remove_calls == 0
