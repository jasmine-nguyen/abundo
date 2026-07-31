"""WHIT-384 — adversarial GAP tests for the custom-plan celebration push (shared/milestones.py).

The implementer's test_milestones_custom_plan.py locks: resolve_plan fallback (None/unset/
read-failure -> default), a single custom crossing, the namespaced marker, dedup, re-target
re-arm, and a cent boundary. This file adds ONLY the gaps it left:
  - a lump-sum jump across SEVERAL custom milestones (furthest-first, one push, all marked);
  - a mixed already-fired + fresh custom plan (only fresh fire/mark);
  - a custom target EQUAL to a default (544000) not colliding with a stale "0" sprint marker;
  - the empty-list ([]) vs unset (None) semantics — [] means "never celebrate" (FLAGGED);
  - a malformed stored row (missing label/targetBalance) — does the mapping swallow or surface?
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
    """Stands in for MilestoneRepository. `stored` is the RAW list (targetBalance Decimal,
    like get_milestones_raw); None = unset; `raises` simulates a read failure."""
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


def _notify(shared, *, old, new, milestone_repo, notify=None):
    notify = notify or FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(FACTS),
        device_repo=FakeDeviceRepo(),
        notify_repo=notify,
        milestone_repo=milestone_repo,
    )
    return sent, notify


# --- lump-sum jump across several CUSTOM milestones -----------------------------------------

def test_lump_sum_across_custom_plan_furthest_first_one_push_all_marked(shared, recorder):
    # Mirrors the default test_lump_sum_sends_furthest_and_marks_all for a CUSTOM plan.
    repo = FakeMilestoneRepo(stored=[
        _row("Deposit", "480000", id="a"),
        _row("Halfway", "300000", id="b"),
        _row("Nearly", "120000", id="c"),
    ])
    sent, notify = _notify(shared, old="500000", new="100000", milestone_repo=repo)
    assert sent == 1
    assert len(recorder) == 1                       # exactly one push for the whole jump
    assert recorder[0][0] == "\U0001f389 Milestone reached — Nearly!"  # furthest (lowest 120k)
    assert notify.fired == {"id:a:bal:480000.00", "id:b:bal:300000.00", "id:c:bal:120000.00"}  # all marked fresh


def test_custom_crossed_list_is_sorted_furthest_first(shared):
    plan = shared.milestones.resolve_plan(FakeMilestoneRepo(stored=[
        _row("Deposit", "480000"), _row("Halfway", "300000"), _row("Nearly", "120000")]))
    crossed = shared.milestones.crossed_milestones(Decimal("500000"), Decimal("100000"), plan)
    # Decimal targets, ascending — furthest paid-down first. (No int/Decimal mix: a plan is all
    # PlanMilestone or all Milestone, never mixed, so the sort key is homogeneous.)
    assert [m.target_balance for m in crossed] == [Decimal("120000"), Decimal("300000"), Decimal("480000")]


# --- mixed already-fired + fresh on a custom plan ------------------------------------------

def test_mixed_fired_and_fresh_only_fresh_fire_and_mark(shared, recorder):
    repo = FakeMilestoneRepo(stored=[
        _row("Deposit", "480000", id="a"), _row("Halfway", "300000", id="b"), _row("Nearly", "120000", id="c")])
    notify = FakeNotifyRepo(fired={"id:b:bal:300000.00"})     # middle already celebrated
    sent, notify = _notify(shared, old="500000", new="100000", milestone_repo=repo, notify=notify)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Nearly!"  # furthest FRESH (120k)
    # only the two fresh keys are added; the pre-existing one is untouched, none re-fired.
    assert notify.fired == {"id:b:bal:300000.00", "id:a:bal:480000.00", "id:c:bal:120000.00"}


# --- a custom target EQUAL to a default (544000) must not collide with a stale sprint marker -

def test_custom_target_equal_to_default_does_not_collide_with_stale_sprint_marker(shared, recorder):
    # A user who previously fired the built-in Kickoff (marker "0"), then saved a custom plan
    # whose target happens to equal 544000. Its key is "id:m1:bal:544000.00", not "0" — so the
    # stale "0" must NOT suppress the custom celebration.
    repo = FakeMilestoneRepo(stored=[_row("My House", "544000")])
    notify = FakeNotifyRepo(fired={"0"})
    sent, notify = _notify(shared, old="545000", new="544000", milestone_repo=repo, notify=notify)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — My House!"
    assert notify.fired == {"0", "id:m1:bal:544000.00"}      # both live independently


# --- empty-list ([]) vs unset (None) semantics ---------------------------------------------

def test_resolve_plan_empty_list_is_a_real_empty_plan_not_the_default(shared):
    # DECISION PROBE: unset (None) -> default; but an empty LIST maps to [] (a real, empty plan).
    # These differ: [] is NOT treated as "no plan". Documents the actual branch in resolve_plan.
    assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored=[])) == []
    assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored=None)) == list(shared.milestones.MILESTONES)


def test_empty_plan_never_celebrates_even_on_a_huge_paydown(shared, recorder):
    # FLAG: with a stored [], NOTHING ever crosses -> no push, silently, forever. The default
    # fallback is bypassed. Guarded today only by the API rejecting an empty list on save
    # (lambda_api/handler.py:2091); a direct/migration write of [] would silence celebrations.
    repo = FakeMilestoneRepo(stored=[])
    sent, notify = _notify(shared, old="600000", new="100000", milestone_repo=repo)
    assert sent == 0
    assert recorder == []
    assert notify.fired == set()


# --- malformed stored row: does the mapping swallow (fall back) or surface? -----------------

def test_malformed_row_missing_label_surfaces_not_swallowed(shared):
    # The try/except in resolve_plan wraps ONLY the get_milestones_raw() read, NOT the
    # PlanMilestone comprehension. So a malformed row (missing "label") raises KeyError OUT of
    # resolve_plan — it does NOT fall back to the default. Characterises the current behaviour.
    bad = FakeMilestoneRepo(stored=[{"id": "x", "targetBalance": Decimal("480000"), "targetDate": "2027-01-01"}])
    with pytest.raises(KeyError):
        shared.milestones.resolve_plan(bad)


def test_malformed_row_missing_target_balance_surfaces(shared):
    bad = FakeMilestoneRepo(stored=[{"id": "x", "label": "Broken", "targetDate": "2027-01-01"}])
    with pytest.raises(KeyError):
        shared.milestones.resolve_plan(bad)


def test_malformed_row_propagates_through_notify_to_the_pollers_outer_guard(shared, recorder):
    # notify calls resolve_plan first, so a malformed row surfaces from notify too — the
    # celebration is skipped for the WHOLE poll (only the poller's outer except keeps the
    # balance stored). No push, no default fallback.
    bad = FakeMilestoneRepo(stored=[{"id": "x", "targetBalance": Decimal("480000"), "targetDate": "2027-01-01"}])
    with pytest.raises(KeyError):
        shared.milestones.notify_milestone_crossing(
            Decimal("500000"), Decimal("100000"),
            loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
            notify_repo=FakeNotifyRepo(), milestone_repo=bad)
    assert recorder == []
