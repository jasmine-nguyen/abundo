"""Tests for the payoff-milestone celebration push (shared/milestones.py, WHIT-301).

Covers the pure crossing/equity math and the detector's send/dedup/mark-regardless/degrade
behaviour via lightweight fake repos.
"""

from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable
# The milestone fakes + FACTS + the send_push recorder live in tests/shared/_milestone_fakes.py
# so the whole milestone family shares ONE definition of each (WHIT-445).
from _milestone_fakes import (
    FACTS, FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, notify_repo,
    _row, recorder, removed_markers, sample_plan_repo, scopes_marked, scopes_read,
    stored_markers,
)

# SAMPLE_PLAN's markers for the steps these tests cross.
KICKOFF = "id:kickoff:bal:544000.00"
QUARTER = "id:quarter:bal:420000.00"
HALFWAY = "id:halfway:bal:295000.00"


def _sample_plan(shared):
    plan, _live = shared.milestones._resolve_plan(sample_plan_repo())
    return plan


# --- usable_equity ----------------------------------------------------------------------

@pytest.mark.parametrize("home_value, balance, lvr, expected", [
    (770000.0, 295000.0, 0.8, 321000),   # 770000 * 0.8 - 295000, the client formula
    (500000.0, 500000.0, 0.8, 0),        # clamps at zero
    # half-up like the client twin's Math.round (WHIT-307); built-in round() would give 0 and 2
    (3.0, 0.0, 0.5, 2),
    (1.0, 0.0, 0.5, 1),
    (5.0, 0.0, 0.5, 3),
])
def test_usable_equity_matches_the_client_formula(shared, home_value, balance, lvr, expected):
    assert shared.milestones.usable_equity(home_value, balance, lvr) == expected


# --- crossed_milestones (pure) ----------------------------------------------------------

def test_no_crossing_when_balance_holds_above_a_target(shared):
    assert shared.milestones.crossed_milestones(Decimal("600000"), Decimal("560000"), _sample_plan(shared)) == []


def test_first_poll_none_crosses_nothing(shared):
    # old is None (first-ever poll / seed guard) → never fire, even far below a target.
    assert shared.milestones.crossed_milestones(None, Decimal("100000"), _sample_plan(shared)) == []


def test_rising_balance_crosses_nothing(shared):
    assert shared.milestones.crossed_milestones(Decimal("400000"), Decimal("410000"), _sample_plan(shared)) == []


def test_exact_boundary_landing_counts_as_crossed(shared):
    # new == target fires; the NEXT poll starting ON the boundary must not (old > target false).
    plan = _sample_plan(shared)
    crossed = shared.milestones.crossed_milestones(Decimal("545000"), Decimal("544000"), plan)
    assert [m.label for m in crossed] == ["Kickoff"]
    assert shared.milestones.crossed_milestones(Decimal("544000"), Decimal("543000"), plan) == []


def test_lump_sum_jump_returns_furthest_first(shared):
    # 600k -> 290k crosses Kickoff(544k), Quarter(420k), Halfway(295k); furthest (lowest) first.
    crossed = shared.milestones.crossed_milestones(Decimal("600000"), Decimal("290000"), _sample_plan(shared))
    assert [m.target_balance for m in crossed] == [295000, 420000, 544000]


# --- notify_milestone_crossing ----------------------------------------------------------

def _notify(shared, *, old, new, facts=FACTS, tokens=("tok",), fired=None, notify=None,
            milestone_repo=None):
    # One wrapper for the whole milestone family (WHIT-471 fold): pass `fired` to build a fresh
    # notify repo, or `notify` to supply one you assert on; `milestone_repo` measures a saved plan,
    # and without one SAMPLE_PLAN is measured.
    return shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(facts),
        device_repo=FakeDeviceRepo(tokens),
        notify_repo=notify if notify is not None else notify_repo(fired),
        milestone_repo=milestone_repo if milestone_repo is not None else sample_plan_repo(),
    )


def test_single_crossing_sends_one_push_with_both_numbers(shared, recorder):
    notify = notify_repo()
    sent = _notify(shared, old="545000", new="544000", notify=notify)
    assert sent == 1
    assert len(recorder) == 1
    title, body, tokens = recorder[0]
    assert title == "\U0001f389 Milestone reached — Kickoff!"
    # paid = 600000 - 544000 = 56,000 ; equity = 770000*0.8 - 544000 = 72,000
    assert "$56,000 down on your mortgage" in body
    assert "$72,000 in equity unlocked" in body
    assert "Keep building!" in body
    assert stored_markers(notify) == {KICKOFF}


def test_crossing_push_carries_milestone_deeplink_data(shared, monkeypatch):
    # WHIT-322: the push carries data={"type": "milestone"} so a tap opens the mortgage screen.
    captured = []
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda title, body, tokens, **kw: captured.append(kw.get("data")) or
                        {"sent": len(tokens), "ok": len(tokens), "pruned": []})
    _notify(shared, old="545000", new="544000")
    assert captured == [{"type": "milestone"}]


def test_lump_sum_sends_furthest_and_marks_all(shared, recorder):
    notify = notify_repo()
    sent = _notify(shared, old="600000", new="290000", notify=notify)
    assert sent == 1
    assert len(recorder) == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Halfway!"  # furthest crossed (295k)
    assert stored_markers(notify) == {KICKOFF, QUARTER, HALFWAY}  # all three crossed are marked


def test_no_device_short_circuits(shared, recorder):
    notify = notify_repo()
    sent = _notify(shared, old="545000", new="544000", tokens=[], notify=notify)
    assert sent == 0
    assert recorder == []
    assert stored_markers(notify) == set()  # nothing marked when there was no one to send to


def test_expo_not_ok_still_marks_no_permanent_loss(shared, monkeypatch):
    # The blocker fix: mark REGARDLESS of send outcome, so a failed send can't leave the
    # milestone forever-unmarked (the crossing is never re-detected to retry).
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})
    notify = notify_repo()
    sent = _notify(shared, old="545000", new="544000", notify=notify)
    assert sent == 1
    assert stored_markers(notify) == {KICKOFF}  # marked even though Expo accepted nothing


def test_loan_facts_unset_sends_bare_body_no_crash(shared, recorder):
    sent = _notify(shared, old="545000", new="544000", facts=None)
    assert sent == 1
    title, body, _ = recorder[0]
    assert body == "Another mortgage milestone in the bag. Keep building! \U0001f4aa"
    assert "$" not in body  # no dollar figures when facts are unset


# --- oscillation across a boundary: mark once, never re-fire ------------------
# WHIT-301 — [A20] fail-on-revert: the once-ever dedup survives a down/up/down wobble.

def test_oscillation_across_boundary_never_refires(shared, recorder):
    repo = notify_repo()  # persists across the three polls
    # poll 1: 545k -> 544k crosses Kickoff, fires + marks Kickoff
    assert _notify(shared, old="545000", new="544000", notify=repo) == 1
    # poll 2: a market correction pushes the balance back UP over the line -> nothing
    assert _notify(shared, old="544000", new="546000", notify=repo) == 0
    # poll 3: it dips back through the SAME boundary -> crosses again, but Kickoff is marked
    assert _notify(shared, old="546000", new="544000", notify=repo) == 0
    assert len(recorder) == 1          # exactly one celebration across the whole wobble
    assert stored_markers(repo) == {KICKOFF}


# --- lump sum: furthest already fired, a nearer one still fresh ---------------
# WHIT-301 — [A22] fail-on-revert: sends the furthest FRESH (not the furthest crossed) + marks all fresh.

def test_lump_sum_sends_nearer_fresh_when_furthest_already_fired(shared, recorder):
    repo = notify_repo(fired={HALFWAY})  # Halfway (295k, the furthest) already celebrated
    # 600k -> 290k crosses Kickoff, Quarter, Halfway; only Kickoff & Quarter are fresh.
    sent = _notify(shared, old="600000", new="290000", notify=repo)
    assert sent == 1
    assert len(recorder) == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Quarter way!"  # furthest FRESH (420k)
    assert stored_markers(repo) == {KICKOFF, QUARTER, HALFWAY}  # both fresh ones now marked too


# --- loan facts present but original < new_balance: paid clamps at $0 ---------
# WHIT-301 — [A23] fail-on-revert on the max(0, ...) clamp: a misconfigured `original` (below the
# current balance) must never render a negative "$-N down" in the celebration.

def test_negative_paid_down_clamps_to_zero(shared, recorder):
    facts = {"original": 500000.0, "homeValue": 770000.0, "lvr": 0.8}
    repo = notify_repo()
    sent = _notify(shared, old="545000", new="544000", notify=repo, facts=facts)
    assert sent == 1
    _, body, _ = recorder[0]
    # paid = max(0, 500000 - 544000) = 0 -> "$0 down", never a minus sign
    assert "$0 down on your mortgage" in body
    assert "$-" not in body  # no negative dollar figure anywhere
    assert "$72,000 in equity unlocked" in body  # equity clamp still sane: 616000-544000


# --- Gap A: stale sweep AND a genuine fresh crossing in the SAME poll ------------------------


def test_reconcile_and_dedup_coexist_live_fired_not_refired(shared, recorder):
    # [G-A2] Hardest interleave: fired = {id:x:300000 (stale), id:d:480000 (LIVE + already fired)};
    # plan = [480000 id:d (already), 280000 id:h (fresh)]; a lump-sum poll crosses BOTH. The moved-up
    # `fired` read must still dedup id:d (no re-fire) while id:x:300000 is swept and id:h fires.
    notify = notify_repo({"id:x:bal:300000.00", "id:d:bal:480000.00"})
    sent = _notify(shared, old="500000", new="280000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("Deposit", "480000", id="d"), _row("House", "280000", id="h")]),
                notify=notify)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — House!"   # furthest FRESH (480000 suppressed)
    assert removed_markers(notify) == {"id:x:bal:300000.00"}
    assert stored_markers(notify) == {"id:d:bal:480000.00", "id:h:bal:280000.00"}   # id:d kept (not re-fired)


# --- Gap D: malformed / legacy "bal:" keys are swept as dead (self-heal) ---------------------

def test_malformed_bal_keys_are_swept_as_stale(shared, recorder):
    # [G-D1] Characterization: any custom-namespaced key not in the plan is dead — including garbage
    # like "bal:" (no amount) or "bal:oops", and a leftover id-less "bal:280000.00" that no row
    # keys to any more (WHIT-830). Reconcile sweeps them, keeping the live row's marker.
    notify = notify_repo({"bal:", "bal:oops", "bal:280000.00", "id:m1:bal:280000.00"})
    _notify(shared, old="285000", new="284000",
         milestone_repo=FakeMilestoneRepo(stored=[_row("House", "280000")]), notify=notify)
    assert removed_markers(notify) == {"bal:", "bal:oops", "bal:280000.00"}
    assert stored_markers(notify) == {"id:m1:bal:280000.00"}


# ==========================================================================
# --- folded from test_milestones_whit386_gaps.py (WHIT-471) ---
# ==========================================================================


def test_authoritative_empty_plan_sweeps_nothing(shared, recorder):
    # [G-386a] fail-on-revert: an authoritative [] with custom markers present must leave EVERY
    # marker intact. Revert `and plan` at shared/milestones.py and both markers get wiped → this fails.
    notify = notify_repo({"id:m1:bal:300000.00", "bal:120000.00", "0"})
    sent = _notify(shared, old="250000", new="249000",
                milestone_repo=FakeMilestoneRepo(stored=[]), notify=notify)
    assert sent == 0
    assert removed_markers(notify) == set()
    assert stored_markers(notify) == {"id:m1:bal:300000.00", "bal:120000.00", "0"}


# --- the scope seam is threaded end-to-end at the notify level -----------------------------

def test_scope_is_threaded_to_plan_read_fired_state_and_mark(shared, recorder):
    # WHIT-369 — [A-SCOPE-1] the SAME owner drives the plan read, the fired-state read, and the
    # mark. The repo-level test proves isolation; this proves notify_milestone_crossing actually
    # PASSES the caller's scope to all three seams (not None / not a hardcoded owner).
    milestone_repo = FakeMilestoneRepo(stored=[_row("My House", "480000", id="m1")])
    notify = notify_repo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=milestone_repo, scope="user-42")
    assert sent == 1
    assert milestone_repo.scopes_read == ["user-42"]     # the plan read threaded scope
    assert scopes_read(notify) == ["user-42"]            # dedup read threaded scope
    assert scopes_marked(notify) == ["user-42"]             # mark threaded the SAME scope
    assert stored_markers(notify) == {"id:m1:bal:480000.00"}


# --- a SAVED plan is used as stored, in any order ------------------------------------------

def test_out_of_order_user_plan_still_fires_furthest_and_marks_each(shared, recorder):
    # WHIT-369 — [A-ORDER-1] a user's SAVED plan is used as-is. crossed_milestones re-sorts by
    # target, so an out-of-order plan must still fire the furthest crossed and mark every one.
    plan = [_row("Mid", "300000", id="b"), _row("Far", "120000", id="c"), _row("Near", "480000", id="a")]
    notify = notify_repo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("500000"), Decimal("100000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=plan))
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Far!"  # furthest = lowest (120000)
    assert stored_markers(notify) == {
        "id:a:bal:480000.00", "id:b:bal:300000.00", "id:c:bal:120000.00"}


# --- _plan_marker: byte-stability + collision-freedom for weird amounts / ids ---------------

@pytest.mark.parametrize("milestone_id, target, expected", [
    # byte-stable however the stored amount formats, or the same target re-fires every poll
    *(("m1", tb, "id:m1:bal:480000.00")
      for tb in (Decimal("480000"), Decimal("480000.0"), Decimal("480000.00"), 480000, "480000")),
    ("m1", Decimal("1E+6"), "id:m1:bal:1000000.00"),     # scientific notation quantizes plainly
    ("0", Decimal("544000"), "id:0:bal:544000.00"),      # never the bare "0" a sprint marks
    ("a:b", Decimal("480000"), "id:a:b:bal:480000.00"),  # a colon in the id stays distinct from "a"
])
def test_plan_marker_is_byte_stable_across_decimal_and_int_and_str_formats(shared, milestone_id, target, expected):
    assert shared.milestones._plan_marker({"id": milestone_id, "targetBalance": target}) == expected


# ==========================================================================
# --- folded from test_milestone_marker_migration_whit369.py (WHIT-471) ---
# ==========================================================================

def _repo(shared):
    r = shared.notify.NotifyRepository()
    r._table = FakeTable()
    return r


def test_existing_FIRED_marker_is_read_by_the_post_whit369_none_default(shared):
    # WHIT-369 — a prior deploy celebrated built-in sprint "2" and a saved milestone, leaving
    # the fired SET at the raw historical key ("NOTIFY#MILESTONE", "FIRED"). After WHIT-369
    # the None default must still land there → both markers are seen → no re-fire.
    r = _repo(shared)
    r._table.store[("NOTIFY#MILESTONE", "FIRED")] = {
        "pk": "NOTIFY#MILESTONE", "sk": "FIRED", "fired": {"2", "id:m1:bal:480000.00"},
    }
    assert r.fired_milestones() == {"2", "id:m1:bal:480000.00"}   # None default reads the old item
    assert r.fired_milestones(scope=None) == {"2", "id:m1:bal:480000.00"}


def test_none_default_marks_into_the_same_historical_item_not_a_new_one(shared):
    # WHIT-369 — a new mark under the None default must ACCUMULATE into the historical FIRED
    # item alongside a pre-existing marker, never spawn a parallel item that splits the set.
    r = _repo(shared)
    r._table.store[("NOTIFY#MILESTONE", "FIRED")] = {
        "pk": "NOTIFY#MILESTONE", "sk": "FIRED", "fired": {"0"},
    }
    r.mark_milestone_fired("id:m1:bal:480000.00")            # no scope → shared default
    assert set(r._table.store.keys()) == {("NOTIFY#MILESTONE", "FIRED")}   # still ONE item
    assert r.fired_milestones() == {"0", "id:m1:bal:480000.00"}
