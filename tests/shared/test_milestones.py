"""Tests for the payoff-milestone celebration push (shared/milestones.py, WHIT-301).

Covers the pure crossing/equity math, the twin-table drift-pin (client<->server), and
the detector's send/dedup/mark-regardless/degrade behaviour via lightweight fake repos.
"""

from decimal import Decimal

import pytest

# The milestone fakes + FACTS + the send_push recorder live in tests/shared/_milestone_fakes.py
# so the whole milestone family shares ONE definition of each (WHIT-445).
from _milestone_fakes import (
    FACTS, FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, FakeNotifyRepo,
    _row, recorder,
)


# --- twin-table drift-pin (client <-> server) -------------------------------------------

def test_milestones_match_the_client_plan(shared):
    rows = [(m.sprint, m.label, m.target_balance) for m in shared.milestones.MILESTONES]
    assert rows == [
        (0, "Kickoff", 544000),
        (1, "Quarter way", 420000),
        (2, "Halfway", 295000),
        (3, "Three-quarters", 170000),
        (4, "Target", 55000),
    ]


def test_strictly_paid_down_invariant_fires_on_a_bad_table(shared):
    Milestone = shared.milestones.Milestone
    bad = [Milestone(0, "a", 100000), Milestone(1, "b", 200000)]  # balance goes UP
    with pytest.raises(ValueError):
        shared.milestones._assert_strictly_paid_down(bad)


# --- usable_equity ----------------------------------------------------------------------

def test_usable_equity_matches_the_client_formula(shared):
    # 770000 * 0.8 - 295000 = 321000
    assert shared.milestones.usable_equity(770000.0, 295000.0, 0.8) == 321000


def test_usable_equity_clamps_at_zero(shared):
    assert shared.milestones.usable_equity(500000.0, 500000.0, 0.8) == 0


# --- crossed_milestones (pure) ----------------------------------------------------------

def test_no_crossing_when_balance_holds_above_a_target(shared):
    assert shared.milestones.crossed_milestones(Decimal("600000"), Decimal("560000")) == []


def test_first_poll_none_crosses_nothing(shared):
    # old is None (first-ever poll / seed guard) → never fire, even far below a target.
    assert shared.milestones.crossed_milestones(None, Decimal("100000")) == []


def test_rising_balance_crosses_nothing(shared):
    assert shared.milestones.crossed_milestones(Decimal("400000"), Decimal("410000")) == []


def test_exact_boundary_landing_counts_as_crossed(shared):
    # new == target fires; the NEXT poll starting ON the boundary must not (old > target false).
    crossed = shared.milestones.crossed_milestones(Decimal("545000"), Decimal("544000"))
    assert [m.sprint for m in crossed] == [0]
    assert shared.milestones.crossed_milestones(Decimal("544000"), Decimal("543000")) == []


def test_lump_sum_jump_returns_furthest_first(shared):
    # 600k -> 290k crosses Kickoff(544k), Quarter(420k), Halfway(295k); furthest (lowest) first.
    crossed = shared.milestones.crossed_milestones(Decimal("600000"), Decimal("290000"))
    assert [m.target_balance for m in crossed] == [295000, 420000, 544000]


# --- notify_milestone_crossing ----------------------------------------------------------

def _notify(shared, *, old, new, facts=FACTS, tokens=("tok",), fired=None, notify=None,
            milestone_repo=None):
    # One wrapper for the whole milestone family (WHIT-471 fold): pass `fired` to build a fresh
    # notify repo, or `notify` to supply one you assert on; `milestone_repo` measures a saved plan.
    return shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(facts),
        device_repo=FakeDeviceRepo(tokens),
        notify_repo=notify if notify is not None else FakeNotifyRepo(fired),
        milestone_repo=milestone_repo,
    )


def test_single_crossing_sends_one_push_with_both_numbers(shared, recorder):
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]), notify_repo=notify)
    assert sent == 1
    assert len(recorder) == 1
    title, body, tokens = recorder[0]
    assert title == "\U0001f389 Milestone reached — Kickoff!"
    # paid = 600000 - 544000 = 56,000 ; equity = 770000*0.8 - 544000 = 72,000
    assert "$56,000 down on your mortgage" in body
    assert "$72,000 in equity unlocked" in body
    assert "Keep building!" in body
    assert notify.fired == {"0"}


def test_crossing_push_carries_milestone_deeplink_data(shared, monkeypatch):
    # WHIT-322: the push carries data={"type": "milestone"} so a tap opens the mortgage screen.
    captured = []
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda title, body, tokens, **kw: captured.append(kw.get("data")) or
                        {"sent": len(tokens), "ok": len(tokens), "pruned": []})
    shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]),
        notify_repo=FakeNotifyRepo())
    assert captured == [{"type": "milestone"}]


def test_lump_sum_sends_furthest_and_marks_all(shared, recorder):
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("600000"), Decimal("290000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]), notify_repo=notify)
    assert sent == 1
    assert len(recorder) == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Halfway!"  # furthest crossed (295k)
    assert notify.fired == {"0", "1", "2"}  # all three crossed are marked


def test_lump_sum_push_carries_milestone_deeplink_data(shared, monkeypatch):
    # WHIT-322 GAP — a lump-sum jump past SEVERAL milestones still sends exactly one push (the
    # furthest), and it must ALSO carry data={"type": "milestone"}. The implementer only locked
    # the single-crossing send; this guards the lump-sum branch of the same call site.
    captured = []
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda title, body, tokens, **kw: captured.append(kw.get("data")) or
                        {"sent": len(tokens), "ok": len(tokens), "pruned": []})
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("600000"), Decimal("290000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]),
        notify_repo=notify)
    assert sent == 1
    assert captured == [{"type": "milestone"}]  # one push, carrying the deep-link tag
    assert notify.fired == {"0", "1", "2"}       # all crossed still marked


def test_already_fired_milestone_does_not_resend(shared, recorder):
    sent = _notify(shared, old="545000", new="544000", fired={"0"})
    assert sent == 0
    assert recorder == []


def test_no_device_short_circuits(shared, recorder):
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo([]), notify_repo=notify)
    assert sent == 0
    assert recorder == []
    assert notify.fired == set()  # nothing marked when there was no one to send to


def test_expo_not_ok_still_marks_no_permanent_loss(shared, monkeypatch):
    # The blocker fix: mark REGARDLESS of send outcome, so a failed send can't leave the
    # milestone forever-unmarked (the crossing is never re-detected to retry).
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(["tok"]), notify_repo=notify)
    assert sent == 1
    assert notify.fired == {"0"}  # marked even though Expo accepted nothing


def test_loan_facts_unset_sends_bare_body_no_crash(shared, recorder):
    sent = _notify(shared, old="545000", new="544000", facts=None)
    assert sent == 1
    title, body, _ = recorder[0]
    assert body == "Another mortgage milestone in the bag. Keep building! \U0001f4aa"
    assert "$" not in body  # no dollar figures when facts are unset


def test_first_poll_none_sends_nothing(shared, recorder):
    assert _notify(shared, old=None, new="100000") == 0
    assert recorder == []


# ==========================================================================
# --- folded from test_milestones_gaps.py (WHIT-471) ---
# ==========================================================================


# --- oscillation across a boundary: mark once, never re-fire ------------------
# WHIT-301 — [A20] fail-on-revert: the once-ever dedup survives a down/up/down wobble.

def test_oscillation_across_boundary_never_refires(shared, recorder):
    repo = FakeNotifyRepo()  # persists across the three polls
    # poll 1: 545k -> 544k crosses Kickoff, fires + marks "0"
    assert _notify(shared, old="545000", new="544000", notify=repo) == 1
    # poll 2: a market correction pushes the balance back UP over the line -> nothing
    assert _notify(shared, old="544000", new="546000", notify=repo) == 0
    # poll 3: it dips back through the SAME boundary -> crosses again, but "0" is marked
    assert _notify(shared, old="546000", new="544000", notify=repo) == 0
    assert len(recorder) == 1          # exactly one celebration across the whole wobble
    assert repo.fired == {"0"}


# --- Decimal-with-cents vs int target at the >= boundary ----------------------
# WHIT-301 — [A21] fail-on-revert on the `>=` (exact-cents landing counts). [A21b] a cent above is a
# boundary characterization of the strict side (guards against a sloppier mutation like rounding new).

def test_cents_exactly_on_target_counts_as_crossed(shared):
    crossed = shared.milestones.crossed_milestones(Decimal("296000"), Decimal("295000.00"))
    assert [m.sprint for m in crossed] == [2]  # Halfway, landed exactly


def test_one_cent_above_target_is_not_yet_crossed(shared):
    assert shared.milestones.crossed_milestones(Decimal("296000"), Decimal("295000.01")) == []


# --- lump sum: furthest already fired, a nearer one still fresh ---------------
# WHIT-301 — [A22] fail-on-revert: sends the furthest FRESH (not the furthest crossed) + marks all fresh.

def test_lump_sum_sends_nearer_fresh_when_furthest_already_fired(shared, recorder):
    repo = FakeNotifyRepo(fired={"2"})  # Halfway (295k, the furthest) already celebrated
    # 600k -> 290k crosses Kickoff(0), Quarter(1), Halfway(2); only 0 & 1 are fresh.
    sent = _notify(shared, old="600000", new="290000", notify=repo)
    assert sent == 1
    assert len(recorder) == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Quarter way!"  # furthest FRESH (420k)
    assert repo.fired == {"0", "1", "2"}  # both fresh ones now marked too


# --- loan facts present but original < new_balance: paid clamps at $0 ---------
# WHIT-301 — [A23] fail-on-revert on the max(0, ...) clamp: a misconfigured `original` (below the
# current balance) must never render a negative "$-N down" in the celebration.

def test_negative_paid_down_clamps_to_zero(shared, recorder):
    facts = {"original": 500000.0, "homeValue": 770000.0, "lvr": 0.8}
    repo = FakeNotifyRepo()
    sent = _notify(shared, old="545000", new="544000", notify=repo, facts=facts)
    assert sent == 1
    _, body, _ = recorder[0]
    # paid = max(0, 500000 - 544000) = 0 -> "$0 down", never a minus sign
    assert "$0 down on your mortgage" in body
    assert "$-" not in body  # no negative dollar figure anywhere
    assert "$72,000 in equity unlocked" in body  # equity clamp still sane: 616000-544000


# --- usable_equity half-dollar rounding: half-up, matches the TS twin (WHIT-307) ---
# WHIT-307 — fail-on-revert on math.floor(x + 0.5): a half-dollar rounds UP, matching the
# client twin's Math.round. Reverting to Python's built-in round() (banker's) turns 0.5 -> 0
# and 2.5 -> 2 and trips this.

def test_usable_equity_rounds_half_dollar_up_like_the_client_twin(shared):
    # 3.0*0.5 = 1.5 -> half-up -> 2 (Math.round(1.5) === 2; agrees with banker's here too)
    assert shared.milestones.usable_equity(3.0, 0.0, 0.5) == 2
    # 1.0*0.5 = 0.5 -> half-up -> 1 (Math.round(0.5) === 1); built-in round() would give 0.
    assert shared.milestones.usable_equity(1.0, 0.0, 0.5) == 1
    # 5.0*0.5 = 2.5 -> half-up -> 3 (Math.round(2.5) === 3); built-in round() would give 2.
    assert shared.milestones.usable_equity(5.0, 0.0, 0.5) == 3


# ==========================================================================
# --- folded from test_milestones_whit385_gaps.py (WHIT-471) ---
# ==========================================================================


# --- Gap A: stale sweep AND a genuine fresh crossing in the SAME poll ------------------------

def test_stale_swept_and_fresh_crossing_fires_same_poll(shared, recorder):
    # [G-A1] milestone m1 was re-targeted 300000 → 280000; its old "id:m1:bal:300000.00" marker is
    # stale and the plan now points at 280000, which this poll crosses. Reconcile must sweep the
    # dead key AND the fresh crossing must fire — the swept key must NOT be re-added by the mark.
    notify = FakeNotifyRepo({"id:m1:bal:300000.00"})
    sent = _notify(shared, old="285000", new="280000",
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
    sent = _notify(shared, old="500000", new="280000",
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
    sent = _notify(shared, old=None, new="250000",
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
    _notify(shared, old="285000", new="284000",
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
    _notify(shared, old="285000", new="284000",
         milestone_repo=FakeMilestoneRepo(stored=[legacy_row]), notify=notify)
    assert notify.removed == {"bal:", "bal:oops"}
    assert notify.fired == {"bal:280000.00"}


# --- Gap E: reconcile runs BEFORE the device-token check -------------------------------------

def test_reconcile_runs_even_when_no_device_tokens(shared, recorder):
    # [G-E1] No device registered. Reconcile is placed before crossed/dedup/token checks, so a dead
    # marker is still swept even though a would-be fresh crossing sends nothing (and isn't marked).
    notify = FakeNotifyRepo({"bal:300000.00"})
    sent = _notify(shared, old="285000", new="280000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("House", "280000")]),
                notify=notify, tokens=())
    assert sent == 0
    assert recorder == []
    assert notify.removed == {"bal:300000.00"}   # reconcile happened before the token short-circuit
    assert notify.fired == set()                 # fresh crossing NOT marked (returned at token check)


# ==========================================================================
# --- folded from test_milestones_whit386_gaps.py (WHIT-471) ---
# ==========================================================================


def test_authoritative_empty_plan_sweeps_nothing(shared, recorder):
    # [G-386a] fail-on-revert: an authoritative [] with custom markers present must leave EVERY
    # marker intact and never call remove_milestone_markers (the guard short-circuits before any
    # delete I/O). Revert `and plan` at shared/milestones.py and both markers get wiped → this fails.
    notify = FakeNotifyRepo({"id:m1:bal:300000.00", "bal:120000.00", "0"})
    sent = _notify(shared, old="250000", new="249000",
                milestone_repo=FakeMilestoneRepo(stored=[]), notify=notify)
    assert sent == 0
    assert notify.removed == set()
    assert notify.remove_calls == 0
    assert notify.fired == {"id:m1:bal:300000.00", "bal:120000.00", "0"}


def test_populated_plan_still_sweeps_a_dead_marker(shared, recorder):
    # [G-386b] regression: the guard must NOT disable legitimate self-heal. A populated authoritative
    # plan (one row) with a dead custom marker still reconciles it away, exactly as WHIT-385 does.
    notify = FakeNotifyRepo({"id:m1:bal:300000.00"})
    _notify(shared, old="250000", new="249000",
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
    sent = _notify(shared, old="545000", new="544000",
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
    sent = _notify(shared, old="250000", new="249000",
                milestone_repo=FakeMilestoneRepo(stored=[]), notify=notify)
    assert sent == 0
    assert notify.read_calls == 0          # short-circuited before ANY notify I/O
    assert notify.remove_calls == 0


# ==========================================================================
# --- folded from test_milestones_whit369_gaps.py (WHIT-471) ---
# ==========================================================================

# --- the scope seam is threaded end-to-end at the notify level -----------------------------

def test_scope_is_threaded_to_plan_read_fired_state_and_mark(shared, recorder):
    # WHIT-369 — [A-SCOPE-1] the SAME owner drives the plan read, the fired-state read, and the
    # mark. The repo-level test proves isolation; this proves notify_milestone_crossing actually
    # PASSES the caller's scope to all three seams (not None / not a hardcoded owner).
    milestone_repo = FakeMilestoneRepo(stored=[_row("My House", "480000", id="m1")])
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=milestone_repo, scope="user-42")
    assert sent == 1
    assert milestone_repo.scopes_read == ["user-42"]     # resolve_plan threaded scope
    assert notify.fired_scopes == ["user-42"]            # dedup read threaded scope
    assert notify.mark_scopes == ["user-42"]             # mark threaded the SAME scope
    assert notify.fired == {"id:m1:bal:480000.00"}


def test_scope_none_default_threads_none_to_every_seam(shared, recorder):
    # WHIT-369 — [A-SCOPE-2] the single-tenant default: omitting scope threads None everywhere,
    # so the repo's own "SHARED" default owns both the plan and the fired-state. Guards against a
    # future edit hardcoding one side to a literal that the other doesn't share.
    milestone_repo = FakeMilestoneRepo(stored=[_row("My House", "480000", id="m1")])
    notify = FakeNotifyRepo()
    shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=milestone_repo)  # no scope
    assert milestone_repo.scopes_read == [None]
    assert notify.fired_scopes == [None]
    assert notify.mark_scopes == [None]


def test_dedup_read_is_scoped_so_another_owners_marker_does_not_suppress(shared, recorder):
    # WHIT-369 — [A-SCOPE-3] a marker already fired but read back under the caller's scope still
    # suppresses; the seam must not leak a different owner's fired-state. Here the SAME key is
    # pre-seeded and the caller's scope reads it → no resend.
    notify = FakeNotifyRepo(fired={"id:m1:bal:480000.00"})
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "480000")]),
        scope="user-42")
    assert sent == 0
    assert notify.fired_scopes == ["user-42"]  # the read that suppressed used the caller's scope


# --- mark-regardless-of-send-outcome survives scope threading, across a lump sum ------------

def test_marks_all_fresh_regardless_of_send_outcome_under_a_scope(shared, monkeypatch):
    # WHIT-369 — [A-MARK-1] Expo accepted NOTHING (ok:0) on a lump-sum jump past two custom
    # targets. Every fresh milestone must still be marked, each under the caller's scope — a
    # transient outage must not leave a crossing forever-unmarked (never re-detected).
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})
    notify = FakeNotifyRepo()
    plan = [_row("Deposit", "480000", id="a"), _row("Halfway", "300000", id="b")]
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("500000"), Decimal("290000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=plan), scope="u1")
    assert sent == 1
    assert notify.fired == {"id:a:bal:480000.00", "id:b:bal:300000.00"}  # both marked
    assert notify.mark_scopes == ["u1", "u1"]                            # both under the scope


# --- a SAVED plan is NOT guarded by the strictly-paid-down import assert --------------------

def test_out_of_order_user_plan_still_fires_furthest_and_marks_each(shared, recorder):
    # WHIT-369 — [A-ORDER-1] _assert_strictly_paid_down only guards the built-in default at
    # import; a user's SAVED plan is used as-is. crossed_milestones re-sorts by target, so an
    # out-of-order plan must still fire the furthest crossed and mark every crossed one.
    plan = [_row("Mid", "300000", id="b"), _row("Far", "120000", id="c"), _row("Near", "480000", id="a")]
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("500000"), Decimal("100000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=plan))
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Far!"  # furthest = lowest (120000)
    assert notify.fired == {
        "id:a:bal:480000.00", "id:b:bal:300000.00", "id:c:bal:120000.00"}


# --- _plan_marker: byte-stability + collision-freedom for weird amounts / ids ---------------

def test_plan_marker_is_byte_stable_across_decimal_and_int_and_str_formats(shared):
    # WHIT-369 — [A-MARK-2] the marker must be identical however the stored amount formats, or
    # the same target re-fires every poll. int / str / trailing-zero Decimals all collapse.
    m = shared.milestones._plan_marker
    for tb in (Decimal("480000"), Decimal("480000.0"), Decimal("480000.00"), 480000, "480000"):
        assert m({"id": "m1", "targetBalance": tb}) == "id:m1:bal:480000.00"


def test_plan_marker_normalizes_scientific_notation(shared):
    # WHIT-369 — [A-MARK-3] a Decimal that stringifies as "1E+6" must quantize to a plain
    # "1000000.00" marker, not "1E+6", so it stays byte-stable across polls.
    assert shared.milestones._plan_marker(
        {"id": "m1", "targetBalance": Decimal("1E+6")}) == "id:m1:bal:1000000.00"


def test_plan_marker_numeric_string_id_cannot_collide_with_a_sprint_marker(shared):
    # WHIT-369 — [A-MARK-4] a saved milestone whose id is the string "0" must NOT produce the
    # bare "0" a built-in Kickoff sprint marks — the "id:...:bal:..." envelope keeps them apart.
    marker = shared.milestones._plan_marker({"id": "0", "targetBalance": Decimal("544000")})
    assert marker == "id:0:bal:544000.00"
    assert marker not in {"0", "1", "2", "3", "4"}


def test_plan_marker_id_with_a_colon_stays_distinct(shared):
    # WHIT-369 — [A-MARK-5] an id containing the ':' separator must not smear into a neighbour's
    # marker. "a:b" and "a" at the same amount stay distinct.
    m = shared.milestones._plan_marker
    a = m({"id": "a:b", "targetBalance": Decimal("480000")})
    b = m({"id": "a", "targetBalance": Decimal("480000")})
    assert a == "id:a:b:bal:480000.00"
    assert a != b


def test_plan_marker_missing_and_explicit_none_id_both_fall_back_to_amount(shared):
    # WHIT-369 — [A-MARK-6] a legacy row with no id, and a row with an explicit id=None, both
    # degrade to the amount-only marker rather than raising (a raise would be swallowed by the
    # poller into a silently-lost celebration).
    m = shared.milestones._plan_marker
    assert m({"targetBalance": Decimal("480000")}) == "bal:480000.00"
    assert m({"id": None, "targetBalance": Decimal("480000")}) == "bal:480000.00"


# ==========================================================================
# --- folded from test_milestone_marker_migration_whit369.py (WHIT-471) ---
# ==========================================================================

class _FakeTable:
    def __init__(self):
        self.store = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        item = self.store.setdefault((Key["pk"], Key["sk"]), {"pk": Key["pk"], "sk": Key["sk"]})
        f = ExpressionAttributeNames["#f"]
        item[f] = set(item.get(f, set())) | ExpressionAttributeValues[":m"]


def _repo(shared):
    r = shared.notify.NotifyRepository()
    r._table = _FakeTable()
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
