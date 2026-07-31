"""WHIT-384 / WHIT-369 — the milestone celebration push reads the user's SAVED plan.

Covers the resolve-plan fallback (unset / read-failure → built-in default), a custom plan
firing on the user's own targets/labels, the "id:<id>:bal:<amount>" dedup marker (WHIT-369:
key by permanent id AND amount, so reorder/delete can't repeat or drop an alert while
re-pointing a target still re-arms it), the re-target re-arm, and cent-exact custom
boundaries. The no-saved-plan / default path stays covered by test_milestones.py (its callers
omit milestone_repo → None → default), which is itself the no-regression guard.
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
        self.removed = set()  # every key ever passed to remove_milestone_markers

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
    """Stands in for MilestoneRepository. `stored` is the RAW list (targetBalance as Decimal,
    like get_milestones_raw), None when unset; `raises` simulates a DynamoDB read failure."""
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


def _notify(shared, *, old, new, milestone_repo, fired=None):
    return shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(FACTS),
        device_repo=FakeDeviceRepo(),
        notify_repo=FakeNotifyRepo(fired),
        milestone_repo=milestone_repo,
    )


# --- resolve_plan --------------------------------------------------------------------------

def test_resolve_plan_none_repo_is_the_default(shared):
    assert shared.milestones.resolve_plan(None) == list(shared.milestones.MILESTONES)


def test_resolve_plan_unset_is_the_default(shared):
    assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored=None)) == list(shared.milestones.MILESTONES)


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
    sent = _notify(shared, old="490000", new="480000", milestone_repo=repo)
    assert sent == 1
    title, _body, _tokens = recorder[0]
    assert title == "\U0001f389 Milestone reached — My House!"


def test_custom_plan_does_not_fire_on_a_default_balance(shared, recorder):
    # A saved plan that excludes 544000: crossing the OLD built-in Kickoff must NOT fire —
    # proves the push stopped reading the hardcoded table (fail-on-revert on the whole card).
    repo = FakeMilestoneRepo(stored=[_row("My House", "480000")])
    sent = _notify(shared, old="545000", new="544000", milestone_repo=repo)
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
    sent = _notify(shared, old="490000", new="480000", milestone_repo=repo, fired={"id:m1:bal:480000.00"})
    assert sent == 0
    assert recorder == []


def test_retarget_rearms_the_celebration(shared, recorder):
    # Decision (WHIT-369): key by permanent id AND amount. Same milestone id already crossed &
    # marked at 300000, then re-pointed to 280000 → the amount is part of the marker, so the
    # new target is a fresh marker and fires again when the balance crosses it.
    repo = FakeMilestoneRepo(stored=[_row("My House", "280000")])  # id defaults to "m1"
    sent = _notify(shared, old="290000", new="280000", milestone_repo=repo, fired={"id:m1:bal:300000.00"})
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
    legacy = [{"label": "Old", "targetBalance": Decimal("480000"), "targetDate": None}]
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
    sent = _notify(shared, old="545000", new="544000", milestone_repo=repo)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — Kickoff!"


def test_no_plan_falls_back_to_default_with_sprint_markers(shared, recorder):
    # Explicit no-regression: an unset plan behaves exactly like the pre-WHIT-384 default,
    # marking the bare sprint string "0" (so existing users' markers keep deduping).
    notify = FakeNotifyRepo()
    shared.milestones.notify_milestone_crossing(
        Decimal("545000"), Decimal("544000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=None))
    assert notify.fired == {"0"}


# --- WHIT-385: reconcile dead custom markers ------------------------------------------------
# The set of "bal:<amount>" celebration markers must not grow forever when a user re-targets a
# milestone. On each poll, drop markers whose target is no longer in the saved plan — but ONLY
# when the plan read was authoritative (a genuine saved list). A read failure / unset / None repo
# falls back to the built-in default and must delete NOTHING, or a transient blip would wipe the
# once-ever "already celebrated" record.

def _run(shared, *, old, new, milestone_repo, notify):
    return shared.milestones.notify_milestone_crossing(
        Decimal(old) if old is not None else None,
        Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(FACTS),
        device_repo=FakeDeviceRepo(),
        notify_repo=notify,
        milestone_repo=milestone_repo,
    )


def test_retarget_drops_the_dead_marker(shared, recorder):
    # Core fail-on-revert: a milestone re-pointed 300000 → 280000 leaves a dead "bal:300000.00"
    # marker. A poll that crosses nothing still reconciles it away. Revert the reconcile and the
    # dead key survives → this fails.
    notify = FakeNotifyRepo({"bal:300000.00"})
    sent = _run(shared, old="285000", new="284000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert sent == 0
    assert notify.removed == {"bal:300000.00"}
    assert notify.fired == set()


def test_read_failure_does_not_delete_any_marker(shared, recorder):
    # BLOCKER guard, fail-on-revert: a milestones-store read failure falls back to the default
    # plan (no "bal:" keys). Reconciling against it would treat EVERY live custom marker as dead
    # and delete it. Authoritative-only reconcile must delete nothing here.
    notify = FakeNotifyRepo({"bal:300000.00", "bal:480000.00"})
    sent = _run(shared, old="250000", new="249000",
                milestone_repo=FakeMilestoneRepo(raises=RuntimeError("dynamo down")), notify=notify)
    assert sent == 0
    assert notify.removed == set()
    assert notify.fired == {"bal:300000.00", "bal:480000.00"}


def test_unset_plan_does_not_delete_markers(shared, recorder):
    # An unset plan (stored is None) is a fallback default, not an authoritative empty plan, so
    # custom markers are left intact (only a positively-returned list authorizes deletion).
    notify = FakeNotifyRepo({"bal:300000.00"})
    _run(shared, old="250000", new="249000",
         milestone_repo=FakeMilestoneRepo(stored=None), notify=notify)
    assert notify.removed == set()
    assert notify.fired == {"bal:300000.00"}


def test_none_repo_does_not_delete_markers(shared, recorder):
    # No repo at all (pre-WHIT-384 callers) → default plan, non-authoritative → no deletion.
    notify = FakeNotifyRepo({"bal:300000.00"})
    _run(shared, old="250000", new="249000", milestone_repo=None, notify=notify)
    assert notify.removed == set()
    assert notify.fired == {"bal:300000.00"}


def test_empty_saved_plan_does_not_wipe_markers(shared, recorder):
    # WHIT-386: an authoritative empty plan ([]) sweeps NOTHING — defence in depth so a regressed
    # empty-save guard can't erase the once-ever "already celebrated" record in one sweep. Every
    # marker survives, including custom "bal:" ones (they linger harmlessly — nothing re-fires them).
    notify = FakeNotifyRepo({"bal:300000.00", "bal:120000.00", "0"})
    sent = _run(shared, old="250000", new="249000",
                milestone_repo=FakeMilestoneRepo(stored=[]), notify=notify)
    assert sent == 0
    assert notify.removed == set()
    assert notify.fired == {"bal:300000.00", "bal:120000.00", "0"}


def test_reconcile_preserves_builtin_sprint_markers(shared, recorder):
    # Sprint markers ("0".."4") never carry the "bal:" prefix, so reconcile leaves them alone even
    # while dropping a dead custom marker.
    notify = FakeNotifyRepo({"0", "1", "bal:300000.00"})
    _run(shared, old="285000", new="284000",
         milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert notify.removed == {"bal:300000.00"}
    assert notify.fired == {"0", "1"}


def test_reconcile_no_delete_when_marker_still_live(shared, recorder):
    # The saved target still matches the marker → nothing stale → remove is never called (the
    # empty-guard would assert if it were).
    notify = FakeNotifyRepo({"id:m1:bal:280000.00"})
    _run(shared, old="285000", new="284000",
         milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert notify.removed == set()
    assert notify.fired == {"id:m1:bal:280000.00"}


def test_reconcile_preserves_the_once_ever_dedup_for_a_live_marker(shared, recorder):
    # Moving the fired read above the "nothing crossed" short-circuit must not break dedup: a live
    # marker whose target is crossed again must NOT re-fire.
    notify = FakeNotifyRepo({"id:m1:bal:280000.00"})
    sent = _run(shared, old="285000", new="280000",
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
    sent = _run(shared, old="290000", new="280000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — My House!"
    assert "id:m1:bal:280000.00" in notify.fired  # the fresh crossing is still marked fired
