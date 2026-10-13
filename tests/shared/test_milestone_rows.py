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

import logging
import re
from decimal import Decimal

import pytest

# Shared milestone fakes + row fixtures (WHIT-445). The one good stored row (_GOOD) and the
# raw-row injector are shared so the row shape can't drift between the parity suites.
from _milestone_fakes import (
    FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, notify_repo, recorder,
    removed_markers, stored_markers,
)
from _milestone_row_fakes import _GOOD, _row, _store_raw_row
from _terraform import filter_pattern


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


# --- [C] the client read gains the missing rejections ------------------------------------


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
    ("iso datetime date", _row(targetDate="2030-01-01T00:00:00")),
    ("utc suffix date", _row(targetDate="2030-01-01Z")),
    ("int date", _row(targetDate=20300101)),
    # basic and week-date forms date.fromisoformat accepts on 3.11+; the shared validator doesn't
    ("basic iso date", _row(targetDate="20300101")),
    ("week iso date", _row(targetDate="2030-W01-1")),
    ("missing date key", {"id": "bad", "label": "No date", "targetBalance": Decimal("250000")}),
    ("missing id key", {"label": "Old", "targetBalance": Decimal("480000"), "targetDate": "2030-01-01"}),
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
    poller_labels = [p.label for p in shared.milestones._resolve_plan(FakeMilestoneRepo(stored))[0]]

    assert client_ids == ["good"], f"client read kept the {why} row"
    assert poller_labels == ["Halfway"], f"poller read kept the {why} row"


@pytest.mark.parametrize("not_a_list", ["scalar", 42, {"m1": _GOOD}])
def test_both_read_paths_degrade_a_non_list_plan_to_empty(shared, milestone_repo, not_a_list):
    _store_raw_row(milestone_repo, not_a_list)
    assert milestone_repo.get_milestones() == []
    assert shared.milestones._resolve_plan(FakeMilestoneRepo(not_a_list))[0] == []


# --- [D] the per-site differences that must SURVIVE unification --------------------------

def test_poller_logs_the_alarm_token_at_error(shared, caplog):
    # The CloudWatch metric filter (terraform/monitoring.tf) string-matches these tokens.
    with caplog.at_level(logging.ERROR, logger="milestones"):
        assert shared.milestones._resolve_plan(FakeMilestoneRepo([_row(targetBalance=Decimal("NaN"))]))[0] == []
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

    poller_target = shared.milestones._resolve_plan(FakeMilestoneRepo(stored))[0][0].target_balance
    client_target = milestone_repo.get_milestones()[0]["targetBalance"]

    assert isinstance(poller_target, Decimal) and poller_target == Decimal("595413.43")
    assert isinstance(client_target, float) and client_target == 595413.43


def test_a_null_id_passes_the_client_read_but_the_poller_skips_it(shared, milestone_repo):
    # The client read still requires only the id KEY, so a NULL id passes through to the screen,
    # while the poller (WHIT-830) skips the row: it has no id to key a celebration on. Pinned so
    # unifying the two is a conscious decision. The save endpoint rejects a null id, so only a
    # direct write can store one.
    legacy = {"id": None, "label": "Old", "targetBalance": Decimal("480000"),
              "targetDate": "2030-01-01"}
    _store_raw_row(milestone_repo, [legacy])
    assert milestone_repo.get_milestones() == [
        {"id": None, "label": "Old", "targetBalance": 480000.0, "targetDate": "2030-01-01"}]

    assert shared.milestones._resolve_plan(FakeMilestoneRepo([legacy]))[0] == []


# The crossing-driver both folded suites defined identically; kept once here (WHIT-464).
def _notify(shared, *, old, new, stored, notify=None):
    notify = notify or notify_repo()
    sent = shared.milestones.notify_milestone_crossing(
        Decimal(old), Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(),
        device_repo=FakeDeviceRepo(),
        notify_repo=notify,
        milestone_repo=FakeMilestoneRepo(stored),
    )
    return sent, notify


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
    assert [p.label for p in shared.milestones._resolve_plan(FakeMilestoneRepo(stored))[0]] == [
        "Halfway"]                                                         # poller: gone too

    # A poll whose balance crosses the bad row's target celebrates nothing, and records nothing.
    sent, notify = _notify(shared, old="130000", new="119000", stored=stored)
    assert sent == 0
    assert recorder == []
    assert "id:d:bal:120000.00" not in stored_markers(notify)


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
    notify = notify_repo(fired={marker})

    # 1. While broken, a no-crossing poll leaves its marker alone. A healthy row sits alongside
    # so the sweep genuinely runs — an empty plan skips it entirely (WHIT-386, pinned by [B1c]).
    _notify(shared, old="500000", new="450000", stored=[_GOOD, broken], notify=notify)
    assert removed_markers(notify) == set()
    assert marker in stored_markers(notify)

    # 2. The date is repaired and the balance crosses the target again — already celebrated.
    repaired = _row(id="dated", label="Dated", targetBalance=Decimal("250000"),
                    targetDate="2030-01-01")
    sent, notify = _notify(shared, old="260000", new="240000", stored=[_GOOD, repaired],
                           notify=notify)

    assert sent == 0
    assert recorder == []


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

    assert [p.label for p in shared.milestones._resolve_plan(FakeMilestoneRepo(stored))[0]] == [
        "A", "B"]

    # ...and the survivors still celebrate: a poll past every target pushes the furthest one.
    sent, notify = _notify(shared, old="500000", new="240000", stored=stored)
    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — B!"     # lowest surviving target
    assert stored_markers(notify) == {"id:a:bal:400000.00", "id:b:bal:300000.00"}


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
    notify = notify_repo(fired={gone, "id:dated:bal:250000.00"})

    sent, notify = _notify(shared, old="310000", new="240000", stored=stored, notify=notify)

    assert sent == 1
    assert recorder[-1][0] == "\U0001f389 Milestone reached — Good!"
    assert removed_markers(notify) == {gone}                       # swept in the same poll
    assert "id:good:bal:300000.00" in stored_markers(notify)        # and the real crossing was recorded
    assert "id:dated:bal:250000.00" in stored_markers(notify)       # the unreadable row kept its record


# --- [E5] the alarm the card relies on can actually fire --------------------

def test_the_terraform_metric_filter_matches_the_line_a_bad_date_emits(shared, caplog):
    # [E5] "The row now raises MILESTONE_ROW_MALFORMED, so the existing CloudWatch alarm starts
    # firing for it" is the stated upside of WHIT-417 — and it is infrastructure, so nothing in
    # the python suite checks it. The pattern is READ OUT of terraform/monitoring.tf rather than
    # retyped, so renaming the token on either side goes red.
    # CloudWatch text filter terms match whitespace-delimited words, so the token has to sit in
    # the line as a bare word — a "MILESTONE_ROW_MALFORMED:" prefix would NOT match the filter.
    pattern = filter_pattern("milestone_row_malformed")
    terms = re.findall(r"\?(\S+)", pattern)
    assert "MILESTONE_ROW_MALFORMED" in terms, f"terraform pattern changed: {pattern!r}"

    with caplog.at_level(logging.ERROR, logger="milestones"):
        assert shared.milestones._resolve_plan(
            FakeMilestoneRepo([_row(targetDate="not-a-date")]))[0] == []
    line = caplog.records[0].getMessage()
    assert "MILESTONE_ROW_MALFORMED" in line.split(), (
        f"the emitted line has no bare {terms} word for the metric filter to match: {line!r}")
