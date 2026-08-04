"""WHIT-417 — [L1]-[L5] adversarial gaps in `live_keys`, the "which markers are still live"
set _resolve_plan gained so the WHIT-385 sweep can tell an UNREADABLE row from a DELETED one.

Already locked elsewhere, NOT repeated here: an unreadable row keeps its marker while a
genuinely gone one is swept in the same poll ([B3], test_milestone_rows_gaps.py); a repaired
date is silent ([B1b]); sweep + real celebration in one poll ([E4]); a row whose target is
unreadable but whose id still reads keeps its record while the sweep runs
(test_previously_fired_row_now_unreadable_target_keeps_its_record, WHIT-424); the sweep still
reaps an unrelated stale marker with a corrupt row present
(test_sweep_removes_only_the_stale_marker_keeps_survivor_with_a_corrupt_row_present); the
non-authoritative paths never sweep (test_milestones_custom_plan.py); an authoritative EMPTY
plan never sweeps or even reads ([B1c], [E6], WHIT-386 gaps).

What none of them cover — the two directions this change can be wrong in:

  [L1] the CONTRACT, stated once. A row's once-ever record survives whenever we can still name
       the row: an EXACT marker while we can build one, or — when only the target amount is
       unreadable but the id still reads — every "id:<row id>:" marker under it (WHIT-424). Only
       a row we can neither key NOR name (unreadable target AND no readable id) loses its record.
       Both halves in one place, so a future validator added to the read path has an obvious home
       — and moving `_plan_marker` back after the validators turns the "survives" half red.
  [L2] the OPPOSITE risk to the one the change fixes: markers that should still be swept. A
       keyable row is now immune, so "gone" has to keep meaning gone for a row that is present
       but UNREADABLE — re-targeted, re-identified, or legacy-id-minted. Every one of those
       keys to a NEW marker, so the old one must still die. If it doesn't, the WHIT-385 sweep
       is quietly disabled for exactly the rows WHIT-417 just started rejecting.
  [L3] key COLLAPSE. `live_keys` is a set, so two rows can hold one marker and one row can hold
       a marker two rows once shared. The legacy id-less form ("bal:<amount>") is the collision
       risk: an id-less row and an id'd row at the SAME amount must hold two DISTINCT markers,
       or deleting one silently protects the other's record.
  [L4] the non-list stored plan. That branch returns live_keys=set() with authoritative=True —
       the one shape where an empty live set meets a sweep-eligible flag. Only the WHIT-386
       `and plan` guard stands between it and deleting the user's entire once-ever record.
  [L5] ORDER. `_plan_marker` now runs FIRST, so it runs on rows that used to be rejected before
       it was ever reached. It is the one step in the loop that can raise a non-ValueError
       (Decimal InvalidOperation, re-wrapped by hand at milestones.py:81) — if that wrapping is
       ever dropped, the exception escapes _resolve_plan into the poller's swallow and the whole
       poll's celebration is lost. Previously a bad date shielded those rows from it.
"""

from decimal import Decimal

import pytest


_GOOD = {"id": "keep", "label": "Halfway", "targetBalance": Decimal("300000"),
         "targetDate": "2030-01-01"}
_KEEP_MARKER = "id:keep:bal:300000.00"


def _row(**overrides):
    return {**_GOOD, **overrides}


class FakeMilestoneRepo:
    def __init__(self, stored):
        self._stored = stored

    def get_milestones_raw(self, scope=None):
        return self._stored


class FakeDeviceRepo:
    def list_tokens(self):
        return ["tok"]


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return None          # the number-free body; the figures aren't what's under test


class FakeNotifyRepo:
    """Counts reads as well as writes, so [L4] can prove a short-circuit, not just a no-op."""

    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.removed = set()
        self.reads = 0

    def fired_milestones(self, scope=None):
        self.reads += 1
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        assert keys, "must guard empty before calling remove_milestone_markers"
        self.removed |= set(keys)
        self.fired -= set(keys)


@pytest.fixture
def recorder(shared, monkeypatch):
    calls = []
    monkeypatch.setattr(shared.milestones, "send_push",
                        lambda title, body, tokens, **kw: calls.append((title, body, tokens)))
    return calls


def _notify(shared, *, old, new, stored, notify=None):
    notify = notify or FakeNotifyRepo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal(old), Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(),
        device_repo=FakeDeviceRepo(),
        notify_repo=notify,
        milestone_repo=FakeMilestoneRepo(stored),
    )
    return sent, notify


def _sweep(shared, stored, fired):
    """A no-crossing poll: the balance stays far above every target, so the WHIT-385 sweep runs
    on its own with no celebration logic in the way. Returns the notify fake."""
    _, notify = _notify(shared, old="900000", new="850000", stored=stored,
                        notify=FakeNotifyRepo(fired=fired))
    return notify


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
    bad = _row(id="x", targetBalance=Decimal("250000"), **broken)
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
    bad = _row(id="x", **broken)
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
    bad = _row(targetBalance="oops", **id_shape)
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
    bad = _row(targetDate="not-a-date", label="Moved", **replacement)

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
    idd = _row(id="keep", targetDate="not-a-date")
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
    dup = _row(id="dup", targetBalance=Decimal("250000"))
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

    sent, notify = _notify(shared, old="600000", new="100000", stored="corrupt-scalar",
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

    sent, notify = _notify(shared, old="310000", new="290000", stored=[hostile, _GOOD])
    assert sent == 1, why
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Halfway!"
    assert notify.fired == {_KEEP_MARKER}, why


def test_a_bare_non_dict_row_beside_a_bad_date_row_still_costs_only_itself(shared, recorder):
    # [L5] The other thing `_plan_marker` newly runs on: junk that isn't a mapping at all. It
    # reaches `row[...]` (TypeError -> MalformedMilestoneRow) and then `milestone.get("id")`,
    # which would AttributeError on a non-mapping if the guard above it ever moved. Neither the
    # junk nor the unreadable row may cost the healthy row its push or its marker.
    stored = ["not-a-row", 7, None, [], _row(id="d", targetDate="not-a-date"), _GOOD]

    sent, notify = _notify(shared, old="310000", new="290000", stored=stored,
                           notify=FakeNotifyRepo(fired={"id:d:bal:300000.00"}))

    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Halfway!"
    assert notify.removed == set()                       # the unreadable row kept its record
    assert notify.fired == {"id:d:bal:300000.00", _KEEP_MARKER}
