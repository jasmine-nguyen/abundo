"""WHIT-384 — adversarial GAP tests for the custom-plan celebration push (shared/milestones.py).

The implementer's test_milestones_custom_plan.py locks: resolve_plan fallback (None/unset/
read-failure -> default), a single custom crossing, the namespaced marker, dedup, re-target
re-arm, and a cent boundary. This file adds ONLY the gaps it left:
  - a lump-sum jump across SEVERAL custom milestones (furthest-first, one push, all marked);
  - a mixed already-fired + fresh custom plan (only fresh fire/mark);
  - a custom target EQUAL to a default (544000) not colliding with a stale "0" sprint marker;
  - the empty-list ([]) vs unset (None) semantics — [] means "never celebrate" (FLAGGED);
  - a malformed stored row (missing label/targetBalance) — skipped + logged, the rest celebrate (WHIT-387).
"""

import logging
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


# --- malformed stored row: skipped + logged, the rest celebrate (WHIT-387) ------------------

def test_malformed_row_missing_label_is_skipped_not_raised(shared):
    # A row missing "label" no longer raises out of resolve_plan — it is skipped (WHIT-387).
    # A lone bad row leaves an empty plan; it does NOT fall back to the default.
    bad = FakeMilestoneRepo(stored=[{"id": "x", "targetBalance": Decimal("480000"), "targetDate": "2027-01-01"}])
    assert shared.milestones.resolve_plan(bad) == []


def test_malformed_row_missing_target_balance_is_skipped_not_raised(shared):
    bad = FakeMilestoneRepo(stored=[{"id": "x", "label": "Broken", "targetDate": "2027-01-01"}])
    assert shared.milestones.resolve_plan(bad) == []


def test_bad_row_among_good_ones_is_skipped_and_the_rest_celebrate(shared, recorder):
    # The core WHIT-387 fix: one corrupt row must not throw away the whole plan's celebration.
    # good + BAD (no targetBalance) + good -> the two good rows resolve in order and the furthest
    # good one celebrates. Fail-on-revert lever: revert the per-row skip -> the plan raises -> no
    # push -> this goes red.
    repo = FakeMilestoneRepo(stored=[
        _row("Deposit", "480000", id="a"),
        {"id": "bad", "label": "Broken", "targetDate": "2027-01-01"},   # no targetBalance
        _row("Nearly", "120000", id="c"),
    ])
    plan = shared.milestones.resolve_plan(repo)
    assert [m.label for m in plan] == ["Deposit", "Nearly"]     # bad row dropped, order kept
    sent, notify = _notify(shared, old="500000", new="100000", milestone_repo=repo)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Nearly!"   # furthest good (120k)
    assert notify.fired == {"id:a:bal:480000.00", "id:c:bal:120000.00"}


def test_bad_row_logs_a_distinct_alarm_line(shared, caplog):
    # The skip must be VISIBLE (the CloudWatch alarm watches this token), not a silent drop.
    bad = FakeMilestoneRepo(stored=[{"id": "x", "label": "Broken", "targetDate": "2027-01-01"}])
    with caplog.at_level(logging.ERROR, logger="milestones"):
        shared.milestones.resolve_plan(bad)
    assert any("MILESTONE_ROW_MALFORMED" in r.message and r.levelno == logging.ERROR
               for r in caplog.records)


def test_all_rows_bad_is_empty_and_never_wipes_markers(shared, recorder):
    # Every row corrupt -> empty plan. It must behave like a genuine empty plan: no push, and
    # crucially NOT look like an authoritative-empty that sweeps the "already celebrated" record
    # (the WHIT-386 interaction). Seeds live custom markers and proves remove is never called.
    repo = FakeMilestoneRepo(stored=[{"id": "x"}, {"label": "y"}])
    notify = FakeNotifyRepo(fired={"id:a:bal:480000.00", "id:c:bal:120000.00"})
    sent, notify = _notify(shared, old="600000", new="100000", milestone_repo=repo, notify=notify)
    assert sent == 0
    assert recorder == []
    assert notify.removed == set()                              # WHIT-386 guard held
    assert notify.fired == {"id:a:bal:480000.00", "id:c:bal:120000.00"}   # record intact


def test_previously_fired_row_now_unreadable_target_keeps_its_record(shared, recorder):
    # A row that celebrated earlier and NOW has an unreadable target (no targetBalance), so
    # _plan_marker can't rebuild its exact key. WHIT-424: its id still reads ("gone"), so every
    # "id:gone:..." marker it fired stays live via the id prefix rather than being swept as if the
    # row were deleted — repairing the amount and re-crossing can no longer congratulate twice.
    # A row that is unreadable AND has no readable id is the one remaining corner that still loses
    # its record (pinned in test_milestones_live_keys_gaps.py). Proves the sweep runs without a crash.
    repo = FakeMilestoneRepo(stored=[
        _row("Good", "120000", id="c"),
        {"id": "gone", "label": "Was celebrated", "targetDate": "2027-01-01"},   # target now unreadable
    ])
    notify = FakeNotifyRepo(fired={"id:c:bal:120000.00", "id:gone:bal:480000.00"})
    sent, notify = _notify(shared, old="130000", new="119000", milestone_repo=repo, notify=notify)
    assert "id:gone:bal:480000.00" not in notify.removed        # kept via the id prefix
    assert "id:gone:bal:480000.00" in notify.fired              # record intact
    assert recorder == []                                       # already-fired good row: no re-fire


def test_non_list_stored_plan_is_empty_not_raised(shared, caplog):
    # A corrupt whole-plan write stored as a non-iterable scalar (not merely a bad row) must
    # degrade to an empty plan via the isinstance guard, not raise, and log the plan-level token.
    with caplog.at_level(logging.ERROR, logger="milestones"):
        assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored=5)) == []
    assert any("MILESTONE_PLAN_MALFORMED" in r.message for r in caplog.records)
