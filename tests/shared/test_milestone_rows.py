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
from decimal import Decimal

import pytest


def _store_raw_row(milestone_repo, milestones, scope="SHARED"):
    """Inject a stored row directly, bypassing set_milestones' validation, to mimic a legacy
    or partially-written row (mirrors tests/shared/test_repository_milestone_edges.py)."""
    milestone_repo._table.store[("MILESTONES", scope)] = {
        "pk": "MILESTONES", "sk": scope, "milestones": milestones,
    }


_GOOD = {"id": "m1", "label": "Halfway", "targetBalance": Decimal("300000"),
         "targetDate": "2030-01-01"}


def _row(**overrides):
    return {**_GOOD, **overrides}


class FakeMilestoneRepo:
    """The poller's read surface: get_milestones_raw returns the stored list verbatim."""

    def __init__(self, stored):
        self._stored = stored

    def get_milestones_raw(self, scope=None):
        return self._stored


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


@pytest.mark.parametrize("bad_row, why", [
    # Date shapes only — the blank/null LABEL cases are in _CORRUPT_SHAPES below, since both
    # paths reject those. The date rule is client-only, so it can't live in the parity table.
    (_row(targetDate=""), "blank date"),
    (_row(targetDate=None), "null date"),
    (_row(targetDate="not-a-date"), "unparsable date"),
])
def test_client_read_skips_an_unparsable_date(shared, milestone_repo, bad_row, why):
    # WHIT-394 option B3. A null targetDate reaches _review_candidates' date.fromisoformat,
    # which raises OUTSIDE any per-row guard -> a 500 on the review endpoint. Fail-on-revert:
    # swap row_text/row_date back for a plain lookup and the bad row survives.
    _store_raw_row(milestone_repo, [_row(id="good"), {**bad_row, "id": "bad"}])
    assert [m["id"] for m in milestone_repo.get_milestones()] == ["good"], why


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
    # NOT the only divergence — the client-only date rule and the missing-`id`-KEY case are
    # pinned in test_milestone_rows_gaps.py [B1]/[B2].
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

def test_poller_logs_the_alarm_token_at_error(shared, caplog):
    # The CloudWatch metric filter (terraform/monitoring.tf) string-matches these tokens.
    stored = [_row(targetBalance=Decimal("NaN"))]
    with caplog.at_level(logging.ERROR, logger="milestones"):
        assert shared.milestones.resolve_plan(FakeMilestoneRepo(stored)) == []
    assert "MILESTONE_ROW_MALFORMED" in caplog.text


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


def test_a_legacy_row_without_an_id_is_still_tolerated_on_both_paths(shared, milestone_repo):
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
