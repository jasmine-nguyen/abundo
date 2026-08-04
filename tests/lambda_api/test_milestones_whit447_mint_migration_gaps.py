"""WHIT-447 (gaps) — adversarial edges the implementer's mint-migration tests don't lock.

The implementer's test_milestones_whit447_mint_migration.py covers: a supplied-id row is not
migrated; a single minted legacy row migrates at scope None; the marker is built onto the new id;
and an end-to-end mint-then-re-cross sends no second push. These add the batch / mixed / failure /
idempotency / scope-bridge edges that file leaves open — every one a way the write path could
migrate the WRONG rows, migrate on a rejected save, 500 a PUT, or key at the wrong tenant.

Self-contained handler-level doubles (mirrors the implementer's file) so no table is stood up:
what set_milestones DECIDES to migrate is what's under test, not how the real repo applies it.
"""

import json

import pytest


class RecordingNotifyRepo:
    """Records every migrate call (its pairs + scope) and applies the real repo's only-if-fired
    rename, so a handler test can assert WHAT set_milestones migrates without a table."""

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
    """Echoes the saved list like the real MilestoneRepository (targetBalance back to float)."""

    def set_milestones(self, milestones, scope="SHARED"):
        return [{**m, "targetBalance": float(m["targetBalance"])} for m in milestones]


def _put_event(rows):
    return {"rawPath": "/milestones", "requestContext": {"http": {"method": "PUT"}},
            "body": json.dumps({"milestones": rows}), "isBase64Encoded": False}


# --- multiple legacy rows minted in ONE save migrate independently (no cross-talk) ----------

def test_two_minted_legacy_rows_each_migrate_their_own_marker(handler):
    # WHIT-447 — hunt#1: two id-less rows in one save mint two ids; each row's OWN bare marker
    # must move onto its OWN id. A shared/looped bug (same id for both, or one amount's marker on
    # the other's id) shows up here as a wrong or missing idd marker.
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
    # WHIT-447 — hunt#2: a supplied-id row was NOT minted, so it must not appear in the migration
    # batch and its bare marker must be left untouched; only the id-less row's marker moves.
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
    # WHIT-447 — hunt#4: both rows are id-less (so `minted` is populated as the loop runs) but the
    # plan is NOT strictly paid-down, so the 400 returns BEFORE repo.set_milestones and before the
    # migration. A migrate on a rejected save would move markers for a plan that was never stored.
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
    # WHIT-447 — hunt#4 (second shape): a per-row rejection (out-of-range targetBalance on the
    # second row) also short-circuits before the migration, even though the first row minted.
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
    # WHIT-447: the plan save has already committed, so a migration blip is swallowed (logged) and
    # the PUT still returns 200 with the saved plan. Worst case is one milestone left re-armed —
    # approved over blocking a plan save on the notify table.
    row = {"label": "Target", "targetBalance": 400000, "targetDate": "2030-01-01"}  # no id
    resp = handler.set_milestones(_put_event([row]), FakeMilestoneRepo(), RaisingNotifyRepo())
    assert resp["statusCode"] == 200, resp["body"]
    assert json.loads(resp["body"])[0]["label"] == "Target"


# --- re-PUT idempotency: the 2nd save carries ids → nothing minted → no migration -----------

def test_re_putting_the_same_plan_mints_and_migrates_only_once(handler):
    # WHIT-447 — hunt#5: first save mints an id and migrates the marker; the SECOND save re-sends
    # that id, so nothing is minted and migrate is not called again — and the first migration is
    # NOT undone (the idd marker stays; the bare marker does not come back).
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
    # WHIT-447: the plan store's shared tenant "SHARED" must map to the notify store's None
    # (sk="FIRED"), the tenant the poller reads/writes — else the migration lands on an item the
    # poller never reads and the fix is inert.
    monkeypatch.setattr(handler, "current_scope", lambda event: "SHARED")
    assert handler._notify_scope({}) is None


def test_notify_scope_passes_a_real_per_user_scope_through_unchanged(handler, monkeypatch):
    # WHIT-447 — hunt#6: only the shared default is remapped. A future authenticated scope returns
    # the SAME id to both stores, so the bridge must pass any non-"SHARED" scope straight through.
    monkeypatch.setattr(handler, "current_scope", lambda event: "user-42")
    assert handler._notify_scope({}) == "user-42"
