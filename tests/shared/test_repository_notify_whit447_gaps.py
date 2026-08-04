"""WHIT-447 (gaps) — the ZERO-marker guarantee, from the OTHER failure direction + idempotency.

The implementer's migrate tests (test_repository_notify.py) prove a DELETE-fails-after-ADD leaves
BOTH markers (never zero). They do NOT prove the mirror: if the ADD itself fails, the OLD marker
must still be intact (again never zero), and running the same migration TWICE must be a safe no-op
(a re-PUT never mints, but nothing here may re-add or double-touch). Both close the one outcome the
whole migration exists to prevent: a live, already-celebrated milestone left with NO marker.

Self-contained fake (the ADD/DELETE-on-a-String-Set shape) so the failure can be injected on the
first update_item, which the implementer's shared fake can't do.
"""

import pytest


class _MilestoneTable:
    """Models ADD/DELETE on the `fired` String Set (no TTL), keyed by (pk, sk)."""

    def __init__(self):
        self.store = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        assert UpdateExpression in ("ADD #f :m", "DELETE #f :m"), UpdateExpression
        member = ExpressionAttributeValues[":m"]
        assert isinstance(member, set)
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


def _repo_with(shared, table):
    r = shared.notify.NotifyRepository()
    r._table = table
    return r


def test_add_failing_leaves_the_old_marker_intact_never_zero(shared, client_error, database_error):
    # WHIT-447 — hunt#7 (mirror of the covered DELETE-fails case): if the ADD fails, the DELETE
    # never runs (it is second), so the OLD marker survives. The one thing that must never happen
    # — zero markers for a still-live celebrated milestone — is impossible from EITHER failure.
    class _AddFailsTable(_MilestoneTable):
        armed = False  # so the seed ADD below still lands; only the migrate ADD fails

        def update_item(self, **kwargs):
            if self.armed and kwargs["UpdateExpression"] == "ADD #f :m":
                raise client_error("InternalServerError")
            return super().update_item(**kwargs)

    table = _AddFailsTable()
    r = _repo_with(shared, table)
    r.mark_milestone_fired("bal:400000.00")
    table.armed = True
    with pytest.raises(database_error):
        r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])
    assert r.fired_milestones() == {"bal:400000.00"}  # old kept, new never added → never zero


def test_migrating_an_already_migrated_pair_is_a_safe_noop(shared):
    # WHIT-447 — hunt#5 at the repo level: after the marker is on the id, its bare `old` is gone,
    # so a second migrate finds `old` not in the fired set → nothing to add → returns without
    # touching the table, and the idd marker is neither lost nor duplicated.
    table = _MilestoneTable()
    r = _repo_with(shared, table)
    r.mark_milestone_fired("bal:400000.00")
    r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])
    assert r.fired_milestones() == {"id:u1:bal:400000.00"}

    # Arm a tripwire: a second migrate of the SAME pair must not touch the table at all.
    def boom(**kwargs):
        raise AssertionError("update_item must not run — old marker already migrated")

    table.update_item = boom
    r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])  # no raise
    assert r.fired_milestones() == {"id:u1:bal:400000.00"}


def test_a_migration_does_not_disturb_an_unrelated_fired_marker(shared):
    # WHIT-447: a batch that migrates one pair must leave every OTHER celebrated marker (here a
    # built-in sprint "0" and an unrelated saved marker) exactly as it was — no collateral ADD or
    # DELETE beyond the migrated pair.
    r = _repo_with(shared, _MilestoneTable())
    r.mark_milestone_fired("bal:400000.00")
    r.mark_milestone_fired("0")
    r.mark_milestone_fired("id:other:bal:250000.00")
    r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])
    assert r.fired_milestones() == {"id:u1:bal:400000.00", "0", "id:other:bal:250000.00"}
