"""WHIT-424 — the "keep the marker of an unreadable-but-identifiable row" fix, END TO END,
at the level Jasmine would actually see it.

The unit tests (folded into test_milestones_custom_plan.py, WHIT-472) drive
_resolve_plan / notify with a hand-built FakeMilestoneRepo. Nothing proves the fix through the
REAL path: a plan saved by PUT /milestones, stored, read back by the real MilestoneRepository
and the real _resolve_plan the balance poller runs — the seam where a store-shaped surprise
(the whole item round-tripped, ids minted by the handler) could bite.

  [W1] A row whose stored target goes unreadable KEEPS its "already celebrated" marker across
       repeated polls, and repairing the amount + re-crossing does NOT congratulate a second
       time. This is the card's Part B done-definition spelled out through the endpoint.
  [W2] The mirror ("gone stays gone"), also end to end: RE-TARGETING a milestone through a second
       PUT sweeps its old marker and re-arms the new amount, so the new target celebrates once.
  [W3] Part A cross-check on the WRITE side: the save endpoint rejects a shape-matching-but-
       uncalendar date (a Unicode-digit YYYY-MM-DD) with the same shared validator the reads use.

The `poller` fixture imports shared/milestones.py in the handler's sys.path window — the same
module the balance poller loads — and restores the module table afterwards, mirroring
test_milestones_whit417_e2e_gaps.py so the sibling suites are untouched.
"""

import json
import sys
from decimal import Decimal

import pytest


class FakeConfigTable:
    """The single-config-item slice of DynamoDB MilestoneRepository uses; injected as repo._table
    so the real set_milestones / _read_milestones / _resolve_plan run unmodified."""

    def __init__(self):
        self.store = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        self.store[(Item["pk"], Item["sk"])] = dict(Item)


@pytest.fixture
def milestone_repo(handler, monkeypatch):
    repo = handler.MilestoneRepository()
    repo._table = FakeConfigTable()
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: repo)
    return repo


@pytest.fixture
def poller(handler):
    """shared/milestones.py — the module lambda_balance_poller/handler.py imports. Restored
    afterwards so the shared-layer suite's own import isolation is unaffected."""
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


def _put_event(rows):
    return {"rawPath": "/milestones", "requestContext": {"http": {"method": "PUT"}},
            "body": json.dumps({"milestones": rows}), "isBase64Encoded": False}


class FakeDeviceRepo:
    def list_tokens(self):
        return ["tok"]


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return None


class FakeNotifyRepo:
    """One instance is reused across several polls in a test, so it accumulates fired markers and
    removals exactly like the real DynamoDB-backed marker set does between daily polls."""

    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.removed = set()

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        self.removed |= set(keys)
        self.fired -= set(keys)


_PLAN = [
    {"label": "Deposit", "targetBalance": 480000, "targetDate": "2027-01-01"},
    {"label": "Halfway", "targetBalance": 300000, "targetDate": "2028-01-01"},
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


def _corrupt_target_in_store(repo, index, value="oops"):
    """Make one stored row's target unreadable at the STORE level — the shape a legacy/direct
    write leaves behind. row_target(Decimal("oops")) raises, so _plan_marker can't rebuild the
    exact key; the row's readable id is all WHIT-424 has left to hold its markers by."""
    stored = repo._table.store[("MILESTONES", "SHARED")]["milestones"]
    stored[index] = {**stored[index], "targetBalance": value}


# --- [W1] the fix: an unreadable target keeps its marker and never fires twice ----------------

def test_a_corrupted_target_keeps_its_marker_across_polls_and_never_fires_twice(
        handler, milestone_repo, poller, monkeypatch):
    pushes = []
    monkeypatch.setattr(poller, "send_push", lambda t, b, tok, **kw: pushes.append(t))

    ids = _saved_ids(handler.lambda_handler(_put_event(_PLAN), None))
    halfway_marker = f"id:{ids[1]}:bal:300000.00"
    deposit_marker = f"id:{ids[0]}:bal:480000.00"

    notify = FakeNotifyRepo()
    # First poll crosses BOTH targets -> one push (furthest), both markers recorded.
    assert _poll(poller, milestone_repo, notify, pushes, old="500000", new="250000") == 1
    assert notify.fired == {deposit_marker, halfway_marker}

    # The Halfway row's stored target goes unreadable. Its id still reads.
    _corrupt_target_in_store(milestone_repo, 1)

    # Two more daily polls (nothing new crosses). The marker must SURVIVE both — the row is still
    # the user's, so the WHIT-385 sweep must not reap it as if Halfway were deleted.
    for _ in range(2):
        assert _poll(poller, milestone_repo, notify, pushes, old="240000", new="235000") == 0
    assert halfway_marker in notify.fired
    assert halfway_marker not in notify.removed

    # Repair the amount (a fresh PUT preserving ids) and re-cross Halfway. Because the marker was
    # never reaped, the crossing is NOT fresh -> NO second celebration. This is the double-
    # celebration the card closes. Fail-on-revert: rebuild liveness from `plan` (drop the id
    # prefix) -> the marker is swept during the corrupt polls and this re-cross congratulates again.
    handler.lambda_handler(_put_event(
        [{**_PLAN[0], "id": ids[0]}, {**_PLAN[1], "id": ids[1]}]), None)
    pushes.clear()
    assert _poll(poller, milestone_repo, notify, pushes, old="310000", new="250000") == 0
    assert pushes == []
    assert halfway_marker in notify.fired


# --- [W2] the mirror: a genuinely re-targeted milestone's old marker is swept, end to end -----

def test_retargeting_through_the_endpoint_sweeps_the_old_marker_and_rearms(
        handler, milestone_repo, poller, monkeypatch):
    pushes = []
    monkeypatch.setattr(poller, "send_push", lambda t, b, tok, **kw: pushes.append(t))

    ids = _saved_ids(handler.lambda_handler(_put_event(_PLAN), None))
    old_marker = f"id:{ids[1]}:bal:300000.00"
    new_marker = f"id:{ids[1]}:bal:250000.00"

    notify = FakeNotifyRepo()
    _poll(poller, milestone_repo, notify, pushes, old="500000", new="250000")
    assert old_marker in notify.fired

    # Re-target Halfway 300000 -> 250000 through a real PUT (same id preserved). "Gone" now means
    # the OLD amount is gone: it keys to a new marker, so the old one must be reaped.
    handler.lambda_handler(_put_event(
        [{**_PLAN[0], "id": ids[0]},
         {"id": ids[1], "label": "Halfway", "targetBalance": 250000, "targetDate": "2028-01-01"}]), None)

    # A no-crossing poll high above every target: the sweep reaps the stale old marker.
    pushes.clear()
    assert _poll(poller, milestone_repo, notify, pushes, old="600000", new="550000") == 0
    assert old_marker in notify.removed
    assert new_marker not in notify.fired            # the new target hasn't been crossed yet

    # Cross the NEW target -> a fresh celebration (the re-arm), exactly once.
    pushes.clear()
    assert _poll(poller, milestone_repo, notify, pushes, old="260000", new="240000") == 1
    assert pushes == ["\U0001f389 Milestone reached — Halfway!"]
    assert new_marker in notify.fired


# --- [W3] Part A on the write side: one shared validator rejects a shape-ok uncalendar date ----

@pytest.mark.parametrize("bad_date", ["２０３０-01-01", "2030-01-01\n", "2030-00-10"])
def test_the_save_endpoint_rejects_a_shape_matching_but_uncalendar_date(handler, bad_date):
    # WHIT-418 folds the save endpoint's payoffGoalDate/targetDate guard onto valid_iso_date, so a
    # Unicode-digit date (passes ISO_DATE_RE's `\d`), a trailing-newline date (passes `$`) and a
    # month-00 date (passes the shape) are all 400s — the SAME rule the reads reject them by.
    row = {"label": "Bad", "targetBalance": 300000, "targetDate": bad_date}
    resp = handler.lambda_handler(_put_event([row]), None)
    assert resp["statusCode"] == 400, resp["body"]
    assert "targetDate" in resp["body"]
