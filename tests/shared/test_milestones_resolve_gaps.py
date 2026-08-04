"""WHIT-387 — adversarial GAP tests for the per-row malformed-plan skip in
shared/milestones._resolve_plan, INDEPENDENT of the implementer's
test_milestones_custom_plan_gaps.py / test_repository_milestone_edges.py.

The implementer already locks: missing-label / missing-target skipped, good+bad+good
skip-and-celebrate, the alarm token, all-rows-bad -> empty + no marker sweep,
previously-fired-now-corrupt swept, and a non-list scalar -> empty. This file adds ONLY
the gaps they left:
  [G1] each exception branch of the caught tuple (InvalidOperation / ValueError / TypeError)
       is exercised by a REAL corrupt-target shape, resolve-level, and each is logged;
  [G2] a bare non-dict list element (string / int) among good rows through the full poller
       (notify) path — not just the resolve list;
  [G3] several survivors around several bad rows keep their stored order (append contract);
  [G4] the multi-tenant `scope` seam: a malformed row read under a non-None scope is skipped
       + the scope is threaded to get_milestones_raw(scope), survivors still resolve;
  [G5] reconcile sweep interaction when SOME rows survive AND a genuinely stale marker (from a
       since-deleted good target, not the corrupt row) exists: only the stale key is swept, a
       surviving row's live marker is kept, and a corrupt row present doesn't crash the sweep;
  [G6] regression: a NaN target (quantize accepts NaN, so it would slip the per-row skip and
       raise InvalidOperation later at the crossing comparison — the silent whole-poll drop) is
       rejected by the shared row validator (milestone_rows.row_target, WHIT-394 — the guard
       started life inline in _plan_marker), so it's skipped + logged like any bad row.

Self-contained fakes mirror the implementer's FakeMilestoneRepo / FakeNotifyRepo / _notify /
_row patterns (importing them cross-file is fragile under pytest importlib mode); the
scope-aware fake adds the `scope` arg the real get_milestones_raw(scope) takes.
"""

import logging
from decimal import Decimal

import pytest

# Shared milestone fakes + FACTS + _row + recorder (WHIT-445). FakeMilestoneRepo here is the
# scope-aware superset this suite's multi-tenant tests need.
from _milestone_fakes import (
    FACTS, FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, FakeNotifyRepo, _row, recorder,
)


def _notify(shared, *, old, new, milestone_repo, notify=None, scope=None):
    notify = notify or FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(FACTS),
        device_repo=FakeDeviceRepo(),
        notify_repo=notify,
        milestone_repo=milestone_repo,
        scope=scope,
    )
    return sent, notify


# --- [G1] each caught exception branch fired by a REAL corrupt target, resolve-level --------

@pytest.mark.parametrize("bad_target, branch", [
    ("not-a-number", "InvalidOperation"),   # Decimal("not-a-number") -> InvalidOperation
    ("", "InvalidOperation"),               # empty string -> InvalidOperation
    ("   ", "InvalidOperation"),            # whitespace -> InvalidOperation
    (None, "TypeError"),                    # Decimal(None) -> TypeError
    ([1, 2], "ValueError"),                 # Decimal([1,2]) -> ValueError (bad sequence len)
    ({}, "TypeError"),                      # Decimal({}) -> TypeError
    (b"480000", "TypeError"),               # Decimal(bytes) -> TypeError
])
def test_corrupt_target_type_is_skipped_and_logged(shared, caplog, bad_target, branch):
    # Every non-numeric/junk target shape resolves to an EMPTY plan (skipped), never raises, and
    # is logged with the alarm token. Locks that every branch of the shared validator's coercion
    # catch is actually reached by a plausible corrupt row. Fail-on-revert: drop the matching type
    # from milestone_rows.row_target's (TypeError, ValueError, InvalidOperation) catch -> that row
    # raises out of the loop, which now catches only MalformedMilestoneRow (WHIT-394).
    bad = FakeMilestoneRepo(stored=[{"id": "x", "label": "Broken", "targetBalance": bad_target,
                                     "targetDate": "2027-01-01"}])
    with caplog.at_level(logging.ERROR, logger="milestones"):
        assert shared.milestones.resolve_plan(bad) == []
    assert any("MILESTONE_ROW_MALFORMED" in r.message and r.levelno == logging.ERROR
               for r in caplog.records)


def test_non_numeric_target_among_good_ones_celebrates_the_rest(shared, recorder):
    # The InvalidOperation branch through the FULL poller path (the implementer's good+bad+good
    # used a MISSING field = KeyError; this pins the non-numeric-string = InvalidOperation case).
    repo = FakeMilestoneRepo(stored=[
        _row("Deposit", "480000", id="a"),
        {"id": "bad", "label": "Junk", "targetBalance": "not-a-number", "targetDate": "2027-01-01"},
        _row("Nearly", "120000", id="c"),
    ])
    plan = shared.milestones.resolve_plan(repo)
    assert [m.label for m in plan] == ["Deposit", "Nearly"]
    sent, notify = _notify(shared, old="500000", new="100000", milestone_repo=repo)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Nearly!"
    assert notify.fired == {"id:a:bal:480000.00", "id:c:bal:120000.00"}


# --- [G2] a bare non-dict list element through the full notify (poller) path ----------------

@pytest.mark.parametrize("junk", ["garbage", 5, ["nested"], None])
def test_bare_non_dict_element_among_good_rows_celebrates_the_rest(shared, recorder, junk):
    # The implementer's all-bad test used dict-shaped bad rows ({"id":"x"} -> KeyError). A BARE
    # scalar element (string/int/list/None) fails on subscription (TypeError) instead. Through
    # the full notify path it must be skipped and the good rows still celebrate.
    repo = FakeMilestoneRepo(stored=[_row("Deposit", "480000", id="a"), junk, _row("Nearly", "120000", id="c")])
    sent, notify = _notify(shared, old="500000", new="100000", milestone_repo=repo)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Nearly!"
    assert notify.fired == {"id:a:bal:480000.00", "id:c:bal:120000.00"}


# --- [G3] survivor ordering around several interleaved bad rows -----------------------------

def test_multiple_survivors_keep_stored_order_around_bad_rows(shared):
    # BAD, good, BAD, good, BAD -> the two good rows resolve in their stored order. Locks the
    # append-in-iteration-order contract with MORE than one survivor and bad rows on both ends.
    repo = FakeMilestoneRepo(stored=[
        {"id": "b1", "label": "no target"},                    # KeyError
        _row("First", "480000", id="a"),
        {"id": "b2", "targetBalance": Decimal("1")},           # KeyError (no label)
        _row("Second", "120000", id="c"),
        "garbage",                                             # TypeError
    ])
    plan = shared.milestones.resolve_plan(repo)
    assert [(m.label, m.target_balance) for m in plan] == [
        ("First", Decimal("480000")), ("Second", Decimal("120000"))]


# --- [G4] multi-tenant scope seam: skip under a non-None scope, scope threaded ---------------

def test_malformed_row_under_scope_is_skipped_and_scope_is_threaded(shared, caplog):
    # A malformed row read for a specific tenant must skip like the shared one AND read from that
    # tenant's scope (get_milestones_raw(scope)), not the default. Survivor still resolves.
    repo = FakeMilestoneRepo(by_scope={"user-x": [
        _row("Keep", "300000", id="k"),
        {"id": "bad", "label": "Junk", "targetBalance": "nope", "targetDate": "2027-01-01"},
    ]})
    with caplog.at_level(logging.ERROR, logger="milestones"):
        plan = shared.milestones.resolve_plan(repo, scope="user-x")
    assert [m.label for m in plan] == ["Keep"]
    assert repo.scopes_read == ["user-x"]                       # read the tenant's plan, not default
    assert any("MILESTONE_ROW_MALFORMED" in r.message for r in caplog.records)


def test_scope_malformed_row_celebrates_survivor_through_notify(shared, recorder):
    # End-to-end under a scope: bad row skipped, the surviving target celebrates, and the fired
    # marker is written (scope is passed straight through mark_milestone_fired).
    repo = FakeMilestoneRepo(by_scope={"user-x": [
        {"id": "bad", "label": "Junk", "targetBalance": None, "targetDate": "2027-01-01"},
        _row("Deposit", "120000", id="d"),
    ]})
    sent, notify = _notify(shared, old="200000", new="100000", milestone_repo=repo, scope="user-x")
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Deposit!"
    assert notify.fired == {"id:d:bal:120000.00"}


# --- [G5] reconcile sweep with SOME survivors + an UNRELATED stale marker + a corrupt row ----

def test_sweep_removes_only_the_stale_marker_keeps_survivor_with_a_corrupt_row_present(shared, recorder):
    # Plan = [good survivor "Keep" (already fired), corrupt row]. Fired set holds the survivor's
    # LIVE marker + a stale marker from a since-deleted target (not the corrupt row). On a no-
    # crossing poll the WHIT-385/386 sweep must remove ONLY the stale key, keep the survivor's
    # live marker, and NOT crash on the corrupt row. Fail-on-revert of the WHIT-387 per-row skip:
    # the corrupt row raises out of _resolve_plan -> notify raises -> this errors instead of
    # asserting the sweep.
    repo = FakeMilestoneRepo(stored=[
        _row("Keep", "300000", id="k"),
        {"id": "bad", "label": "Junk", "targetBalance": "nope", "targetDate": "2027-01-01"},
    ])
    live_marker = "id:k:bal:300000.00"
    stale_marker = "id:deleted:bal:999999.00"
    notify = FakeNotifyRepo(fired={live_marker, stale_marker})
    # Balance well above the survivor target -> nothing crosses this poll; the sweep still runs.
    sent, notify = _notify(shared, old="500000", new="450000", milestone_repo=repo, notify=notify)
    assert sent == 0
    assert recorder == []
    assert notify.removed == {stale_marker}                    # ONLY the unrelated stale key
    assert live_marker in notify.fired                         # survivor's marker preserved
    assert stale_marker not in notify.fired


# --- [G6] regression: a NaN target is skipped like any other corrupt target (WHIT-387) --------

def test_nan_target_is_skipped_like_any_other_corrupt_target(shared, recorder):
    # A NaN targetBalance quantizes to NaN WITHOUT raising, so it would slip past the per-row
    # skip and only blow up later in crossed_milestones' `old > NaN >= new` comparison (a Decimal
    # compare against NaN raises InvalidOperation) — OUTSIDE the guarded loop, back in the poller's
    # swallow, losing the whole poll's celebration. The shared validator's is_finite guard rejects
    # it so the NaN row is skipped + logged and the good rows still celebrate. Fail-on-revert: drop
    # the is_finite check in milestone_rows.row_target (WHIT-394) -> notify raises InvalidOperation
    # and this errors instead of asserting.
    repo = FakeMilestoneRepo(stored=[
        _row("Deposit", "480000", id="a"),
        {"id": "nan", "label": "Broken", "targetBalance": Decimal("NaN"), "targetDate": "2027-01-01"},
        _row("Nearly", "120000", id="c"),
    ])
    plan = shared.milestones.resolve_plan(repo)
    assert [m.label for m in plan] == ["Deposit", "Nearly"]
    sent, notify = _notify(shared, old="500000", new="100000", milestone_repo=repo)
    assert sent == 1
    assert notify.fired == {"id:a:bal:480000.00", "id:c:bal:120000.00"}


# --- [G7] regression: a string target must not drop the whole poll (WHIT-387) -----------------

def test_string_target_does_not_drop_the_whole_poll(shared, recorder):
    # A directly/legacy-written row storing targetBalance as a String (DynamoDB S attribute) reads
    # back as a Python str. It must NOT take down the whole poll: resolve + crossing must not raise,
    # and the good rows' celebration must still fire. _resolve_plan now COERCES target_balance to a
    # Decimal, so the string row compares fine (Decimal vs Decimal) and celebrates rather than
    # crashing crossed_milestones with Decimal > str -> TypeError outside the guarded loop. This
    # asserts ONLY the WHIT-387 invariant (no silent whole-poll drop); fail-on-revert: store the raw
    # target instead of Decimal(...) -> crossed_milestones raises TypeError and this errors.
    repo = FakeMilestoneRepo(stored=[
        _row("Deposit", "480000", id="a"),
        {"id": "str", "label": "Broken", "targetBalance": "120000", "targetDate": "2027-01-01"},
        _row("Nearly", "100000", id="c"),
    ])
    # Currently raises TypeError here (Decimal > str), OUTSIDE the guarded loop:
    plan = shared.milestones.resolve_plan(repo)
    shared.milestones.crossed_milestones(Decimal("500000"), Decimal("90000"), plan)
    sent, notify = _notify(shared, old="500000", new="90000", milestone_repo=repo)
    assert sent == 1                                                   # celebration not swallowed
    # The two good targets celebrate under either fix (skip or coerce); don't over-pin the str row:
    assert {"id:a:bal:480000.00", "id:c:bal:100000.00"} <= notify.fired
