"""WHIT-394 — the ONE stored-milestone-row validity rule, shared by both read paths.

Before this card each read path carried its own copy of "is this saved row usable", and they
had already drifted: the poller rejected a non-finite target (WHIT-387) while the client read
cast with float(), which turns NaN/Infinity into a bare token that isn't valid JSON — so ONE
corrupt row made the WHOLE milestones response unparsable.

Covered here:
  [U-*] the shared validator directly — what it accepts, what it rejects, and why two target
        helpers exist (a finite Decimal can still float() to inf);
  [C-*] the CLIENT read gains the rejections it was missing (the card's headline gap);
  [P-*] PARITY: both read paths agree on every corrupt shape — the anti-drift check the card
        is actually for;
  [D-*] the per-site DIFFERENCES that must survive unification (log level + alarm token,
        Decimal vs float, and the deliberate WHIT-378 id tolerance).
"""

import json
import logging
import pathlib
import re
import sys
from decimal import Decimal

import pytest

# Shared milestone fakes + row fixtures (WHIT-445). The one good stored row (_GOOD) and the
# raw-row injector are shared so the row shape can't drift between the parity suites.
from _milestone_fakes import (
    FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, FakeNotifyRepo, recorder,
)
from _milestone_row_fakes import _GOOD, _row, _store_raw_row


# --- [U] the shared validator, directly -------------------------------------------------

@pytest.mark.parametrize("stored, expected", [
    ([], True),
    ([_GOOD], True),
    ("not a list", False),
    (42, False),
    (None, False),
    ({"m1": _GOOD}, False),          # a map in the slot, not a list
    ({"a", "b"}, False),             # a string set, as DynamoDB can return
])
def test_is_plan_list_accepts_only_a_list(shared, stored, expected):
    assert shared.milestone_rows.is_plan_list(stored) is expected


@pytest.mark.parametrize("raw, expected", [
    (Decimal("595413.43"), Decimal("595413.43")),   # exact to the cent
    (Decimal("1E+6"), Decimal("1000000")),
    ("300000", Decimal("300000")),                  # legacy string target
    (300000, Decimal("300000")),
])
def test_row_target_coerces_to_an_exact_decimal(shared, raw, expected):
    assert shared.milestone_rows.row_target(_row(targetBalance=raw)) == expected


@pytest.mark.parametrize("bad_row", [
    {"id": "m1", "label": "No target", "targetDate": "2030-01-01"},   # missing the key
    _row(targetBalance=None),
    _row(targetBalance="abc"),
    _row(targetBalance=""),
    _row(targetBalance=[]),
    _row(targetBalance={}),
    _row(targetBalance=b"480000"),
    "a bare string row",
    42,
    None,
])
def test_row_target_rejects_a_junk_target(shared, bad_row):
    with pytest.raises(shared.milestone_rows.MalformedMilestoneRow):
        shared.milestone_rows.row_target(bad_row)


@pytest.mark.parametrize("non_finite", [
    Decimal("NaN"), Decimal("Infinity"), Decimal("-Infinity"),
    float("nan"), float("inf"), float("-inf"),
])
def test_row_target_rejects_a_non_finite_target(shared, non_finite):
    # The WHIT-387 guard, now shared. A NaN target quantizes to NaN WITHOUT raising, so
    # without this it slips every per-row skip and blows up at the crossing comparison.
    with pytest.raises(shared.milestone_rows.MalformedMilestoneRow):
        shared.milestone_rows.row_target(_row(targetBalance=non_finite))


@pytest.mark.parametrize("huge", ["1e309", "1e400", "1e100000"])
def test_row_target_float_rejects_a_target_too_large_for_a_float(shared, huge):
    # THE reason two target helpers exist: Decimal("1e400") is perfectly FINITE, so row_target
    # accepts it, but float() overflows it to inf (from ~1e309) — which serialises as a bare
    # Infinity token. row_target_float checks the RESULT, not just the Decimal.
    row = _row(targetBalance=Decimal(huge))
    assert shared.milestone_rows.row_target(row).is_finite()          # the Decimal is fine
    with pytest.raises(shared.milestone_rows.MalformedMilestoneRow):
        shared.milestone_rows.row_target_float(row)


@pytest.mark.parametrize("big", ["1e26", "1e300"])
def test_row_target_float_accepts_a_big_but_representable_target(shared, big):
    # The float-overflow boundary (~1e309) is NOT the quantize boundary (~1e26, where cent
    # precision exceeds the decimal module's 28 working digits). Only the poller quantizes,
    # so a 1e26 target is fine for the client read — pins the two boundaries apart.
    assert shared.milestone_rows.row_target_float(_row(targetBalance=Decimal(big))) == float(big)


def test_a_missing_field_error_is_not_rewrapped_as_non_numeric(shared):
    # MalformedMilestoneRow IS a ValueError, so row_field must be called OUTSIDE row_target's
    # own `except ValueError` — otherwise the precise error is swallowed and re-wrapped.
    with pytest.raises(shared.milestone_rows.MalformedMilestoneRow, match="missing targetBalance"):
        shared.milestone_rows.row_target({"id": "m1", "label": "No target"})


@pytest.mark.parametrize("blank", ["", "   ", None, 42, [], {}])
def test_row_text_rejects_a_blank_label(shared, blank):
    with pytest.raises(shared.milestone_rows.MalformedMilestoneRow):
        shared.milestone_rows.row_text(_row(label=blank), "label")


def test_row_text_returns_the_label_unchanged(shared):
    # NOT trimmed on read: the write path already trims, and re-trimming here would silently
    # change what the screen shows for a legacy row.
    assert shared.milestone_rows.row_text(_row(label="  Halfway  "), "label") == "  Halfway  "


@pytest.mark.parametrize("bad_date", ["", "   ", None, "not-a-date", "2026-02-30", 20300101, []])
def test_row_date_rejects_a_date_the_review_endpoint_cannot_parse(shared, bad_date):
    with pytest.raises(shared.milestone_rows.MalformedMilestoneRow):
        shared.milestone_rows.row_date(_row(targetDate=bad_date), "targetDate")


def test_row_date_returns_the_date_unchanged(shared):
    assert shared.milestone_rows.row_date(_GOOD, "targetDate") == "2030-01-01"


# --- [C] the client read gains the missing rejections ------------------------------------

def test_client_read_skips_a_non_finite_target(shared, milestone_repo):
    # THE card's headline gap. Fail-on-revert: put `float(m["targetBalance"])` back in
    # _to_client and the bad row survives as nan, so this fails.
    # Only NaN here — Infinity/-Infinity/1e100000 are already locked at this same level by
    # _CORRUPT_SHAPES below; duplicating them makes the parity table look weaker than it is.
    _store_raw_row(milestone_repo, [_row(id="good"), _row(id="bad", targetBalance=Decimal("NaN"))])
    assert [m["id"] for m in milestone_repo.get_milestones()] == ["good"]


@pytest.mark.parametrize("bad_target", [Decimal("NaN"), Decimal("Infinity")])
def test_client_read_response_is_always_parsable_json(shared, milestone_repo, bad_target):
    # The real symptom, not just a bad number on screen: json.dumps defaults to allow_nan=True
    # and emits the bare tokens `NaN` / `Infinity`, which NO JSON parser accepts — so one
    # corrupt row made the whole GET /milestones body unreadable to the app.
    _store_raw_row(milestone_repo, [_row(id="good"), _row(id="bad", targetBalance=bad_target)])
    body = json.dumps(milestone_repo.get_milestones())
    assert "NaN" not in body and "Infinity" not in body
    assert json.loads(body) == [{"id": "good", "label": "Halfway",
                                 "targetBalance": 300000.0, "targetDate": "2030-01-01"}]


def test_set_milestones_return_value_is_validated_too(shared, milestone_repo):
    # set_milestones also returns through _to_client, so it must skip the same rows.
    saved = milestone_repo.set_milestones([_row(id="good"), _row(id="bad", targetBalance=Decimal("NaN"))])
    assert [m["id"] for m in saved] == ["good"]


# --- [P] parity: both read paths agree ---------------------------------------------------

_CORRUPT_SHAPES = [
    ("missing target", {"id": "bad", "label": "Broken", "targetDate": "2030-01-01"}),
    ("null target", _row(targetBalance=None)),
    ("non-numeric target", _row(targetBalance="abc")),
    ("empty-string target", _row(targetBalance="")),
    ("list target", _row(targetBalance=[])),
    ("bytes target", _row(targetBalance=b"480000")),
    ("NaN target", _row(targetBalance=Decimal("NaN"))),
    ("Infinity target", _row(targetBalance=Decimal("Infinity"))),
    ("un-floatable target", _row(targetBalance=Decimal("1e100000"))),
    ("blank label", _row(label="")),
    ("null label", _row(label=None)),
    # WHIT-417 moved these three in: the date rule used to be client-only, because only
    # _review_candidates parses the field (an unparsable one raises outside its per-row guard
    # and 500s the review endpoint — WHIT-394). Now both paths apply it.
    ("blank date", _row(targetDate="")),
    ("null date", _row(targetDate=None)),
    ("unparsable date", _row(targetDate="not-a-date")),
    ("non-dict row", "a bare string row"),
    ("null row", None),
]


@pytest.mark.parametrize("why, bad_row", _CORRUPT_SHAPES, ids=[s[0] for s in _CORRUPT_SHAPES])
def test_both_read_paths_drop_the_same_corrupt_rows(shared, milestone_repo, why, bad_row):
    # THE anti-drift test the card is for: whatever one path rejects, the other must too.
    # Before WHIT-394 the NaN/Infinity/un-floatable rows passed the client read and failed
    # the poller read — the exact divergence that let a broken target reach the screen.
    stored = [_row(id="good"), bad_row]
    _store_raw_row(milestone_repo, stored)

    client_ids = [m["id"] for m in milestone_repo.get_milestones()]
    poller_labels = [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))]

    assert client_ids == ["good"], f"client read kept the {why} row"
    assert poller_labels == ["Halfway"], f"poller read kept the {why} row"


def test_the_target_precision_divergence_is_pinned_not_accidental(shared, milestone_repo):
    # HONEST GAP, deliberately not closed by WHIT-394: a target between ~1e26 and ~1e309 is a
    # fine float (client KEEPS it) but can't quantize to cents (poller DROPS it). Closing it
    # would impose the poller's cent-precision constraint on a client read that has no such
    # need. Unreachable in practice — the save endpoint caps targetBalance at 1e9. Pinned here
    # so it stays a known, chosen difference rather than silent drift.
    # After WHIT-417 closed the date one, this and the missing-`id`-KEY case ([B2], folded
    # in below) are the two divergences left, both hand-edit-only.
    stored = [_row(id="big", targetBalance=Decimal("1e26"))]
    _store_raw_row(milestone_repo, stored)
    assert [m["id"] for m in milestone_repo.get_milestones()] == ["big"]
    assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored)) == []


@pytest.mark.parametrize("not_a_list", ["scalar", 42, {"m1": _GOOD}])
def test_both_read_paths_degrade_a_non_list_plan_to_empty(shared, milestone_repo, not_a_list):
    _store_raw_row(milestone_repo, not_a_list)
    assert milestone_repo.get_milestones() == []
    assert shared.milestones.resolve_plan(FakeMilestoneRepo(not_a_list)) == []


# --- [D] the per-site differences that must SURVIVE unification --------------------------

@pytest.mark.parametrize("bad_row, why", [
    (_row(targetBalance=Decimal("NaN")), "non-numeric target"),
    # WHIT-417: a bad date now reaches the poller's rejection too, so it raises the alarm. That
    # visibility is the upside of the change — before it, such a row was silent on both paths
    # (the client read logs at WARNING with no token, pinned by the test below). Fail-on-revert:
    # drop row_date from _resolve_plan and the row resolves, so no token is ever logged.
    (_row(targetDate="not-a-date"), "unparsable date"),
])
def test_poller_logs_the_alarm_token_at_error(shared, caplog, bad_row, why):
    # The CloudWatch metric filter (terraform/monitoring.tf) string-matches these tokens.
    with caplog.at_level(logging.ERROR, logger="milestones"):
        assert shared.milestones.resolve_plan(FakeMilestoneRepo([bad_row])) == []
    assert "MILESTONE_ROW_MALFORMED" in caplog.text, why


def test_client_read_warns_WITHOUT_any_alarm_token(shared, milestone_repo, caplog):
    # A screen read must NEVER fire the poller's alarm — it would page on nothing. Unifying
    # the validator must not leak the poller's token into the client's log line.
    _store_raw_row(milestone_repo, [_row(targetBalance=Decimal("NaN"))])
    with caplog.at_level(logging.DEBUG):
        assert milestone_repo.get_milestones() == []
    assert "MILESTONE_ROW_MALFORMED" not in caplog.text
    assert "MILESTONE_PLAN_MALFORMED" not in caplog.text
    assert caplog.records and all(r.levelno == logging.WARNING for r in caplog.records)


def test_each_path_keeps_its_own_numeric_type(shared, milestone_repo):
    # The poller compares exact-to-the-cent Decimals (WHIT-384); the client needs a JSON number.
    stored = [_row(targetBalance=Decimal("595413.43"))]
    _store_raw_row(milestone_repo, stored)

    poller_target = shared.milestones.resolve_plan(FakeMilestoneRepo(stored))[0].target_balance
    client_target = milestone_repo.get_milestones()[0]["targetBalance"]

    assert isinstance(poller_target, Decimal) and poller_target == Decimal("595413.43")
    assert isinstance(client_target, float) and client_target == 595413.43


def test_a_null_id_passes_the_client_read_and_a_missing_id_degrades_the_poller_marker(
        shared, milestone_repo):
    # WHIT-378's deliberate carve-out, explicitly preserved by WHIT-394 option B3: id handling
    # is UNCHANGED on both paths. The poller degrades to the amount-only marker; the client
    # still requires the key (its pre-existing behaviour) but a NULL id passes through.
    legacy = {"id": None, "label": "Old", "targetBalance": Decimal("480000"),
              "targetDate": "2030-01-01"}
    _store_raw_row(milestone_repo, [legacy])
    assert milestone_repo.get_milestones() == [
        {"id": None, "label": "Old", "targetBalance": 480000.0, "targetDate": "2030-01-01"}]

    plan = shared.milestones.resolve_plan(FakeMilestoneRepo([{k: v for k, v in legacy.items() if k != "id"}]))
    assert [p.key for p in plan] == ["bal:480000.00"]


def test_a_huge_target_is_skipped_not_raised_through_the_poller(shared, caplog):
    # Regression guard for narrowing the loop's catch to MalformedMilestoneRow: a FINITE but
    # huge target passes the is_finite check and then raises InvalidOperation inside
    # _plan_marker's quantize (from ~1e26 — cent precision exceeds the decimal module's 28
    # working digits). Unwrapped, that escapes _resolve_plan into the poller's swallow and
    # loses every good row's celebration. Fail-on-revert: drop the quantize try/except in
    # _plan_marker -> this raises InvalidOperation instead of asserting.
    stored = [_row(id="good"), _row(id="huge", targetBalance=Decimal("1e26"))]
    with caplog.at_level(logging.ERROR, logger="milestones"):
        plan = shared.milestones.resolve_plan(FakeMilestoneRepo(stored))
    assert [p.label for p in plan] == ["Halfway"]
    assert "MILESTONE_ROW_MALFORMED" in caplog.text


# The crossing-driver both folded suites defined identically; kept once here (WHIT-464).
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


# ==========================================================================
# --- folded from test_milestone_rows_gaps.py (WHIT-464) ---
# ==========================================================================

# --- [B1] PIN: the date rule is shared, so a hidden row does NOT push --------

def test_a_bad_date_row_is_invisible_on_screen_and_does_not_push(shared, milestone_repo, recorder):
    # [B1] WHIT-417 DECIDED this. It used to diverge: targetDate was checked on the client path
    # only, so a row the plan screen hid still sent "Milestone reached - Dated!" — the user
    # tapped the celebration and landed on a plan that milestone wasn't in. Both paths now
    # apply the same rule, so what pushes is what the screen shows.
    # Fail-on-revert (either direction): drop row_date from _resolve_plan and the row pushes
    # again; drop it from _to_client and the screen stops hiding it. Either way, red.
    stored = [_GOOD, {"id": "d", "label": "Dated", "targetBalance": Decimal("120000"),
                      "targetDate": "not-a-date"}]
    _store_raw_row(milestone_repo, stored)

    assert [m["id"] for m in milestone_repo.get_milestones()] == ["keep"]   # screen: gone
    assert [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))] == [
        "Halfway"]                                                         # poller: gone too

    # A poll whose balance crosses the bad row's target celebrates nothing, and records nothing.
    sent, notify = _notify(shared, old="130000", new="119000", stored=stored)
    assert sent == 0
    assert recorder == []
    assert "id:d:bal:120000.00" not in notify.fired


def test_a_repaired_date_does_not_celebrate_again_because_its_marker_survived(shared, recorder):
    # [B1b] The once-ever guarantee has to survive a row being temporarily unreadable. The
    # "already celebrated" marker is what provides it (written with no expiry —
    # repository_notify.py). WHIT-417 made the poller reject a bad date, which used to make that
    # marker look stale and get swept — so repairing the date and crossing the target again
    # congratulated the user a second time for the same milestone. The marker now survives the
    # row being unreadable, so the repair is silent, which is what "once ever" has to mean.
    # Fail-on-revert: build the live set from `plan` again -> the marker is swept in step 1 and
    # the repaired row pushes in step 2.
    broken = _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                  targetDate="not-a-date")
    marker = "id:dated:bal:250000.00"
    notify = FakeNotifyRepo(fired={marker})

    # 1. While broken, a no-crossing poll leaves its marker alone. A healthy row sits alongside
    # so the sweep genuinely runs — an empty plan skips it entirely (WHIT-386, pinned by [B1c]).
    _notify(shared, old="500000", new="450000", stored=[_GOOD, broken], notify=notify)
    assert notify.removed == set()
    assert marker in notify.fired

    # 2. The date is repaired and the balance crosses the target again — already celebrated.
    repaired = _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                    targetDate="2030-01-01")
    sent, notify = _notify(shared, old="260000", new="240000", stored=[_GOOD, repaired],
                           notify=notify)

    assert sent == 0
    assert recorder == []


def test_a_plan_where_every_row_has_a_bad_date_celebrates_nothing(shared, recorder):
    # [B1c] The whole-plan case. Every row is hidden from the screen, so the app falls back to
    # showing the built-in starter plan — but the poller must NOT celebrate the saved rows it
    # can no longer resolve, and must NOT fall back to the built-in plan either (that would
    # send a celebration for a milestone the user never saved). An authoritative empty plan
    # celebrates nothing and, via the WHIT-386 `and plan` guard, sweeps nothing.
    # Fail-on-revert: drop row_date from _resolve_plan -> both rows resolve and push.
    stored = [_row(id="a", label="A", targetBalance=Decimal("300000"), targetDate="not-a-date"),
              _row(id="b", label="B", targetBalance=Decimal("250000"), targetDate="")]
    notify = FakeNotifyRepo(fired={"0"})

    sent, notify = _notify(shared, old="500000", new="200000", stored=stored, notify=notify)

    assert sent == 0
    assert recorder == []
    assert notify.removed == set()                   # nothing swept on an empty plan
    assert "0" in notify.fired


# --- [B2] PIN: a row with no `id` KEY diverges (WHIT-378 carve-out) ---------

def test_a_row_with_no_id_key_at_all_is_dropped_by_the_client_and_kept_by_the_poller(
        shared, milestone_repo):
    # [B2] The implementer's WHIT-378 test uses {"id": None} — a PRESENT key — where both
    # paths agree. A row saved before ids were minted has no `id` key at all: _to_client's
    # row_field(m, "id") raises (repository_milestone.py:66) and drops it, while
    # _plan_marker's milestone.get("id") (milestones.py:82) falls back to "bal:<amount>".
    # The card froze id handling on both paths, so this is deliberate — pinned so a future
    # "unify the last field too" change is a conscious decision, not a silent one.
    legacy = {"label": "Old", "targetBalance": Decimal("480000"), "targetDate": "2030-01-01"}
    _store_raw_row(milestone_repo, [_GOOD, legacy])

    assert [m["id"] for m in milestone_repo.get_milestones()] == ["keep"]
    plan = shared.milestones.resolve_plan(FakeMilestoneRepo([_GOOD, legacy]))
    assert [p.key for p in plan] == ["id:keep:bal:300000.00", "bal:480000.00"]


# --- [B3] the NEW poller-side rejection vs the WHIT-385 marker sweep --------

@pytest.mark.parametrize("bad_row, why", [
    ({"id": "bad", "label": "   ", "targetBalance": Decimal("250000"),
      "targetDate": "2031-01-01"}, "blank label (WHIT-394)"),
    ({"id": "bad", "label": "Dated", "targetBalance": Decimal("250000"),
      "targetDate": "not-a-date"}, "unparsable date (WHIT-417)"),
])
def test_an_unreadable_row_keeps_its_marker_but_a_deleted_one_loses_it(
        shared, recorder, bad_row, why):
    # [B3] The sweep removes markers for milestones that are GONE — deleted, or re-targeted so
    # they key to a new amount. Each time a read path gained a rejection (WHIT-394's blank
    # label, WHIT-417's bad date) an unreadable row started resolving out of the plan and looked
    # deleted too, so its once-ever record was wiped and the celebration could happen twice.
    # The live set is now built from every stored row we can KEY, so "unreadable" and "deleted"
    # are told apart. Both halves are asserted in one poll so neither can regress alone.
    # Fail-on-revert: build the live set from `plan` again -> the bad row's marker is swept.
    stored = [_row(id="keep", label="Halfway", targetBalance=Decimal("300000")), bad_row]
    keep_marker, bad_marker = "id:keep:bal:300000.00", "id:bad:bal:250000.00"
    gone_marker = "id:gone:bal:999000.00"            # a row genuinely no longer in the plan
    notify = FakeNotifyRepo(fired={keep_marker, bad_marker, gone_marker, "0"})

    # A no-crossing poll: the sweep runs on its own, before any celebration logic.
    sent, notify = _notify(shared, old="500000", new="450000", stored=stored, notify=notify)

    assert sent == 0
    assert recorder == []
    assert notify.removed == {gone_marker}, why      # only the row that is actually gone
    assert bad_marker in notify.fired, why           # unreadable != deleted
    assert keep_marker in notify.fired               # healthy row's record intact
    assert "0" in notify.fired                       # built-in sprint marker never swept


# --- [B4] the nesting trap, for row_date this time --------------------------

def test_a_missing_target_date_is_not_rewrapped_as_unparsable(shared):
    # [B4] row_date wraps date.fromisoformat in `except ValueError`, and
    # MalformedMilestoneRow IS a ValueError — so if row_field is ever moved inside that try,
    # a MISSING targetDate is caught and re-raised as "unparsable", destroying the log line
    # that tells you which field is actually broken. The implementer pinned this for
    # row_target; row_date has the identical shape and was left unpinned.
    rows = shared.milestone_rows
    with pytest.raises(rows.MalformedMilestoneRow, match="missing targetDate"):
        rows.row_date({"id": "m1", "label": "No date"}, "targetDate")
    with pytest.raises(rows.MalformedMilestoneRow, match="unparsable targetDate"):
        rows.row_date(_row(targetDate="not-a-date"), "targetDate")


# --- [B5] the exact float-overflow boundary ---------------------------------

def test_the_float_overflow_boundary_is_exactly_the_largest_float(shared):
    # [B5] The implementer pins 1e300 (ok) and 1e309 (rejected), leaving the real edge —
    # sys.float_info.max, ~1.797e308 — untested in between. The largest representable float
    # must still be READ (an over-strict cap would silently delete a legitimate row), and the
    # first value past it must be rejected (float() turns it into inf, which serialises as a
    # bare Infinity token). Fail-on-revert: drop the math.isfinite check in row_target_float
    # -> the second half returns inf instead of raising.
    largest = Decimal(repr(sys.float_info.max))
    assert shared.milestone_rows.row_target_float(_row(targetBalance=largest)) == sys.float_info.max

    just_over = Decimal("1.8e308")          # > 1.7976931348623157e308, still << 1e309
    assert just_over.is_finite()            # a perfectly fine Decimal...
    with pytest.raises(shared.milestone_rows.MalformedMilestoneRow):
        shared.milestone_rows.row_target_float(_row(targetBalance=just_over))


# ==========================================================================
# --- folded from test_milestones_whit417_gaps.py (WHIT-464) ---
# ==========================================================================

# --- [E1] the date shapes the parity table doesn't carry --------------------

_UNCOVERED_BAD_DATES = [
    ("iso datetime", "2030-01-01T00:00:00"),      # date.fromisoformat rejects a time component
    ("leading whitespace", " 2030-01-01"),
    ("trailing whitespace", "2030-01-01 "),
    ("utc suffix", "2030-01-01Z"),
    ("offset suffix", "2030-01-01+10:00"),
    ("bool", True),
    ("decimal", Decimal("2030")),
    ("bytes", b"2030-01-01"),
    ("int", 20300101),
]


@pytest.mark.parametrize("why, bad_date", _UNCOVERED_BAD_DATES,
                         ids=[s[0] for s in _UNCOVERED_BAD_DATES])
def test_every_other_bad_date_shape_is_dropped_by_both_read_paths(
        shared, milestone_repo, why, bad_date):
    # [E1] The card's rule is "what pushes is what the screen shows". That has to hold for the
    # whole rejected set, not the three shapes the parity table happens to list — a date that
    # is a datetime, padded, zoned, or simply not text is just as unshowable.
    # Fail-on-revert: drop row_date from _resolve_plan -> the poller keeps every one of these.
    stored = [_row(id="good"), _row(id="bad", label="Bad", targetDate=bad_date)]
    _store_raw_row(milestone_repo, stored)

    assert [m["id"] for m in milestone_repo.get_milestones()] == ["good"], f"screen kept {why}"
    assert [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))] == [
        "Halfway"], f"poller kept {why}"


def test_a_row_with_no_target_date_key_at_all_is_dropped_by_both_read_paths(
        shared, milestone_repo):
    # [E1] A MISSING key is a different branch from a null value: row_field raises before
    # fromisoformat is ever reached (milestone_rows.py:78), and the log line must name the
    # missing field rather than call it unparsable. The parity table carries "missing target"
    # but never "missing date".
    no_date = {"id": "bad", "label": "No date", "targetBalance": Decimal("250000")}
    stored = [_row(id="good"), no_date]
    _store_raw_row(milestone_repo, stored)

    assert [m["id"] for m in milestone_repo.get_milestones()] == ["good"]
    assert [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))] == [
        "Halfway"]


# --- [E2] the leniency is shared too ----------------------------------------

@pytest.mark.parametrize("lenient_date", ["20300101", "2030-W01-1"])
def test_a_date_only_fromisoformat_accepts_is_now_rejected_by_both_read_paths(
        shared, milestone_repo, lenient_date):
    # [E2] WHIT-418 made the read bar the one shared validator (a ^\d{4}-\d{2}-\d{2}$ regex AND the
    # calendar check), the same rule the save endpoint uses — no longer bare date.fromisoformat,
    # which on python 3.11+ (the lambdas run 3.12 — terraform/lambda.tf) accepts these basic and
    # week-date ISO forms. So a hand-edited row holding one is now dropped by BOTH read paths, the
    # screen and the poller agreeing. Pinning the pair keeps the tightening a both-paths change:
    # loosen one side and this goes red.
    stored = [_row(id="lenient", label="Lenient", targetDate=lenient_date)]
    _store_raw_row(milestone_repo, stored)

    assert milestone_repo.get_milestones() == []
    assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored)) == []


# --- [E3] a bad row FIRST costs no more than a bad row LAST -----------------

@pytest.mark.parametrize("position", ["first", "last", "middle"])
def test_a_bad_date_row_costs_only_itself_wherever_it_sits(shared, recorder, position):
    # [E3] The loop must SKIP, not stop. An early break/return would make the damage depend on
    # where the corrupt row happens to sit in the saved list — the rows after it would silently
    # stop celebrating, and (via the WHIT-385 sweep) lose their once-ever markers too.
    # Fail-on-revert: replace the `except` body in _resolve_plan with `return [], True` -> the
    # "first" and "middle" cases lose their push.
    bad = _row(id="bad", label="Bad", targetBalance=Decimal("250000"), targetDate="not-a-date")
    a = _row(id="a", label="A", targetBalance=Decimal("400000"))
    b = _row(id="b", label="B", targetBalance=Decimal("300000"))
    stored = {"first": [bad, a, b], "middle": [a, bad, b], "last": [a, b, bad]}[position]

    assert [p.label for p in shared.milestones.resolve_plan(FakeMilestoneRepo(stored))] == [
        "A", "B"]

    # ...and the survivors still celebrate: a poll past every target pushes the furthest one.
    sent, notify = _notify(shared, old="500000", new="240000", stored=stored)
    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — B!"     # lowest surviving target
    assert notify.fired == {"id:a:bal:400000.00", "id:b:bal:300000.00"}


# --- [E4] sweeping a stale marker must not cost the poll its celebration ----

def test_the_sweep_and_a_real_celebration_survive_the_same_poll(shared, recorder):
    # [E4] [B3] sweeps on a no-crossing poll. The sweep runs BEFORE the crossing check and
    # reuses the marker set it read, deliberately WITHOUT subtracting the keys it just deleted.
    # If a fresh key could ever land in `stale`, the deleted marker would still be in `fired`
    # and the genuine push would be swallowed. Prove the two coexist in one poll: a genuinely
    # gone milestone's marker is swept, and the good row's crossing still pushes.
    # The stale marker has to be one no stored row keys to — an unreadable row keeps its marker
    # now, so a bad-date row would sweep nothing and this would prove only half of itself.
    stored = [_row(id="good", label="Good", targetBalance=Decimal("300000")),
              _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                   targetDate="not-a-date")]
    gone = "id:deleted:bal:900000.00"
    notify = FakeNotifyRepo(fired={gone, "id:dated:bal:250000.00"})

    sent, notify = _notify(shared, old="310000", new="240000", stored=stored, notify=notify)

    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Good!"
    assert notify.removed == {gone}                       # swept in the same poll
    assert "id:good:bal:300000.00" in notify.fired        # and the real crossing was recorded
    assert "id:dated:bal:250000.00" in notify.fired       # the unreadable row kept its record


# --- [E5] the alarm the card relies on can actually fire --------------------

def test_the_terraform_metric_filter_matches_the_line_a_bad_date_emits(shared, caplog):
    # [E5] "The row now raises MILESTONE_ROW_MALFORMED, so the existing CloudWatch alarm starts
    # firing for it" is the stated upside of WHIT-417 — and it is infrastructure, so nothing in
    # the python suite checks it. The pattern is READ OUT of terraform/monitoring.tf rather than
    # retyped, so renaming the token on either side goes red.
    # CloudWatch text filter terms match whitespace-delimited words, so the token has to sit in
    # the line as a bare word — a "MILESTONE_ROW_MALFORMED:" prefix would NOT match the filter.
    tf = (pathlib.Path(__file__).resolve().parents[2] / "terraform" / "monitoring.tf").read_text()
    pattern = re.search(
        r'resource "aws_cloudwatch_log_metric_filter" "milestone_row_malformed".*?'
        r'pattern\s*=\s*"([^"]+)"', tf, re.S).group(1)
    terms = re.findall(r"\?(\S+)", pattern)
    assert "MILESTONE_ROW_MALFORMED" in terms, f"terraform pattern changed: {pattern!r}"

    with caplog.at_level(logging.ERROR, logger="milestones"):
        assert shared.milestones.resolve_plan(
            FakeMilestoneRepo([_row(targetDate="not-a-date")])) == []
    line = caplog.records[0].getMessage()
    assert "MILESTONE_ROW_MALFORMED" in line.split(), (
        f"the emitted line has no bare {terms} word for the metric filter to match: {line!r}")


# --- [E6] an all-bad-date plan touches the marker store at all -------------

def test_an_all_bad_date_plan_does_no_marker_io_whatsoever(shared, recorder):
    # [E6] [B1c] asserts nothing was REMOVED, which is also true of a plan that read the marker
    # set and found nothing stale. The stronger property is that an authoritative EMPTY plan
    # never reads it either: the WHIT-386 `and plan` guard skips the sweep, and the empty
    # crossing list returns before the dedup read. That is what keeps a corrupt plan from
    # costing a DynamoDB read on every daily poll, and what makes "sweeps nothing" structural
    # rather than incidental.
    stored = [_row(id="a", label="A", targetDate="not-a-date"),
              _row(id="b", label="B", targetBalance=Decimal("250000"), targetDate=None)]
    notify = FakeNotifyRepo(fired={"id:a:bal:300000.00", "0"})

    sent, notify = _notify(shared, old="500000", new="200000", stored=stored, notify=notify)

    assert sent == 0
    assert recorder == []
    assert notify.reads == 0, "an empty plan must not even read the marker set"
    assert notify.removed == set()
    assert notify.fired == {"id:a:bal:300000.00", "0"}
