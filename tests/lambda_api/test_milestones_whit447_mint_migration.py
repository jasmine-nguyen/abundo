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

The poller fixture mirrors the milestones e2e suite (imports shared/milestones.py in the
handler's sys.path window and restores it, so the shared-layer suite is untouched).

The adversarial batch / mixed / failure / idempotency / scope-bridge edges folded in from the
former ..._gaps.py sit under the "adversarial gaps" header at the bottom (WHIT-465 Slice 5).
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


class RaisingNotifyRepo:
    """migrate blows up — models a notify-table blip AFTER the plan save has committed."""

    def migrate_milestone_markers(self, migrations, scope=None):
        raise RuntimeError("notify table unavailable")


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


# === adversarial gaps (folded in from test_milestones_whit447_mint_migration_gaps.py) ========
#
# The batch / mixed / failure / idempotency / scope-bridge edges the handler-level tests above
# leave open — every one a way the write path could migrate the WRONG rows, migrate on a rejected
# save, 500 a PUT, or key at the wrong tenant. All handler-level (RecordingNotifyRepo/RaisingNotifyRepo).


# --- multiple legacy rows minted in ONE save migrate independently (no cross-talk) ----------

def test_two_minted_legacy_rows_each_migrate_their_own_marker(handler):
    # hunt#1: two id-less rows in one save mint two ids; each row's OWN bare marker must move onto
    # its OWN id. A shared/looped bug (same id for both, or one amount's marker on the other's id)
    # shows up here as a wrong or missing idd marker.
    notify = RecordingNotifyRepo(fired={"bal:400000.00", "bal:300000.00"})
    rows = [
        {"label": "First", "targetBalance": 400000, "targetDate": "2030-01-01"},   # no id
        {"label": "Second", "targetBalance": 300000, "targetDate": "2031-01-01"},  # no id
    ]
    resp = handler.set_milestones(_put_event(rows), FakeMilestoneRepo(), notify)
    assert resp["statusCode"] == 200, resp["body"]
    id1, id2 = (row["id"] for row in json.loads(resp["body"]))
    assert id1 != id2
    assert notify.fired == {f"id:{id1}:bal:400000.00", f"id:{id2}:bal:300000.00"}


# --- a save mixing a minted legacy row AND a supplied-id row: only the minted one migrates ---

def test_only_the_minted_row_migrates_when_a_supplied_id_row_shares_the_save(handler):
    # hunt#2: a supplied-id row was NOT minted, so it must not appear in the migration batch and its
    # bare marker must be left untouched; only the id-less row's marker moves.
    notify = RecordingNotifyRepo(fired={"bal:400000.00", "bal:300000.00"})
    rows = [
        {"id": "keep-me", "label": "Kept", "targetBalance": 400000, "targetDate": "2030-01-01"},
        {"label": "Minted", "targetBalance": 300000, "targetDate": "2031-01-01"},  # no id
    ]
    resp = handler.set_milestones(_put_event(rows), FakeMilestoneRepo(), notify)
    assert resp["statusCode"] == 200, resp["body"]
    minted_id = json.loads(resp["body"])[1]["id"]
    assert len(notify.migrate_calls) == 1
    pairs = notify.migrate_calls[0]["migrations"]
    assert pairs == [("bal:300000.00", f"id:{minted_id}:bal:300000.00")]  # exactly one, the minted
    # the supplied-id row's bare marker is never migrated (would be a wrong rename)
    assert notify.fired == {"bal:400000.00", f"id:{minted_id}:bal:300000.00"}


# --- a save that FAILS validation must NOT migrate (the 400 returns before the save) --------

def test_a_validation_failure_after_minting_never_migrates(handler):
    # hunt#4: both rows are id-less (so `minted` is populated as the loop runs) but the plan is NOT
    # strictly paid-down, so the 400 returns BEFORE repo.set_milestones and before the migration. A
    # migrate on a rejected save would move markers for a plan that was never stored.
    notify = RecordingNotifyRepo(fired={"bal:400000.00", "bal:500000.00"})
    rows = [
        {"label": "First", "targetBalance": 400000, "targetDate": "2030-01-01"},   # no id
        {"label": "Higher", "targetBalance": 500000, "targetDate": "2031-01-01"},  # no id, NOT decreasing
    ]
    resp = handler.set_milestones(_put_event(rows), FakeMilestoneRepo(), notify)
    assert resp["statusCode"] == 400, resp["body"]
    assert notify.migrate_calls == []
    assert notify.fired == {"bal:400000.00", "bal:500000.00"}  # markers untouched


def test_a_bad_row_field_returns_400_before_any_migration(handler):
    # hunt#4 (second shape): a per-row rejection (out-of-range targetBalance on the second row) also
    # short-circuits before the migration, even though the first row minted.
    notify = RecordingNotifyRepo(fired={"bal:400000.00"})
    rows = [
        {"label": "First", "targetBalance": 400000, "targetDate": "2030-01-01"},   # no id → mints
        {"label": "Bad", "targetBalance": -1, "targetDate": "2031-01-01"},         # invalid
    ]
    resp = handler.set_milestones(_put_event(rows), FakeMilestoneRepo(), notify)
    assert resp["statusCode"] == 400, resp["body"]
    assert notify.migrate_calls == []


# --- best-effort: a notify blip after the save committed must never 500 the PUT -------------

def test_a_notify_failure_after_the_save_does_not_500_the_put(handler):
    # The plan save has already committed, so a migration blip is swallowed (logged) and the PUT
    # still returns 200 with the saved plan. Worst case is one milestone left re-armed — approved
    # over blocking a plan save on the notify table.
    row = {"label": "Target", "targetBalance": 400000, "targetDate": "2030-01-01"}  # no id
    resp = handler.set_milestones(_put_event([row]), FakeMilestoneRepo(), RaisingNotifyRepo())
    assert resp["statusCode"] == 200, resp["body"]
    assert json.loads(resp["body"])[0]["label"] == "Target"


# --- re-PUT idempotency: the 2nd save carries ids → nothing minted → no migration -----------

def test_re_putting_the_same_plan_mints_and_migrates_only_once(handler):
    # hunt#5: first save mints an id and migrates the marker; the SECOND save re-sends that id, so
    # nothing is minted and migrate is not called again — and the first migration is NOT undone (the
    # idd marker stays; the bare marker does not come back).
    notify = RecordingNotifyRepo(fired={"bal:400000.00"})
    row = {"label": "Target", "targetBalance": 400000, "targetDate": "2030-01-01"}  # no id
    first = handler.set_milestones(_put_event([row]), FakeMilestoneRepo(), notify)
    minted_id = json.loads(first["body"])[0]["id"]
    assert len(notify.migrate_calls) == 1
    assert notify.fired == {f"id:{minted_id}:bal:400000.00"}

    # Re-PUT with the id now present (what a client round-trips after the first save).
    row_with_id = {**row, "id": minted_id}
    second = handler.set_milestones(_put_event([row_with_id]), FakeMilestoneRepo(), notify)
    assert second["statusCode"] == 200, second["body"]
    assert len(notify.migrate_calls) == 1, "second save minted nothing → no second migrate"
    assert notify.fired == {f"id:{minted_id}:bal:400000.00"}  # first migration intact


# --- the SHARED→None scope bridge, and its pass-through for a real per-user scope -----------

def test_notify_scope_maps_shared_to_none(handler, monkeypatch):
    # The plan store's shared tenant "SHARED" must map to the notify store's None (sk="FIRED"), the
    # tenant the poller reads/writes — else the migration lands on an item the poller never reads.
    monkeypatch.setattr(handler, "current_scope", lambda event: "SHARED")
    assert handler._notify_scope({}) is None


def test_notify_scope_passes_a_real_per_user_scope_through_unchanged(handler, monkeypatch):
    # hunt#6: only the shared default is remapped. A future authenticated scope returns the SAME id
    # to both stores, so the bridge must pass any non-"SHARED" scope straight through.
    monkeypatch.setattr(handler, "current_scope", lambda event: "user-42")
    assert handler._notify_scope({}) == "user-42"
