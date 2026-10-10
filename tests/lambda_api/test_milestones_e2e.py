"""WHIT-465 e2e — the milestone READ/SAVE + poller paths end to end over the REAL repository.

Each test drives the REAL MilestoneRepository (real _to_client / _resolve_plan) and NotifyRepository
over a FakeTable, through lambda_handler and/or the poller's notify_milestone_crossing over ONE shared
store — the seam no shared-layer unit test can reach.

  [A6] GET /milestones body is strict-parsable JSON (no NaN/Infinity token), corrupt row absent.
  [A7] over-rejection guard (client read): every row PUT accepts survives GET.
  [F1] every row PUT accepts still resolves in the poller.
  [W2] retargeting through a second PUT sweeps the old marker and re-arms the new amount.
  [W3] the save endpoint rejects a shape-matching-but-uncalendar date (one shared validator).
  WHIT-830: the save rejects a row without an id (missing or null); ids sent are kept.

The `poller` fixture imports shared/milestones.py in the handler's sys.path window (the module the
balance poller loads) and restores the module table afterwards, so the shared-layer suite is
untouched.
"""

import json
import sys
from decimal import Decimal

import pytest

from _api_event import api_event
from _dynamo_fakes import FakeTable
from _milestone_fakes import milestones_put_event, notify_repo, removed_markers, stored_markers


# --- harness ----------------------------------------------------------------

@pytest.fixture
def milestone_repo(handler, monkeypatch):
    # Swaps handler.MilestoneRepository to this real repo (backed by an in-memory table) so every
    # test driving lambda_handler / the poller reads and writes the one store.
    repo = handler.MilestoneRepository()
    repo._table = FakeTable()
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: repo)
    return repo


@pytest.fixture
def poller(handler):
    """shared/milestones.py — the module lambda_balance_poller/handler.py imports. Restored
    afterwards so the shared-layer suite's own import isolation is unaffected. Saves the superset
    of module names any merged test touches (milestones, milestone_rows, iso_date)."""
    saved = {name: sys.modules.get(name) for name in ("milestones", "milestone_rows", "iso_date")}
    import milestones
    try:
        yield milestones
    finally:
        for name, mod in saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


class FakeDeviceRepo:
    def list_tokens(self):
        return ["tok"]


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return None


def _get_event():
    return api_event("GET", "/milestones", raw="")


def _store_raw(repo, rows, scope="SHARED"):
    """Inject stored rows directly, bypassing set_milestones' validation — a legacy or
    directly-written row (mirrors tests/shared/test_repository_milestone.py)."""
    repo._table.store[("MILESTONES", scope)] = {
        "pk": "MILESTONES", "sk": scope, "milestones": rows,
    }


GOOD = {"id": "good", "label": "Quarter down", "targetBalance": Decimal("400000"),
        "targetDate": "2030-01-01"}


def _row(**overrides):
    return {**GOOD, **overrides}


# === [A6]/[A8] GET /milestones body is strict JSON, corrupt rows dropped =====================

@pytest.mark.parametrize("bad_target", [Decimal("NaN"), Decimal("Infinity"), Decimal("-Infinity")])
def test_get_milestones_body_is_strict_json_without_the_corrupt_row(
        handler, milestone_repo, bad_target):
    # [A6] The literal HTTP body, not the repo return value. json.dumps defaults to
    # allow_nan=True and emits bare NaN/Infinity tokens, which no JSON parser outside
    # Python accepts — so ONE corrupt row made the whole plan unreadable to the app, not
    # just that row. json.loads is deliberately given parse_constant, because Python's own
    # json.loads happily reads those tokens back and would hide the bug.
    _store_raw(milestone_repo, [GOOD, _row(id="bad", targetBalance=bad_target)])

    resp = handler.lambda_handler(_get_event(), None)
    assert resp["statusCode"] == 200
    def _reject(token):
        raise AssertionError(f"non-JSON token {token!r} in the milestones body")
    parsed = json.loads(resp["body"], parse_constant=_reject)
    assert parsed == [{"id": "good", "label": "Quarter down",
                       "targetBalance": 400000.0, "targetDate": "2030-01-01"}]


# === [A7] the over-rejection guard (client read): a saved row must never vanish ==============

_ROUND_TRIP = [
    {"id": "r1", "label": "x" * 100, "targetBalance": 1_000_000_000, "targetDate": "2027-02-28"},
    {"id": "r2", "label": "Ünïcödé 🎉 目標", "targetBalance": 595413.43, "targetDate": "2028-02-29"},
    {"id": "r3", "label": "Paid off", "targetBalance": 0, "targetDate": "2030-12-31"},
]


def test_every_row_the_save_endpoint_accepts_survives_the_read(handler, milestone_repo):
    # [A7] The risk WHIT-394 introduces is the mirror of the bug it fixes: a read rule
    # STRICTER than the write rule silently deletes rows from a user's saved plan on the
    # way back. Boundary rows on purpose — the balance cap, a 0 balance, a 100-char label,
    # a non-ASCII label, and a leap day (which date.fromisoformat only accepts in a leap
    # year). PUT then GET through lambda_handler, one repository, no fakes in between.
    put = handler.lambda_handler(milestones_put_event(_ROUND_TRIP), None)
    assert put["statusCode"] == 200, put["body"]
    assert len(json.loads(put["body"])) == 3, "set_milestones' own return dropped a row"

    got = json.loads(handler.lambda_handler(_get_event(), None)["body"])
    assert [m["label"] for m in got] == [r["label"] for r in _ROUND_TRIP]
    assert [m["targetBalance"] for m in got] == [1_000_000_000.0, 595413.43, 0.0]
    assert [m["targetDate"] for m in got] == [r["targetDate"] for r in _ROUND_TRIP]


# === [F1] the over-rejection guard for the POLLER path ==================================

_SAVED_PLAN = [
    {"id": "r6", "label": "x" * 100, "targetBalance": 1_000_000_000, "targetDate": "2027-02-28"},
    {"id": "r7", "label": "Ünïcödé 🎉 目標", "targetBalance": 595413.43, "targetDate": "2028-02-29"},
    {"id": "r8", "label": "Paid off", "targetBalance": 0, "targetDate": "2030-12-31"},
]


def test_every_row_the_save_endpoint_accepts_still_resolves_for_the_poller(
        handler, milestone_repo, poller):
    # [F1] The mirror of the bug WHIT-417 fixes. Boundary rows on purpose: the balance cap, a
    # cents target, a 0 balance, a 100-char label, a non-ASCII label, and a leap day (which
    # date.fromisoformat only accepts in a leap year — 2028 is one, so this row is legal and
    # MUST survive). PUT through the real handler, then read back through the real
    # _resolve_plan, exactly as the daily poll does.
    # Fail-on-revert: make row_date stricter than the save endpoint (e.g. reject Feb 29) and
    # the leap-day row vanishes from the plan here.
    put = handler.lambda_handler(milestones_put_event(_SAVED_PLAN), None)
    assert put["statusCode"] == 200, put["body"]
    saved = json.loads(put["body"])

    plan = poller._resolve_plan(milestone_repo)[0]
    assert [p.label for p in plan] == [r["label"] for r in _SAVED_PLAN]
    assert [p.target_balance for p in plan] == [
        Decimal("1000000000"), Decimal("595413.43"), Decimal("0")]
    # the dedup markers are the id-keyed ones, so each row's celebration stays once-ever
    assert [p.key for p in plan] == [
        f"id:{saved[0]['id']}:bal:1000000000.00",
        f"id:{saved[1]['id']}:bal:595413.43",
        f"id:{saved[2]['id']}:bal:0.00",
    ]


# === [W2]-[W3] retargeting through the endpoint, and the one shared date validator ==========

_RETARGET_PLAN = [
    {"id": "r9", "label": "Deposit", "targetBalance": 480000, "targetDate": "2027-01-01"},
    {"id": "r10", "label": "Halfway", "targetBalance": 300000, "targetDate": "2028-01-01"},
]


def _saved_ids(put_result):
    assert put_result["statusCode"] == 200, put_result["body"]
    return [r["id"] for r in json.loads(put_result["body"])]


def _poll(poller, repo, notify, pushes, *, old, new):
    def _send(title, body, tokens, **kw):
        pushes.append(title)
    return poller.notify_milestone_crossing(
        Decimal(old), Decimal(new),
        loanfacts_repo=FakeLoanFactsRepo(), device_repo=FakeDeviceRepo(),
        notify_repo=notify, milestone_repo=repo)


def test_retargeting_through_the_endpoint_sweeps_the_old_marker_and_rearms(
        handler, milestone_repo, poller, monkeypatch):
    pushes = []
    monkeypatch.setattr(poller, "send_push", lambda t, b, tok, **kw: pushes.append(t))

    ids = _saved_ids(handler.lambda_handler(milestones_put_event(_RETARGET_PLAN), None))
    old_marker = f"id:{ids[1]}:bal:300000.00"
    new_marker = f"id:{ids[1]}:bal:250000.00"

    notify = notify_repo()
    _poll(poller, milestone_repo, notify, pushes, old="500000", new="250000")
    assert old_marker in stored_markers(notify)

    # Re-target Halfway 300000 -> 250000 through a real PUT (same id preserved). "Gone" now means
    # the OLD amount is gone: it keys to a new marker, so the old one must be reaped.
    handler.lambda_handler(milestones_put_event(
        [{**_RETARGET_PLAN[0], "id": ids[0]},
         {"id": ids[1], "label": "Halfway", "targetBalance": 250000, "targetDate": "2028-01-01"}]), None)

    # A no-crossing poll high above every target: the sweep reaps the stale old marker.
    pushes.clear()
    assert _poll(poller, milestone_repo, notify, pushes, old="600000", new="550000") == 0
    assert old_marker in removed_markers(notify)
    assert new_marker not in stored_markers(notify)            # the new target hasn't been crossed yet

    # Cross the NEW target -> a fresh celebration (the re-arm), exactly once.
    pushes.clear()
    assert _poll(poller, milestone_repo, notify, pushes, old="260000", new="240000") == 1
    assert pushes == ["\U0001f389 Milestone reached — Halfway!"]
    assert new_marker in stored_markers(notify)


@pytest.mark.parametrize("bad_date", ["２０３０-01-01", "2030-01-01\n", "2030-00-10"])
def test_the_save_endpoint_rejects_a_shape_matching_but_uncalendar_date(handler, bad_date):
    # WHIT-418 folds the save endpoint's payoffGoalDate/targetDate guard onto valid_iso_date, so a
    # Unicode-digit date (passes ISO_DATE_RE's `\d`), a trailing-newline date (passes `$`) and a
    # month-00 date (passes the shape) are all 400s — the SAME rule the reads reject them by.
    row = {"label": "Bad", "targetBalance": 300000, "targetDate": bad_date}
    resp = handler.lambda_handler(milestones_put_event([row]), None)
    assert resp["statusCode"] == 400, resp["body"]
    assert "targetDate" in resp["body"]

# --- WHIT-830: the save requires an id on every row ---------------------------

_KICKOFF = {"label": "Kickoff", "targetBalance": 544000, "targetDate": "2026-06-18"}
_HALFWAY = {"id": "half", "label": "Halfway", "targetBalance": 295000, "targetDate": "2027-12-18"}


@pytest.mark.parametrize("first_row, status", [
    pytest.param(_KICKOFF, 400, id="id key missing"),
    pytest.param({**_KICKOFF, "id": None}, 400, id="id explicitly null"),
    pytest.param({**_KICKOFF, "id": "kick"}, 200, id="id supplied"),
])
def test_user_can_save_a_plan_only_when_every_milestone_has_an_id(handler, milestone_repo, first_row, status):
    resp = handler.set_milestones(milestones_put_event([first_row, _HALFWAY]), milestone_repo)

    assert resp["statusCode"] == status
    body = json.loads(resp["body"])
    if status == 400:
        assert body == {"error": "milestone id is required"}
        assert milestone_repo.get_milestones() is None
        return
    assert [m["id"] for m in body] == ["kick", "half"]
    assert [m["id"] for m in milestone_repo.get_milestones()] == ["kick", "half"]
