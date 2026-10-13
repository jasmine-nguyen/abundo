"""WHIT-384 / WHIT-369 — the milestone celebration push reads the user's SAVED plan.

Covers the unset plan (celebrate nothing), a custom plan firing on the user's own
targets/labels, the "id:<id>:bal:<amount>" dedup marker (WHIT-369: key by permanent id AND
amount, so reorder/delete can't repeat or drop an alert while re-pointing a target still
re-arms it), cent-exact custom boundaries, and (WHIT-830) a read failure or an id-less row.
"""

import logging
from decimal import Decimal

import pytest

# Shared milestone fakes + FACTS + _row + recorder (WHIT-445). RaisingNotifyRepo below
# subclasses the imported notify_repo.
from _milestone_fakes import (
    FACTS, FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, notify_repo, _row, recorder,
    removed_markers, stored_markers, unreadable_milestone_repo,
)
from _milestone_row_fakes import _GOOD, _KEEP_MARKER, _row as _row_kw


def _notify(shared, *, old, new, milestone_repo=None, stored=None, facts=FACTS,
            fired=None, notify=None, scope=None):
    # One wrapper for the whole custom-plan family (WHIT-472 fold). Give `milestone_repo`
    # directly OR `stored` (wrapped in a FakeMilestoneRepo); with neither, the store read fails
    # and there is no plan. `fired` builds a fresh notify repo;
    # `notify` supplies one you assert on. `facts=None` for the empty-loanfacts (live) cases.
    # Returns (sent, notify).
    notify = notify if notify is not None else notify_repo(fired)
    repo = milestone_repo or unreadable_milestone_repo()
    if stored is not None:
        repo = FakeMilestoneRepo(stored)
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


# --- WHIT-369: id-keyed dedup survives reorder / delete / same-amount collisions -----------

def test_reorder_does_not_refire_or_drop(shared, recorder):
    # Two saved targets; the further one (id "b", 300000) was already celebrated. Reordering the
    # list must NOT re-fire it (dedup keys on the permanent id, not list position) and must NOT
    # drop the un-fired one (id "a", 480000) — that one fires. Fail-on-revert for the whole card:
    # amount-only keying wouldn't match the seeded "id:b:..." marker, so B would wrongly re-fire.
    notify = notify_repo(fired={"id:b:bal:300000.00"})
    reordered = [_row("B", "300000", id="b"), _row("A", "480000", id="a")]
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("295000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=reordered))
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — A!"
    assert stored_markers(notify) == {"id:b:bal:300000.00", "id:a:bal:480000.00"}


def test_delete_then_readd_same_amount_fires_under_a_new_id(shared, recorder):
    # A milestone at 480000 (id "old") was celebrated; the user deletes it and adds a NEW target
    # at the SAME amount (fresh id "new"). Amount-only keying would swallow it forever; id-keying
    # fires it because the id differs. The WHIT-385 reconcile also sweeps the deleted milestone's
    # now-dead "id:old" marker in the same poll, so only the live "id:new" marker remains.
    notify = notify_repo(fired={"id:old:bal:480000.00"})
    readded = [_row("My House again", "480000", id="new")]
    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("480000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=readded))
    assert sent == 1
    assert removed_markers(notify) == {"id:old:bal:480000.00"}  # dead marker swept by reconcile
    assert stored_markers(notify) == {"id:new:bal:480000.00"}    # only the live marker remains


def test_two_targets_at_the_same_amount_get_distinct_markers(shared, recorder):
    # Two milestones at the same 300000 target but different ids crossed together → both marked
    # under distinct id-markers. Amount-only keying collides them into one shared marker.
    notify = notify_repo()
    plan = [_row("First", "300000", id="one"), _row("Second", "300000", id="two")]
    shared.milestones.notify_milestone_crossing(
        Decimal("310000"), Decimal("300000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=plan))
    assert stored_markers(notify) == {"id:one:bal:300000.00", "id:two:bal:300000.00"}


def test_cent_exact_custom_boundary(shared):
    # The raw-Decimal path preserves cents: crossing 295000.01 counts; 295000.02 does not.
    plan = shared.milestones._resolve_plan(FakeMilestoneRepo(stored=[_row("Halfway", "295000.01")]))[0]
    assert [m.target_balance for m in shared.milestones.crossed_milestones(Decimal("296000"), Decimal("295000.01"), plan)] == [Decimal("295000.01")]
    assert shared.milestones.crossed_milestones(Decimal("296000"), Decimal("295000.02"), plan) == []


# --- WHIT-385: reconcile dead custom markers ------------------------------------------------
# The set of "bal:<amount>" celebration markers must not grow forever when a user re-targets a
# milestone. On each poll, drop markers whose target is no longer in the saved plan — but ONLY
# when the plan is non-empty. A read failure or an unset plan is an empty plan and must delete
# NOTHING, or a transient blip would wipe the once-ever "already celebrated" record.


def test_reconcile_write_error_does_not_suppress_celebration(shared, recorder):
    # Reconcile is best-effort bookkeeping placed BEFORE the send: a marker DELETE blip must not
    # eat a genuine celebration (the crossing is never re-detected once the balance passes it).
    # Fail-on-revert: drop the try/except and this raises out of notify instead of sending.
    # The seeded "bal:300000.00" is a dead legacy marker (not the live "id:m1:..."), so reconcile
    # tries to delete it → the table refuses the DELETE → the celebration must still proceed.
    notify = notify_repo({"bal:300000.00"})

    def is_delete(key):
        return notify._table.update_calls[-1][0].startswith("DELETE")

    notify._table.fail("update_item", when=is_delete)
    sent, _ = _notify(shared, old="290000", new="280000",
                milestone_repo=FakeMilestoneRepo(stored=[_row("My House", "280000")]), notify=notify)
    assert sent == 1
    assert recorder[0][0] == "\U0001f389 Milestone reached — My House!"
    assert "id:m1:bal:280000.00" in stored_markers(notify)  # the fresh crossing is still marked fired


# --- malformed stored row: skipped + logged, the rest celebrate (WHIT-387) ------------------


def test_non_list_stored_plan_is_empty_not_raised(shared, caplog):
    # A corrupt whole-plan write stored as a non-iterable scalar (not merely a bad row) must
    # degrade to an empty plan via the isinstance guard, not raise, and log the plan-level token.
    with caplog.at_level(logging.ERROR, logger="milestones"):
        assert shared.milestones._resolve_plan(FakeMilestoneRepo(stored=5))[0] == []
    assert any("MILESTONE_PLAN_MALFORMED" in r.message for r in caplog.records)


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

    assert removed_markers(notify) == set(), why
    assert stored_markers(notify) == {_KEEP_MARKER, marker}, why


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

    assert removed_markers(notify) == set(), why
    assert stored_markers(notify) == {_KEEP_MARKER, marker}, why


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

    assert removed_markers(notify) == {once_written}, why
    assert stored_markers(notify) == {_KEEP_MARKER}, why


# --- [L2] a keyable row is not immune: "gone" still means gone ---------------

_STILL_GONE = [
    # (why, the stored row that replaced it, the marker that must still be swept)
    ("re-targeted 300000 -> 250000",
     {"id": "x", "targetBalance": Decimal("250000")}, "id:x:bal:300000.00"),
    ("deleted and re-added under a new id",
     {"id": "new", "targetBalance": Decimal("300000")}, "id:old:bal:300000.00"),
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
    # test_milestones.py::test_reconcile_and_dedup_coexist_live_fired_not_refired; this is the
    # path that changed.
    # Fail-on-revert: add every stored row's OLD markers to live_keys (e.g. skip the sweep when
    # the row is unreadable) -> `removed` is empty.
    bad = _row_kw(targetDate="not-a-date", label="Moved", **replacement)

    notify = _sweep(shared, [_GOOD, bad], fired={_KEEP_MARKER, dead_marker})

    assert removed_markers(notify) == {dead_marker}, why
    assert stored_markers(notify) == {_KEEP_MARKER}, why


# --- [L4] the non-list stored plan: an empty live set + authoritative=True ---

def test_a_non_list_stored_plan_sweeps_nothing_and_never_reads_the_marker_set(shared, recorder):
    # [L4] The sharpest shape in the whole function: `is_plan_list` fails -> ([], True, set()).
    # authoritative is True and live_keys is EMPTY, so if the WHIT-386 `and plan` guard were
    # ever relaxed (say to `authoritative and live_keys is not None`, an easy-looking tidy now
    # that the live set is its own value), a single corrupt whole-plan write would delete every
    # custom "already celebrated" marker the user has, permanently and silently.
    # Fail-on-revert: drop `and plan` from the guard -> both custom markers are removed.
    fired = {"id:a:bal:480000.00", "bal:120000.00", "0"}

    sent, notify = _notify(shared, facts=None, old="600000", new="100000", stored="corrupt-scalar",
                           notify=notify_repo(fired=fired))

    assert sent == 0
    assert recorder == []
    assert removed_markers(notify) == set()
    assert stored_markers(notify) == fired


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

    assert [p.label for p in shared.milestones._resolve_plan(
        FakeMilestoneRepo([hostile, _GOOD]))[0]] == ["Halfway"], why

    sent, notify = _notify(shared, facts=None, old="310000", new="290000", stored=[hostile, _GOOD])
    assert sent == 1, why
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Halfway!"
    assert stored_markers(notify) == {_KEEP_MARKER}, why


def test_a_bare_non_dict_row_beside_a_bad_date_row_still_costs_only_itself(shared, recorder):
    # [L5] The other thing `_plan_marker` newly runs on: junk that isn't a mapping at all. It
    # reaches `row[...]` (TypeError -> MalformedMilestoneRow) and then `milestone.get("id")`,
    # which would AttributeError on a non-mapping if the guard above it ever moved. Neither the
    # junk nor the unreadable row may cost the healthy row its push or its marker.
    stored = ["not-a-row", 7, None, [], _row_kw(id="d", targetDate="not-a-date"), _GOOD]

    sent, notify = _notify(shared, facts=None, old="310000", new="290000", stored=stored,
                           notify=notify_repo(fired={"id:d:bal:300000.00"}))

    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Halfway!"
    assert removed_markers(notify) == set()                       # the unreadable row kept its record
    assert stored_markers(notify) == {"id:d:bal:300000.00", _KEEP_MARKER}


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

    assert removed_markers(notify) == {stale}                   # id:a: must NOT cover id:ab:...
    assert own in stored_markers(notify)                         # row a keeps its own marker via the prefix
    assert _KEEP_MARKER in stored_markers(notify)                # the readable row keeps its exact marker


# --- WHIT QA GAP: unset user is now AUTHORITATIVE-empty, not a fallback default -------------

def test_unset_user_with_live_markers_on_a_crossing_poll_neither_fires_nor_sweeps(shared, recorder):
    # The combined case no single existing test pins: a user who has NEVER saved a plan
    # (stored is None), WITH a live custom "already celebrated" marker, on a poll whose paydown
    # WOULD have crossed the OLD built-in Kickoff (545000 -> 544000). The new resolve makes this an
    # AUTHORITATIVE EMPTY plan, so:
    #   - nothing crosses  -> no push (they never chose this plan)
    #   - the WHIT-386 `and plan` guard short-circuits on the empty plan -> the sweep removes NOTHING,
    #     so the once-ever record survives (no crash on the empty live-marker set).
    # Fail-on-revert: drop the `if plan` sweep guard and the empty live set wipes the seeded
    # custom marker (removed != set()).
    notify = notify_repo({"id:m1:bal:280000.00"})
    sent, notify = _notify(shared, old="545000", new="544000",
                           milestone_repo=FakeMilestoneRepo(stored=None), notify=notify)
    assert sent == 0
    assert recorder == []
    assert removed_markers(notify) == set()
    assert stored_markers(notify) == {"id:m1:bal:280000.00"}


# --- WHIT-830: no built-in default plan and no id-less fallback ----------------------------

_ID_LESS = {"label": "Old", "targetBalance": Decimal("480000"), "targetDate": "2030-01-01"}
_SEEDED = {"0", "bal:480000.00", _KEEP_MARKER}
# No "0": the old built-in plan's Kickoff (544000) would fire for it, so a revert shows as a push.
_SEEDED_NO_SPRINT = {"bal:480000.00", _KEEP_MARKER}

_SCENARIOS = [
    # (milestone_repo, seeded markers, old, new, expected removed, expected kept, log level, log text)
    pytest.param(
        unreadable_milestone_repo(), _SEEDED_NO_SPRINT, "545000", "544000",
        set(), _SEEDED_NO_SPRINT, logging.WARNING, "read failed",
        id="read failure: no plan, nothing swept"),
    pytest.param(
        FakeMilestoneRepo(stored=[dict(_GOOD), dict(_ID_LESS)]), _SEEDED, "490000", "470000",
        {"0", "bal:480000.00"}, {_KEEP_MARKER}, logging.ERROR, "MILESTONE_ROW_MALFORMED",
        id="id key missing: row skipped, old markers swept"),
    pytest.param(
        FakeMilestoneRepo(stored=[dict(_GOOD), {**_ID_LESS, "id": None}]), _SEEDED, "490000", "470000",
        {"0", "bal:480000.00"}, {_KEEP_MARKER}, logging.ERROR, "MILESTONE_ROW_MALFORMED",
        id="id null: row skipped, old markers swept"),
]


@pytest.mark.parametrize("milestone_repo, seeded, old, new, removed, kept, level, log_text", _SCENARIOS)
def test_poll_celebrates_only_saved_milestones_with_an_id(
        shared, recorder, caplog, milestone_repo, seeded, old, new, removed, kept, level, log_text):
    notify = notify_repo(seeded)

    with caplog.at_level(logging.WARNING, logger="milestones"):
        sent = shared.milestones.notify_milestone_crossing(
            Decimal(old), Decimal(new),
            loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
            notify_repo=notify, milestone_repo=milestone_repo)

    assert sent == 0
    assert recorder == []
    assert removed_markers(notify) == removed
    assert stored_markers(notify) == kept
    assert any(log_text in r.message and r.levelno == level for r in caplog.records)


def test_one_poll_crossing_an_id_less_and_a_good_milestone_celebrates_only_the_good_one(shared, recorder):
    # 490k -> 290k crosses the id-less 480k row AND _GOOD (300k). The id-less row is skipped,
    # not keyed as "bal:...", and it doesn't take the good row's push down with it.
    notify = notify_repo()

    sent = shared.milestones.notify_milestone_crossing(
        Decimal("490000"), Decimal("290000"),
        loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=FakeMilestoneRepo(stored=[dict(_GOOD), dict(_ID_LESS)]))

    assert sent == 1
    assert [title for title, _body, _tokens in recorder] == ["\U0001f389 Milestone reached — Halfway!"]
    assert stored_markers(notify) == {_KEEP_MARKER}
