"""WHIT-417 — [L6] the two halves of this PR meeting each other, end to end.

The PR does two things that pull in opposite directions:
  1. the poller now REJECTS a row with an unreadable targetDate — so the row vanishes from the
     plan the celebration measures against, and from the plan screen;
  2. the WHIT-385 sweep now KEEPS that row's "already celebrated" marker, because a row we can
     still key is a row the user still has.

Together they raise a question neither shared-layer test can answer: if the row is invisible on
screen, the user can never repair or delete it — so is its marker now immortal, quietly growing
the once-ever record forever? The answer is in the API, not the poller: GET /milestones hides
the row, PUT /milestones replaces the plan WHOLE (handler.py:2170 -> set_milestones), so the
first time the user saves anything the hidden row is dropped from the store — and only THEN does
its marker become genuinely stale and get swept.

That self-heal is the whole safety argument for change 2, and nothing tests it. It spans the
real handler, the real MilestoneRepository (real _to_client) and the real _resolve_plan over one
shared store — a shape only this suite can build.

  [L6] a hidden row's marker survives every poll while the row is stored, and is swept on the
       first poll after the user's next save quietly drops the row.

Harness mirrors test_milestones_whit417_e2e_gaps.py (same FakeConfigTable / poller fixture).
"""

import json
import sys
from decimal import Decimal

import pytest


class FakeConfigTable:
    """The single-config-item slice of DynamoDB MilestoneRepository uses, injected as
    repo._table so the real set_milestones / _read_milestones / _to_client all run unmodified."""

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
    saved = {name: sys.modules.get(name) for name in ("milestones", "milestone_rows")}
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


def _get_event():
    return {"rawPath": "/milestones", "requestContext": {"http": {"method": "GET"}}}


class FakeDeviceRepo:
    def list_tokens(self):
        return ["tok"]


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return None


class FakeNotifyRepo:
    def __init__(self):
        self.fired = set()
        self.removed = set()

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def mark_milestone_fired(self, key, scope=None):
        self.fired.add(key)

    def remove_milestone_markers(self, keys, scope=None):
        assert keys, "must guard empty before calling remove_milestone_markers"
        self.removed |= set(keys)
        self.fired -= set(keys)


_PLAN = [
    {"label": "Quarter down", "targetBalance": 400000, "targetDate": "2030-01-01"},
    {"label": "Halfway", "targetBalance": 250000, "targetDate": "2031-01-01"},
]


def test_a_hidden_rows_marker_survives_until_the_next_save_drops_the_row(
        handler, milestone_repo, poller, monkeypatch):
    # [L6] The full life of the marker WHIT-417 newly protects.
    pushes = []
    monkeypatch.setattr(poller, "send_push",
                        lambda title, body, tokens, **kw: pushes.append(title))
    notify = FakeNotifyRepo()

    def poll(old, new):
        return poller.notify_milestone_crossing(
            Decimal(old), Decimal(new), loanfacts_repo=FakeLoanFactsRepo(),
            device_repo=FakeDeviceRepo(), notify_repo=notify, milestone_repo=milestone_repo)

    # 1. The user saves a plan and genuinely earns the first milestone.
    put = handler.lambda_handler(_put_event(_PLAN), None)
    assert put["statusCode"] == 200, put["body"]
    quarter_id, half_id = [row["id"] for row in json.loads(put["body"])]
    quarter_marker = f"id:{quarter_id}:bal:400000.00"

    assert poll("410000", "395000") == 1
    assert pushes == ["\U0001f389 Milestone reached — Quarter down!"]
    assert notify.fired == {quarter_marker}

    # 2. That row's stored date is corrupted (a legacy or hand-written value — the save endpoint
    # can't produce one). The row is now unreadable on BOTH paths.
    stored = milestone_repo._table.store[("MILESTONES", "SHARED")]["milestones"]
    stored[0]["targetDate"] = "not-a-date"

    on_screen = json.loads(handler.lambda_handler(_get_event(), None)["body"])
    assert [row["id"] for row in on_screen] == [half_id], "the plan screen must hide the row"

    # 3. Every poll while it is still stored leaves its record alone — this is the WHIT-417
    # change. The second row keeps the plan non-empty, so the sweep genuinely runs.
    assert poll("395000", "390000") == 0
    assert poll("390000", "385000") == 0
    assert notify.removed == set(), "a stored row's marker must survive being unreadable"
    assert notify.fired == {quarter_marker}

    # 4. The user edits their plan. The app can only send back what it was shown, and PUT
    # replaces the plan whole — so the hidden row is silently dropped from the store.
    resave = handler.lambda_handler(_put_event(on_screen), None)
    assert resave["statusCode"] == 200, resave["body"]
    assert [row["id"] for row in milestone_repo._table.store[
        ("MILESTONES", "SHARED")]["milestones"]] == [half_id]

    # 5. NOW the marker is genuinely orphaned, and the next poll sweeps it. The protection in
    # step 3 is a stay of execution, not immortality — which is what keeps the once-ever record
    # from growing without bound.
    assert poll("385000", "380000") == 0
    assert notify.removed == {quarter_marker}
    assert notify.fired == set()
    assert pushes == ["\U0001f389 Milestone reached — Quarter down!"], "no second celebration"
