"""WHIT-384 / WHIT-369 — the milestone celebration push reads the user's SAVED plan.

Covers the resolve-plan fallback (unset / read-failure → built-in default), a custom plan
firing on the user's own targets/labels, the "id:<id>:bal:<amount>" dedup marker (WHIT-369:
key by permanent id AND amount, so reorder/delete can't repeat or drop an alert while
re-pointing a target still re-arms it), the re-target re-arm, and cent-exact custom
boundaries. The no-saved-plan / default path stays covered by test_milestones.py (its callers
omit milestone_repo → None → default), which is itself the no-regression guard.
"""

import logging
from decimal import Decimal

import pytest

# Shared milestone fakes + FACTS + _row + recorder (WHIT-445). RaisingNotifyRepo below
# subclasses the imported FakeNotifyRepo.
from _milestone_fakes import (
    FACTS, FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, FakeNotifyRepo, _row, recorder,
)
from _milestone_row_fakes import _GOOD, _KEEP_MARKER, _row as _row_kw


def _notify(shared, *, old, new, milestone_repo=None, stored=None, facts=FACTS,
            fired=None, notify=None, scope=None):
    # One wrapper for the whole custom-plan family (WHIT-472 fold). Give `milestone_repo`
    # directly OR `stored` (wrapped in a FakeMilestoneRepo). `fired` builds a fresh notify repo;
    # `notify` supplies one you assert on. `facts=None` for the empty-loanfacts (live) cases.
    # Returns (sent, notify).
    notify = notify if notify is not None else FakeNotifyRepo(fired)
    repo = FakeMilestoneRepo(stored) if stored is not None else milestone_repo
    sent = shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(facts),
        device_repo=FakeDeviceRepo(),
        notify_repo=notify,
        milestone_repo=repo,
        scope=scope,
    )
    return sent, notify


def _sweep(shared, stored, fired):
    """A no-crossing poll (balance far above every target): the WHIT-385 sweep runs alone.
    Returns the notify fake."""
    _, notify = _notify(shared, old="900000", new="850000", stored=stored, facts=None, fired=fired)
    return notify


# --- resolve_plan --------------------------------------------------------------------------

def test_resolve_plan_none_repo_is_the_default(shared):
    assert shared.milestones.resolve_plan(None) == list(shared.milestones.MILESTONES)


def test_resolve_plan_unset_is_an_empty_plan(shared):
    # The user sets their own milestones now — an UNSET plan resolves to EMPTY (celebrate nothing),
    # NOT the built-in default. (A READ FAILURE / None repo still defaults — see the tests below.)
    assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored=None)) == []


def test_resolve_plan_read_failure_falls_back_to_the_default(shared):
    # Any read error must degrade to the built-in default, never propagate (which the poller's
    # outer except would turn into a silently-skipped celebration).
    plan = shared.milestones.resolve_plan(FakeMilestoneRepo(raises=RuntimeError("dynamo down")))
    assert plan == list(shared.milestones.MILESTONES)


def test_resolve_plan_maps_a_saved_plan_to_namespaced_decimal_rows(shared):
    stored = [_row("My House", "480000")]
    plan = shared.milestones.resolve_plan(FakeMilestoneRepo(stored=stored))
    assert len(plan) == 1
    assert plan[0].label == "My House"
    assert plan[0].target_balance == Decimal("480000")
    assert plan[0].key == "id:m1:bal:480000.00"  # permanent id + cent-quantized amount


# --- notify against a custom plan ----------------------------------------------------------

def test_custom_plan_fires_on_the_users_own_target_and_label(shared, recorder):
    repo = FakeMilestoneRepo(stored=[_row("My House", "480000")])
    sent, _ = _notify(shared, old="490000", new="480000", milestone_repo=repo)
    assert sent == 1
    title, _body, _tokens = recorder[0]
    assert title == "\U0001f389 Milestone reached — My House!"


def test_custom_plan_does_not_fire_on_a_default_balance(shared, recorder):
    # A saved plan that excludes 544000: crossing the OLD built-in Kickoff must NOT fire —
    # proves the push stopped reading the hardcoded table (fail-on-revert on the whole card).
    repo = FakeMilestoneRepo(stored=[_row("My House", "480000")])
    sent, _ = _notify(shared, old="545000", new="544000", milestone_repo=repo)
    assert sent == 0
    assert recorder == []


def test_custom_marker_is_namespaced_so_it_cannot_collide_with_a_sprint_marker(shared, recorder):
    notify = FakeNotifyRepo()
    shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "480000")]))
    assert notify.fired == {"id:m1:bal:480000.00"}  # not "0".."4"


def test_dedup_skips_an_already_fired_custom_milestone(shared, recorder):
    repo = FakeMilestoneRepo(stored=[_row("My House", "480000")])
    sent, _ = _notify(shared, old="490000", new="480000", milestone_repo=repo, fired={"id:m1:bal:480000.00"})
    assert sent == 0
    assert recorder == []


def test_retarget_rearms_the_celebration(shared, recorder):
    # Decision (WHIT-369): key by permanent id AND amount. Same milestone id already crossed &
    # marked at 300000, then re-pointed to 280000 → the amount is part of the marker, so the
    # new target is a fresh marker and fires again when the balance crosses it.
    repo = FakeMilestoneRepo(stored=[_row("My House", "280000")])  # id defaults to "m1"
    sent, _ = _notify(shared, old="290000", new="280000", milestone_repo=repo, fired={"id:m1:bal:300000.00"})
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — My House!"


# --- WHIT-369: id-keyed dedup survives reorder / delete / same-amount collisions -----------

def test_reorder_does_not_refire_or_drop(shared, recorder):
    # Two saved targets; the further one (id "b", 300000) was already celebrated. Reordering the
    # list must NOT re-fire it (dedup keys on the permanent id, not list position) and must NOT
    # drop the un-fired one (id "a", 480000) — that one fires. Fail-on-revert for the whole card:
    # amount-only keying wouldn't match the seeded "id:b:..." marker, so B would wrongly re-fire.
    notify = FakeNotifyRepo(fired={"id:b:bal:300000.00"})
    reordered = [_row("B", "300000", id="b"), _row("A", "480000", id="a")]
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("295000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=reordered))
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — A!"
    assert notify.fired == {"id:b:bal:300000.00", "id:a:bal:480000.00"}


def test_delete_then_readd_same_amount_fires_under_a_new_id(shared, recorder):
    # A milestone at 480000 (id "old") was celebrated; the user deletes it and adds a NEW target
    # at the SAME amount (fresh id "new"). Amount-only keying would swallow it forever; id-keying
    # fires it because the id differs. The WHIT-385 reconcile also sweeps the deleted milestone's
    # now-dead "id:old" marker in the same poll, so only the live "id:new" marker remains.
    notify = FakeNotifyRepo(fired={"id:old:bal:480000.00"})
    readded = [_row("My House again", "480000", id="new")]
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=readded))
    assert sent == 1
    assert notify.removed == {"id:old:bal:480000.00"}  # dead marker swept by reconcile
    assert notify.fired == {"id:new:bal:480000.00"}    # only the live marker remains


def test_two_targets_at_the_same_amount_get_distinct_markers(shared, recorder):
    # Two milestones at the same 300000 target but different ids crossed together → both marked
    # under distinct id-markers. Amount-only keying collides them into one shared marker.
    notify = FakeNotifyRepo()
    plan = [_row("First", "300000", id="one"), _row("Second", "300000", id="two")]
    shared.milestones.notify_milestone_crossing(
        Decimal("310000"), Decimal("300000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=plan))
    assert notify.fired == {"id:one:bal:300000.00", "id:two:bal:300000.00"}


def test_legacy_row_without_id_falls_back_to_amount_marker(shared, recorder):
    # A row saved before ids were minted (WHIT-378) has no "id" — the marker degrades to the
    # amount-only form rather than raising (which the poller's outer except would swallow into a
    # silently-lost celebration).
    # The date is a real one because WHIT-417 made the poller reject unparsable dates; this test
    # is about the id fallback, and a null date here would fail it for the wrong reason.
    legacy = [{"label": "Old", "targetBalance": Decimal("480000"), "targetDate": "2030-01-01"}]
    notify = FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=legacy))
    assert sent == 1
    assert notify.fired == {"bal:480000.00"}


def test_cent_exact_custom_boundary(shared):
    # The raw-Decimal path preserves cents: crossing 295000.01 counts; 295000.02 does not.
    plan = shared.milestones.resolve_plan(FakeMilestoneRepo(stored=[_row("Halfway", "295000.01")]))
    assert [m.target_balance for m in shared.milestones.crossed_milestones(Decimal("296000"), Decimal("295000.01"), plan)] == [Decimal("295000.01")]
    assert shared.milestones.crossed_milestones(Decimal("296000"), Decimal("295000.02"), plan) == []


# --- fallback still celebrates from the default --------------------------------------------

def test_read_failure_still_celebrates_from_the_default(shared, recorder):
    # The MAJOR case: a milestones-store hiccup must fall back to the default AND still fire.
    repo = FakeMilestoneRepo(raises=RuntimeError("dynamo down"))
    sent, _ = _notify(shared, old="545000", new="544000", milestone_repo=repo)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Kickoff!"


def test_no_plan_celebrates_nothing(shared, recorder):
    # A user who has never saved a plan (unset) now resolves to an EMPTY plan, so a paydown that
    # would have crossed the old default's Sprint 0 fires NOTHING — no pushes for a plan they
    # never set. Fail-on-revert: the old unset->default would fire the bare sprint marker "0".
    notify = FakeNotifyRepo()
    shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=None))
    assert notify.fired == set()


# --- WHIT-385: reconcile dead custom markers ------------------------------------------------
# The set of "bal:<amount>" celebration markers must not grow forever when a user re-targets a
# milestone. On each poll, drop markers whose target is no longer in the saved plan — but ONLY
# when the plan read was authoritative (a genuine saved list). A read failure / unset / None repo
# falls back to the built-in default and must delete NOTHING, or a transient blip would wipe the
# once-ever "already celebrated" record.


def test_retarget_drops_the_dead_marker(shared, recorder):
    # Core fail-on-revert: a milestone re-pointed 300000 → 280000 leaves a dead "bal:300000.00"
    # marker. A poll that crosses nothing still reconciles it away. Revert the reconcile and the
    # dead key survives → this fails.
    notify = FakeNotifyRepo({"bal:300000.00"})
    sent, _ = _notify(shared, old="285000", new="284000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert sent == 0
    assert notify.removed == {"bal:300000.00"}
    assert notify.fired == set()


def test_read_failure_does_not_delete_any_marker(shared, recorder):
    # BLOCKER guard, fail-on-revert: a milestones-store read failure falls back to the default
    # plan (no "bal:" keys). Reconciling against it would treat EVERY live custom marker as dead
    # and delete it. Authoritative-only reconcile must delete nothing here.
    notify = FakeNotifyRepo({"bal:300000.00", "bal:480000.00"})
    sent, _ = _notify(shared, old="250000", new="249000",
                milestone_repo=FakeMilestoneRepo(raises=RuntimeError("dynamo down")), notify=notify)
    assert sent == 0
    assert notify.removed == set()
    assert notify.fired == {"bal:300000.00", "bal:480000.00"}


def test_unset_plan_does_not_delete_markers(shared, recorder):
    # An unset plan (stored is None) now resolves to an AUTHORITATIVE EMPTY plan, but custom markers
    # are still left intact: the WHIT-386 `authoritative and plan` sweep short-circuits on the empty
    # (falsy) plan, so nothing is swept — a no-plan user's once-ever record survives.
    notify = FakeNotifyRepo({"bal:300000.00"})
    _notify(shared, old="250000", new="249000",
         milestone_repo=FakeMilestoneRepo(stored=None), notify=notify)
    assert notify.removed == set()
    assert notify.fired == {"bal:300000.00"}


def test_none_repo_does_not_delete_markers(shared, recorder):
    # No repo at all (pre-WHIT-384 callers) → default plan, non-authoritative → no deletion.
    notify = FakeNotifyRepo({"bal:300000.00"})
    _notify(shared, old="250000", new="249000", milestone_repo=None, notify=notify)
    assert notify.removed == set()
    assert notify.fired == {"bal:300000.00"}


def test_empty_saved_plan_does_not_wipe_markers(shared, recorder):
    # WHIT-386: an authoritative empty plan ([]) sweeps NOTHING — defence in depth so a regressed
    # empty-save guard can't erase the once-ever "already celebrated" record in one sweep. Every
    # marker survives, including custom "bal:" ones (they linger harmlessly — nothing re-fires them).
    notify = FakeNotifyRepo({"bal:300000.00", "bal:120000.00", "0"})
    sent, _ = _notify(shared, old="250000", new="249000",
                milestone_repo=FakeMilestoneRepo(stored=[]), notify=notify)
    assert sent == 0
    assert notify.removed == set()
    assert notify.fired == {"bal:300000.00", "bal:120000.00", "0"}


def test_reconcile_preserves_builtin_sprint_markers(shared, recorder):
    # Sprint markers ("0".."4") never carry the "bal:" prefix, so reconcile leaves them alone even
    # while dropping a dead custom marker.
    notify = FakeNotifyRepo({"0", "1", "bal:300000.00"})
    _notify(shared, old="285000", new="284000",
         milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert notify.removed == {"bal:300000.00"}
    assert notify.fired == {"0", "1"}


def test_reconcile_no_delete_when_marker_still_live(shared, recorder):
    # The saved target still matches the marker → nothing stale → remove is never called (the
    # empty-guard would assert if it were).
    notify = FakeNotifyRepo({"id:m1:bal:280000.00"})
    _notify(shared, old="285000", new="284000",
         milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert notify.removed == set()
    assert notify.fired == {"id:m1:bal:280000.00"}


def test_reconcile_preserves_the_once_ever_dedup_for_a_live_marker(shared, recorder):
    # Moving the fired read above the "nothing crossed" short-circuit must not break dedup: a live
    # marker whose target is crossed again must NOT re-fire.
    notify = FakeNotifyRepo({"id:m1:bal:280000.00"})
    sent, _ = _notify(shared, old="285000", new="280000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert sent == 0
    assert recorder == []
    assert notify.removed == set()


def test_reconcile_write_error_does_not_suppress_celebration(shared, recorder):
    # Reconcile is best-effort bookkeeping placed BEFORE the send: a marker DELETE blip must not
    # eat a genuine celebration (the crossing is never re-detected once the balance passes it).
    # Fail-on-revert: drop the try/except and this raises out of notify instead of sending.
    # The seeded "bal:300000.00" is a dead legacy marker (not the live "id:m1:..."), so reconcile
    # tries to delete it → the fake raises → the celebration must still proceed.
    class RaisingNotifyRepo(FakeNotifyRepo):
        def remove_milestone_markers(self, keys, scope=None):
            raise RuntimeError("dynamo down")

    notify = RaisingNotifyRepo({"bal:300000.00"})
    sent, _ = _notify(shared, old="290000", new="280000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — My House!"
    assert "id:m1:bal:280000.00" in notify.fired  # the fresh crossing is still marked fired


# ==========================================================================
# --- folded from test_milestones_custom_plan_gaps.py (WHIT-472) ---
# ==========================================================================


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

def test_resolve_plan_unset_and_empty_list_both_resolve_empty(shared):
    # Both an empty stored LIST and an UNSET (None) plan now resolve to [] — a user with no
    # milestones celebrates nothing either way. (A READ FAILURE still defaults; see above.)
    assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored=[])) == []
    assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored=None)) == []


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
    # its record (pinned by test_an_unreadable_target_with_no_readable_id_still_loses_its_marker,
    # in the live-keys block above). Proves the sweep runs without a crash.
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


# ==========================================================================
# --- folded from test_milestones_resolve_gaps.py (WHIT-472) ---
# ==========================================================================


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


# ==========================================================================
# --- folded from test_milestones_live_keys_gaps.py (WHIT-472) ---
# ==========================================================================


# --- [L1] liveness depends on ONE field: can the row be keyed? ---------------

_UNREADABLE_BUT_KEYABLE = [
    ("blank label (WHIT-394)", {"label": "   "}),
    ("missing label", {"label": None}),
    ("non-text label", {"label": 42}),
    ("unparsable date (WHIT-417)", {"targetDate": "not-a-date"}),
    ("null date", {"targetDate": None}),
    ("iso datetime", {"targetDate": "2030-01-01T00:00:00"}),
    ("both label and date broken", {"label": "", "targetDate": ""}),
]


@pytest.mark.parametrize("why, broken", _UNREADABLE_BUT_KEYABLE,
                         ids=[c[0] for c in _UNREADABLE_BUT_KEYABLE])
def test_any_rejection_other_than_the_target_leaves_the_marker_alone(shared, recorder, why, broken):
    # [L1] The rule the change installs: a row we can KEY is a row the user still has, so its
    # "already celebrated" record survives whatever else about it we can't read. Every rejection
    # the read path has today, and any it gains later, has to land here — the alternative is the
    # bug WHIT-417 fixed, where each new rejection silently re-armed a celebration.
    # Fail-on-revert (two ways): rebuild the live set from `plan`, or move `_plan_marker` back
    # below row_date/row_text — either makes every row here lose its marker.
    bad = _row_kw(id="x", targetBalance=Decimal("250000"), **broken)
    marker = "id:x:bal:250000.00"

    notify = _sweep(shared, [_GOOD, bad], fired={_KEEP_MARKER, marker})

    assert notify.removed == set(), why
    assert notify.fired == {_KEEP_MARKER, marker}, why


_UNKEYABLE = [
    ("missing targetBalance", {"targetBalance": None, "drop": True}),
    ("non-numeric target", {"targetBalance": "oops"}),
    ("null target", {"targetBalance": None}),
    ("NaN target", {"targetBalance": Decimal("NaN")}),
    ("target too large to quantize", {"targetBalance": Decimal("1e26")}),
]


@pytest.mark.parametrize("why, broken", _UNKEYABLE, ids=[c[0] for c in _UNKEYABLE])
def test_an_unreadable_target_with_a_readable_id_keeps_its_marker(shared, recorder, why, broken):
    # [L1] WHIT-424: a row whose target amount is unreadable but whose id we CAN read is still a
    # row the user has — we just can't rebuild its exact marker (the marker embeds the amount). So
    # every "id:<row id>:" marker it fired stays live via the id prefix rather than being swept as
    # if the row were deleted, closing the double-celebration that a repair + re-cross would open.
    # This is the case that USED to lose its record.
    # Fail-on-revert (two ways): drop the _row_id_prefix registration in _resolve_plan's except
    # branch, or rebuild liveness from `plan` — either makes every row here lose its marker.
    broken = dict(broken)
    drop = broken.pop("drop", False)
    bad = _row_kw(id="x", **broken)
    if drop:
        bad.pop("targetBalance")
    marker = "id:x:bal:250000.00"          # written back when the target was still readable

    notify = _sweep(shared, [_GOOD, bad], fired={_KEEP_MARKER, marker})

    assert notify.removed == set(), why
    assert notify.fired == {_KEEP_MARKER, marker}, why


# The other half of the WHIT-424 asymmetry: an unreadable target AND no readable id. There is no
# exact key (target gone) and no "id:<id>:" prefix (id gone), so nothing matches — the marker is
# swept, keeping the original "not in the plan -> gone" behaviour. The legacy amount-only marker
# each row once wrote depends on its id shape, so it is spelled out per case rather than rebuilt.
_UNKEYABLE_AND_UNNAMEABLE = [
    ("no id key (legacy row)", {"pop_id": True}, "bal:250000.00"),
    ("null id", {"id": None}, "bal:250000.00"),
    ("blank id", {"id": ""}, "id::bal:250000.00"),
    ("non-str id", {"id": 42}, "id:42:bal:250000.00"),
]


@pytest.mark.parametrize("why, id_shape, once_written", _UNKEYABLE_AND_UNNAMEABLE,
                         ids=[c[0] for c in _UNKEYABLE_AND_UNNAMEABLE])
def test_an_unreadable_target_with_no_readable_id_still_loses_its_marker(
        shared, recorder, why, id_shape, once_written):
    # [L1] The accepted cost, still pinned. A row that is BOTH unreadable-target and unnameable has
    # no honest way to keep its record, so it is swept — the deliberate line WHIT-424 drew: keep it
    # when the id reads, lose it when it doesn't. A readable id, per the save endpoint, is a
    # non-empty string; None / blank / non-str all fall back to "gone".
    # Fail-on-revert: if _row_id_prefix returned a prefix for one of these, its marker would
    # survive and this goes red.
    id_shape = dict(id_shape)
    pop_id = id_shape.pop("pop_id", False)
    bad = _row_kw(targetBalance="oops", **id_shape)
    if pop_id:
        bad.pop("id")

    notify = _sweep(shared, [_GOOD, bad], fired={_KEEP_MARKER, once_written})

    assert notify.removed == {once_written}, why
    assert notify.fired == {_KEEP_MARKER}, why


# --- [L2] a keyable row is not immune: "gone" still means gone ---------------

_STILL_GONE = [
    # (why, the stored row that replaced it, the marker that must still be swept)
    ("re-targeted 300000 -> 250000",
     {"id": "x", "targetBalance": Decimal("250000")}, "id:x:bal:300000.00"),
    ("deleted and re-added under a new id",
     {"id": "new", "targetBalance": Decimal("300000")}, "id:old:bal:300000.00"),
    ("legacy row given an id on its first save (WHIT-369/378)",
     {"id": "minted", "targetBalance": Decimal("300000")}, "bal:300000.00"),
    ("re-targeted AND re-identified",
     {"id": "new", "targetBalance": Decimal("250000")}, "id:old:bal:300000.00"),
]


@pytest.mark.parametrize("why, replacement, dead_marker", _STILL_GONE,
                         ids=[c[0] for c in _STILL_GONE])
def test_an_unreadable_row_does_not_hoard_the_marker_it_no_longer_keys_to(
        shared, recorder, why, replacement, dead_marker):
    # [L2] The mirror risk. Keeping a keyable row's marker is only safe if "keyable" tracks the
    # CURRENT row — the marker embeds both the id and the cent-quantized amount, so re-targeting
    # or re-identifying a milestone must still free the old key even when the row itself no
    # longer parses. If it didn't, every marker a WHIT-417-rejected row ever wrote would
    # accumulate forever and the WHIT-385 sweep would be off for exactly those rows.
    # The row is deliberately UNREADABLE (bad date) — a readable one is already covered by
    # test_stale_swept_and_fresh_crossing_fires_same_poll; this is the path that changed.
    # Fail-on-revert: add every stored row's OLD markers to live_keys (e.g. skip the sweep when
    # the row is unreadable) -> `removed` is empty.
    bad = _row_kw(targetDate="not-a-date", label="Moved", **replacement)

    notify = _sweep(shared, [_GOOD, bad], fired={_KEEP_MARKER, dead_marker})

    assert notify.removed == {dead_marker}, why
    assert notify.fired == {_KEEP_MARKER}, why


# --- [L3] two rows, one marker — and the legacy id-less collision ------------

def test_a_legacy_id_less_row_and_an_idd_row_at_the_same_amount_hold_distinct_markers(
        shared, recorder):
    # [L3] `live_keys` is a SET, so anything that makes two rows key alike merges their fates.
    # The one shape where that is reachable is the WHIT-378 legacy row: no id -> "bal:<amount>",
    # which sits next to an id'd row's "id:<id>:bal:<amount>" at the same target. They must stay
    # two markers: deleting the legacy row has to sweep "bal:300000.00" and ONLY that, or an
    # id'd row would be silently keeping a deleted milestone's record alive (and vice versa).
    # Both rows are unreadable here, which is the case the change newly keeps alive.
    legacy = {"label": "", "targetBalance": Decimal("300000"), "targetDate": "2030-01-01"}
    idd = _row_kw(id="keep", targetDate="not-a-date")
    markers = {"bal:300000.00", _KEEP_MARKER}

    assert _sweep(shared, [_GOOD, legacy, idd], fired=markers).removed == set()

    # ...and once the legacy row is gone, its marker alone dies. The id'd row at the identical
    # amount does NOT hold it open.
    notify = _sweep(shared, [_GOOD, idd], fired=markers)
    assert notify.removed == {"bal:300000.00"}
    assert notify.fired == {_KEEP_MARKER}


def test_two_rows_keying_to_the_same_marker_keep_it_while_either_survives(shared, recorder):
    # [L3] Duplicate rows (same id AND same amount — reachable by a direct write; the save
    # endpoint rejects duplicate ids) collapse to ONE live key. The invariant that matters is
    # that the collapse can't cost a record: while either copy is stored the marker stays, and
    # an unrelated dead marker is still swept in the same poll so the sweep is proven awake.
    dup = _row_kw(id="dup", targetBalance=Decimal("250000"))
    stored = [_GOOD, dup, {**dup, "targetDate": "not-a-date"}]     # one readable, one not
    gone = "id:deleted:bal:770000.00"

    notify = _sweep(shared, stored, fired={"id:dup:bal:250000.00", gone})

    assert notify.removed == {gone}
    assert "id:dup:bal:250000.00" in notify.fired


# --- [L4] the non-list stored plan: an empty live set + authoritative=True ---

def test_a_non_list_stored_plan_sweeps_nothing_and_never_reads_the_marker_set(shared, recorder):
    # [L4] The sharpest shape in the whole function: `is_plan_list` fails -> ([], True, set()).
    # authoritative is True and live_keys is EMPTY, so if the WHIT-386 `and plan` guard were
    # ever relaxed (say to `authoritative and live_keys is not None`, an easy-looking tidy now
    # that the live set is its own value), a single corrupt whole-plan write would delete every
    # custom "already celebrated" marker the user has, permanently and silently.
    # Asserting reads == 0 makes it structural: the guard short-circuits before any marker I/O,
    # so this can't pass by accident on a sweep that happened to find nothing.
    # Fail-on-revert: drop `and plan` from the guard -> both custom markers are removed.
    fired = {"id:a:bal:480000.00", "bal:120000.00", "0"}

    sent, notify = _notify(shared, facts=None, old="600000", new="100000", stored="corrupt-scalar",
                           notify=FakeNotifyRepo(fired=fired))

    assert sent == 0
    assert recorder == []
    assert notify.reads == 0, "a corrupt whole-plan write must not even read the marker set"
    assert notify.removed == set()
    assert notify.fired == fired


# --- [L5] _plan_marker now runs first, on rows a bad date used to shield -----

_HOSTILE_TARGETS = [
    ("quantize overflow", Decimal("1e26")),      # InvalidOperation — NOT a ValueError
    ("NaN", Decimal("NaN")),
    ("-Infinity", Decimal("-Infinity")),
    ("bytes", b"250000"),
    ("list", [250000]),
]


@pytest.mark.parametrize("why, target", _HOSTILE_TARGETS, ids=[c[0] for c in _HOSTILE_TARGETS])
def test_a_hostile_target_behind_a_bad_date_cannot_escape_the_per_row_guard(
        shared, recorder, why, target):
    # [L5] Ordering regression. Every row here is broken TWICE — a bad date and a target that
    # only `_plan_marker` touches. Under the old order row_date raised first and `_plan_marker`
    # never ran, so these targets were never fed to Decimal/quantize on this path at all. Now
    # they are, and `_plan_marker`'s quantize raises InvalidOperation, an ArithmeticError that
    # `except MalformedMilestoneRow` does NOT catch — it only stays caught because
    # milestones.py:81 re-wraps it by hand. If that wrapping is dropped the exception escapes
    # _resolve_plan into the balance poller's best-effort swallow, and EVERY row's celebration
    # is lost for good (the balance only falls, so the crossing is never re-detected).
    # Asserts the healthy row still pushes, not merely that nothing raised.
    hostile = {"id": "x", "label": "Hostile", "targetBalance": target,
               "targetDate": "not-a-date"}

    assert [p.label for p in shared.milestones.resolve_plan(
        FakeMilestoneRepo([hostile, _GOOD]))] == ["Halfway"], why

    sent, notify = _notify(shared, facts=None, old="310000", new="290000", stored=[hostile, _GOOD])
    assert sent == 1, why
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Halfway!"
    assert notify.fired == {_KEEP_MARKER}, why


def test_a_bare_non_dict_row_beside_a_bad_date_row_still_costs_only_itself(shared, recorder):
    # [L5] The other thing `_plan_marker` newly runs on: junk that isn't a mapping at all. It
    # reaches `row[...]` (TypeError -> MalformedMilestoneRow) and then `milestone.get("id")`,
    # which would AttributeError on a non-mapping if the guard above it ever moved. Neither the
    # junk nor the unreadable row may cost the healthy row its push or its marker.
    stored = ["not-a-row", 7, None, [], _row_kw(id="d", targetDate="not-a-date"), _GOOD]

    sent, notify = _notify(shared, facts=None, old="310000", new="290000", stored=stored,
                           notify=FakeNotifyRepo(fired={"id:d:bal:300000.00"}))

    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Halfway!"
    assert notify.removed == set()                       # the unreadable row kept its record
    assert notify.fired == {"id:d:bal:300000.00", _KEEP_MARKER}


# ==========================================================================
# --- folded from test_milestones_whit424_covers_gaps.py (WHIT-472) ---
# ==========================================================================


# --- covers() the primitive: startswith with the trailing colon, not `in`, not a bare prefix --

def test_covers_matches_exact_membership_and_an_id_prefix(shared):
    lm = shared.milestones.LiveMarkers(
        frozenset({"id:keep:bal:300000.00", "0"}), frozenset({"id:a:"}))
    assert lm.covers("id:keep:bal:300000.00") is True          # exact
    assert lm.covers("0") is True                              # exact (a built-in sprint marker)
    assert lm.covers("id:a:bal:250000.00") is True             # under the live id prefix
    assert lm.covers("id:a:bal:999999.00") is True             # any amount under that id


def test_covers_id_prefix_does_not_leak_across_a_substring_id(shared):
    # The trailing colon is load-bearing: "id:a:" must not cover a longer id's marker. If covers()
    # ever used `in` or a colon-less prefix, "id:ab:..." / "id:a2:..." would be wrongly kept.
    lm = shared.milestones.LiveMarkers(frozenset(), frozenset({"id:a:"}))
    assert lm.covers("id:ab:bal:300000.00") is False
    assert lm.covers("id:a2:bal:300000.00") is False
    assert lm.covers("id:abc:bal:0.00") is False
    assert lm.covers("bal:300000.00") is False                 # a legacy id-less marker
    assert lm.covers("0") is False                             # a built-in sprint marker


def test_covers_with_no_prefixes_is_exact_only(shared):
    lm = shared.milestones.LiveMarkers(frozenset({"id:x:bal:1.00"}), frozenset())
    assert lm.covers("id:x:bal:1.00") is True
    assert lm.covers("id:x:bal:2.00") is False                 # no prefix -> no amount wildcard


# --- end to end through _resolve_plan + the sweep: the trailing colon actually defends ---------

def test_a_short_id_unreadable_row_does_not_keep_a_longer_ids_deleted_marker(shared, recorder):
    # Row "a" has an unreadable target (id readable) -> _resolve_plan registers the prefix "id:a:".
    # A since-DELETED row once had id "ab" and fired "id:ab:bal:770000.00" — that id is gone from
    # the plan, so its marker must still be swept. Only the trailing colon in _row_id_prefix keeps
    # "id:a:" from covering it. Fail-on-revert: return "id:a" (no colon) -> stale is NOT removed.
    bad = _row_kw(id="a", targetBalance="oops")          # unreadable target, readable id
    own = "id:a:bal:250000.00"                         # row a's own once-ever marker
    stale = "id:ab:bal:770000.00"                      # the deleted longer-id row's marker

    notify = _sweep(shared, [_GOOD, bad], fired={_KEEP_MARKER, own, stale})

    assert notify.removed == {stale}                   # id:a: must NOT cover id:ab:...
    assert own in notify.fired                         # row a keeps its own marker via the prefix
    assert _KEEP_MARKER in notify.fired                # the readable row keeps its exact marker


def test_two_unreadable_rows_with_distinct_ids_each_keep_only_their_own(shared, recorder):
    # id_prefixes is a SET: two unreadable-target rows register two prefixes, and each covers ONLY
    # its own markers while an unrelated deleted row's marker is still reaped in the same poll.
    bad_p = _row_kw(id="p", targetBalance="oops")
    bad_q = _row_kw(id="q", targetBalance="oops")
    m_p = "id:p:bal:250000.00"
    m_q = "id:q:bal:120000.00"
    gone = "id:gone:bal:999999.00"

    notify = _sweep(shared, [_GOOD, bad_p, bad_q], fired={_KEEP_MARKER, m_p, m_q, gone})

    assert notify.removed == {gone}
    assert {m_p, m_q, _KEEP_MARKER} <= notify.fired


# ==========================================================================
# --- folded from test_milestones_whit447_mint_markers_gaps.py (WHIT-472) ---
# ==========================================================================

# stored Decimal(str(balance)) the save endpoint feeds mint, and the (legacy, idd) it must yield.
@pytest.mark.parametrize("stored, legacy, idd", [
    (Decimal(str(0)),               "bal:0.00",             "id:u1:bal:0.00"),
    (Decimal(str(1_000_000_000)),   "bal:1000000000.00",    "id:u1:bal:1000000000.00"),
    (Decimal(str(400000.005)),      "bal:400000.00",        "id:u1:bal:400000.00"),  # sub-cent → half-even
    (Decimal(str(55000.5)),         "bal:55000.50",         "id:u1:bal:55000.50"),
])
def test_mint_markers_match_the_literal_poller_key_at_quantization_edges(shared, stored, legacy, idd):
    got_legacy, got_idd = shared.milestones.mint_migration_markers(stored, "u1")
    assert (got_legacy, got_idd) == (legacy, idd)


@pytest.mark.parametrize("stored", [
    Decimal(str(0)), Decimal(str(1_000_000_000)), Decimal(str(400000.005)), Decimal(str(55000.5)),
])
def test_the_idd_marker_is_exactly_what_the_poller_would_key_the_stored_row_to(shared, stored):
    # The contract: the idd marker mint writes MUST equal the marker _plan_marker (the poller's
    # keying) builds for a row carrying that id + stored balance. Ties mint to the poller so a
    # future divergence (different quantize / prefix) fails here, not silently at the next poll.
    _, got_idd = shared.milestones.mint_migration_markers(stored, "u1")
    poller_key = shared.milestones._plan_marker({"id": "u1", "targetBalance": stored})
    assert got_idd == poller_key


@pytest.mark.parametrize("stored", [
    Decimal(str(0)), Decimal(str(400000.005)),
])
def test_the_legacy_marker_is_the_bare_id_less_form_the_poller_first_celebrated(shared, stored):
    # The legacy half must equal the id-LESS marker the poller keyed the row under before an id
    # existed — otherwise migrate would look for a bare marker that was never in the fired set and
    # silently no-op, leaving the celebration to re-arm.
    got_legacy, _ = shared.milestones.mint_migration_markers(stored, "u1")
    poller_bare = shared.milestones._plan_marker({"targetBalance": stored})
    assert got_legacy == poller_bare
    assert got_legacy.startswith("bal:") and "id:" not in got_legacy


# --- WHIT QA GAP: unset user is now AUTHORITATIVE-empty, not a fallback default -------------

def test_unset_user_with_live_markers_on_a_crossing_poll_neither_fires_nor_sweeps(shared, recorder):
    # The combined case no single existing test pins: a user who has NEVER saved a plan
    # (stored is None), WITH a live custom "already celebrated" marker, on a poll whose paydown
    # WOULD have crossed the OLD built-in Kickoff (545000 -> 544000). The new resolve makes this an
    # AUTHORITATIVE EMPTY plan, so:
    #   - nothing crosses  -> no push (they never chose this plan)
    #   - the WHIT-386 `and plan` guard short-circuits on the empty plan -> the sweep removes NOTHING,
    #     so the once-ever record survives (no crash on the empty live-marker set).
    # Fail-on-revert (two ways): revert `stored is None -> [], True` back to `list(MILESTONES), False`
    # and the default Kickoff fires (sent==1, marker "0" added); OR relax the `and plan` guard to a
    # bare `authoritative` and the empty live set wipes the seeded custom marker (removed != set()).
    notify = FakeNotifyRepo({"id:m1:bal:280000.00"})
    sent, notify = _notify(shared, old="545000", new="544000",
                           milestone_repo=FakeMilestoneRepo(stored=None), notify=notify)
    assert sent == 0
    assert recorder == []
    assert notify.removed == set()
    assert notify.fired == {"id:m1:bal:280000.00"}
