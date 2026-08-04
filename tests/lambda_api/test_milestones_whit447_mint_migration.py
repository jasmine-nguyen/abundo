"""WHIT-447 — migrating a legacy row's "already celebrated" marker when its id is minted.

The bug: the celebration marker embeds the milestone's id ("id:<id>:bal:<amount>"). A row saved
before ids were minted has the id-less form "bal:<amount>". The FIRST save mints a uuid for that
row; the next poll then keys it under "id:<uuid>:bal:<amount>" and sweeps the bare "bal:<amount>"
as dead — re-arming the milestone, so a later re-cross congratulates a SECOND time.

The fix is on the WRITE path: when set_milestones mints an id for a previously id-less row, it
migrates that row's fired marker in the notify store so the once-ever record follows the row.

These tests come in two shapes:
  - handler-level, asserting set_milestones migrates only minted rows and at the notify store's
    shared scope (None → sk="FIRED"), NOT the plan store's "SHARED";
  - one END-TO-END repro that drives the REAL handler PUT and the REAL poller crossing over a
    shared notify store and proves mint + re-cross sends no second push (the card's done-def).

The poller fixture mirrors test_milestones_whit424_e2e_gaps.py (imports shared/milestones.py in
the handler's sys.path window and restores it, so the shared-layer suite is untouched).
"""

import json
import sys
from decimal import Decimal

import pytest


class FakeConfigTable:
    """The single-config-item slice DynamoDB MilestoneRepository uses; injected as repo._table so
    the real set_milestones / _read_milestones / _resolve_plan run unmodified."""

    def __init__(self):
        self.store = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        self.store[(Item["pk"], Item["sk"])] = dict(Item)


class FakeNotifyTable:
    """The milestone-marker item slice DynamoDB NotifyRepository uses; injected as notify._table so
    the real fired_milestones / mark_milestone_fired / remove_milestone_markers /
    migrate_milestone_markers all run unmodified. Models ADD/DELETE on the `fired` String Set."""

    def __init__(self):
        self.store = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        assert UpdateExpression in ("ADD #f :m", "DELETE #f :m"), UpdateExpression
        member = ExpressionAttributeValues[":m"]
        assert isinstance(member, set), "String-Set update must pass a set"
        item = self.store.setdefault((Key["pk"], Key["sk"]), {"pk": Key["pk"], "sk": Key["sk"]})
        current = set(item.get("fired", set()))
        if UpdateExpression == "ADD #f :m":
            item["fired"] = current | member
            return
        remaining = current - member
        if remaining:
            item["fired"] = remaining
        else:
            item.pop("fired", None)


class RecordingNotifyRepo:
    """Handler-level stand-in that records every migrate call (its migrations and scope) and
    applies the same only-if-celebrated rename the real repo does. Lets a handler test assert
    WHAT set_milestones migrates without standing up a table."""

    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.migrate_calls = []

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def migrate_milestone_markers(self, migrations, scope=None):
        self.migrate_calls.append({"migrations": list(migrations), "scope": scope})
        for old, new in migrations:
            if old in self.fired:
                self.fired.add(new)
                self.fired.discard(old)


class FakeMilestoneRepo:
    """Handler-level stand-in for MilestoneRepository; echoes the saved list like the real repo."""

    def set_milestones(self, milestones, scope="SHARED"):
        return [{**m, "targetBalance": float(m["targetBalance"])} for m in milestones]


class FakeDeviceRepo:
    def list_tokens(self):
        return ["tok"]


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return None


def _put_event(rows):
    return {"rawPath": "/milestones", "requestContext": {"http": {"method": "PUT"}},
            "body": json.dumps({"milestones": rows}), "isBase64Encoded": False}


# --- handler-level: migrate only minted rows, at the notify shared scope -------------------


def test_supplied_id_row_is_not_migrated(handler):
    # A row that already carries an id was not minted, so there is nothing to migrate — the
    # notify store must not be touched at all.
    notify = RecordingNotifyRepo(fired={"bal:400000.00"})
    row = {"id": "keep-me", "label": "Target", "targetBalance": 400000, "targetDate": "2030-01-01"}
    resp = handler.set_milestones(_put_event([row]), FakeMilestoneRepo(), notify)
    assert resp["statusCode"] == 200, resp["body"]
    assert notify.migrate_calls == []


def test_a_minted_legacy_row_migrates_at_the_notify_shared_scope_none(handler):
    # The notify store's shared tenant is None → sk="FIRED"; the plan store's is "SHARED". The
    # save path must migrate at None (what the poller reads), NOT "SHARED" — else the fix is inert.
    notify = RecordingNotifyRepo(fired={"bal:400000.00"})
    row = {"label": "Target", "targetBalance": 400000, "targetDate": "2030-01-01"}  # no id
    resp = handler.set_milestones(_put_event([row]), FakeMilestoneRepo(), notify)
    assert resp["statusCode"] == 200, resp["body"]
    assert len(notify.migrate_calls) == 1
    assert notify.migrate_calls[0]["scope"] is None


def test_a_minted_legacy_rows_marker_is_migrated_onto_its_new_id(handler):
    # The handler builds the (legacy, id'd) pair off the row's stored amount + minted id, so the
    # migrated marker matches what the poller will later key the saved row to.
    notify = RecordingNotifyRepo(fired={"bal:400000.00"})
    row = {"label": "Target", "targetBalance": 400000, "targetDate": "2030-01-01"}  # no id
    resp = handler.set_milestones(_put_event([row]), FakeMilestoneRepo(), notify)
    minted_id = json.loads(resp["body"])[0]["id"]
    assert notify.fired == {f"id:{minted_id}:bal:400000.00"}


# --- end to end: mint + re-cross sends no second celebration (the done-definition) ---------


@pytest.fixture
def milestone_repo(handler, monkeypatch):
    repo = handler.MilestoneRepository()
    repo._table = FakeConfigTable()
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: repo)
    return repo


@pytest.fixture
def notify_repo(handler, monkeypatch):
    # The REAL NotifyRepository over a fake table, wired into BOTH the PUT handler and the poll
    # below, so the mint-migration and the poller sweep operate on ONE shared marker store.
    repo = handler.NotifyRepository()
    repo._table = FakeNotifyTable()
    monkeypatch.setattr(handler, "NotifyRepository", lambda: repo)
    return repo


@pytest.fixture
def poller(handler):
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


def test_minting_an_id_then_re_crossing_sends_no_second_celebration(
        handler, milestone_repo, notify_repo, poller, monkeypatch):
    # The card's done-definition, reproduced end to end.
    pushes = []
    monkeypatch.setattr(poller, "send_push",
                        lambda title, body, tokens, **kw: pushes.append(title))

    def poll(old, new):
        return poller.notify_milestone_crossing(
            Decimal(old), Decimal(new), loanfacts_repo=FakeLoanFactsRepo(),
            device_repo=FakeDeviceRepo(), notify_repo=notify_repo, milestone_repo=milestone_repo)

    # The row was celebrated back when it was id-less: the poller keyed it "bal:<amount>".
    notify_repo.mark_milestone_fired("bal:400000.00")

    # First save mints the id — and migrates the marker onto it (the WHIT-447 write).
    legacy_row = {"label": "Target", "targetBalance": 400000, "targetDate": "2030-01-01"}  # no id
    put = handler.lambda_handler(_put_event([legacy_row]), None)
    assert put["statusCode"] == 200, put["body"]
    minted_id = json.loads(put["body"])[0]["id"]
    idd_marker = f"id:{minted_id}:bal:400000.00"
    assert notify_repo.fired_milestones() == {idd_marker}, "marker must follow the minted id"

    # A no-cross poll runs the sweep against the now-id'd saved plan: the migrated marker is
    # covered, so it is NOT swept. (Reverting the migration leaves the bare "bal:" here, which the
    # sweep then removes as dead — re-arming the milestone.)
    assert poll("395000", "390000") == 0
    assert notify_repo.fired_milestones() == {idd_marker}

    # A genuine balance increase re-crosses 400000. The marker is still held, so no second push.
    # (Reverting the migration: the marker was swept above, so this crossing fires a 2nd push.)
    assert poll("410000", "395000") == 0
    assert pushes == [], "minting an id must not re-arm an already-celebrated milestone"
