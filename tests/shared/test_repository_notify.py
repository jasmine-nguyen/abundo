"""Tests for NotifyRepository (shared/repository_notify.py).

The debounce marker uses a combined "ADD #f :m SET #e = :exp" update on a String
Set + a TTL attribute, which the shared FakeTable can't model — so this carries a
small local fake that emulates the ADD (set-union) + SET and asserts the expression
shape. Different cycle keys map to different items, so a new cycle re-arms.
"""

import pytest
from decimal import Decimal


class FakeNotifyTable:
    """In-memory stand-in modelling the ADD-to-set + SET-ttl update_item + get_item
    the NotifyRepository issues, keyed by (pk, sk) so cycles are isolated."""

    def __init__(self):
        self.store: dict = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        # "ADD #f :m SET <assign>[, <assign>...]" — budget markers set the TTL only;
        # repayment markers also set last_fired_at (WHIT-316). Parse the SET clause
        # generically so both shapes round-trip.
        add_part, _, set_part = UpdateExpression.partition(" SET ")
        assert add_part == "ADD #f :m", UpdateExpression
        member = ExpressionAttributeValues[":m"]
        assert isinstance(member, set), "String-Set ADD must pass a set"
        item = self.store.setdefault((Key["pk"], Key["sk"]), {"pk": Key["pk"], "sk": Key["sk"]})
        fired_attr = ExpressionAttributeNames["#f"]
        item[fired_attr] = set(item.get(fired_attr, set())) | member
        for assignment in set_part.split(","):
            name_alias, value_alias = (part.strip() for part in assignment.split("="))
            item[ExpressionAttributeNames[name_alias]] = ExpressionAttributeValues[value_alias]


def _repo(shared):
    r = shared.notify.NotifyRepository()
    r._table = FakeNotifyTable()
    return r


def test_no_markers_before_any_fire(shared):
    assert _repo(shared).fired_markers("2026-07-01", 14) == set()


def test_mark_then_read_round_trips(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    assert r.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_mark_is_idempotent(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    r.mark_fired("2026-07-01", 14, "groceries#80")
    assert r.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_two_markers_coexist_in_the_cycle(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    r.mark_fired("2026-07-01", 14, "groceries#100")
    assert r.fired_markers("2026-07-01", 14) == {"groceries#80", "groceries#100"}


def test_different_cycle_is_a_separate_marker_set(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    # A new pay cycle (different last_pay_date) → different pk → re-armed.
    assert r.fired_markers("2026-07-15", 14) == set()


def test_mark_writes_a_ttl(shared):
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    item = r._table.store[("NOTIFY#2026-07-01#14", "FIRED")]
    assert isinstance(item["expires_at"], int) and item["expires_at"] > 0


def test_client_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.mark_fired("2026-07-01", 14, "groceries#80")


# --- repayment-notify markers (WHIT-15), keyed on transaction id --------------


def test_no_repayment_markers_before_any_fire(shared):
    assert _repo(shared).fired_repayments() == set()


def test_mark_repayment_then_read_round_trips(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    assert r.fired_repayments() == {"txn-1"}


def test_mark_repayment_is_idempotent(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    r.mark_repayment_fired("txn-1")
    assert r.fired_repayments() == {"txn-1"}


def test_two_repayment_ids_coexist(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    r.mark_repayment_fired("txn-2")
    assert r.fired_repayments() == {"txn-1", "txn-2"}


def test_repayment_markers_isolated_from_cycle_markers(shared):
    # The repayment set lives under its own pk, isolated from the per-cycle markers.
    r = _repo(shared)
    r.mark_fired("2026-07-01", 14, "groceries#80")
    r.mark_repayment_fired("txn-1")
    assert r.fired_repayments() == {"txn-1"}
    assert r.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_mark_repayment_writes_a_ttl(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    item = r._table.store[("NOTIFY#REPAYMENT", "FIRED")]
    assert isinstance(item["expires_at"], int) and item["expires_at"] > 0


def test_mark_repayment_stamps_last_fired_at(shared):
    # WHIT-316: the balance-poller backstop reads this timestamp.
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    item = r._table.store[("NOTIFY#REPAYMENT", "FIRED")]
    assert isinstance(item["last_fired_at"], int) and item["last_fired_at"] > 0


def test_last_repayment_fired_at_round_trips(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    stamped = r._table.store[("NOTIFY#REPAYMENT", "FIRED")]["last_fired_at"]
    assert r.last_repayment_fired_at() == stamped


def test_last_repayment_fired_at_none_before_any_fire(shared):
    assert _repo(shared).last_repayment_fired_at() is None


def test_repayment_read_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.get_item = boom
    with pytest.raises(database_error):
        r.fired_repayments()


def test_repayment_mark_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.mark_repayment_fired("txn-1")


# --- repayment PUSH markers (WHIT-317): windowed amounts for the precise miss-detector ---


def test_no_push_amounts_before_any_push(shared):
    assert _repo(shared).repayment_push_amounts_since(0) == []


def test_push_amount_within_window_round_trips(shared):
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    assert r.repayment_push_amounts_since(500) == [300000]


def test_push_older_than_cutoff_is_excluded(shared):
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    assert r.repayment_push_amounts_since(2000) == []


def test_two_same_amount_pushes_both_count(shared):
    # Two distinct repayments of the same amount → two tokens (txn_id keeps them apart) →
    # the reader returns the amount twice, so both can be consumed by the detector.
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    r.mark_repayment_push(300000, "txn-2", fired_at=1001)
    assert sorted(r.repayment_push_amounts_since(500)) == [300000, 300000]


def test_push_marker_isolated_from_repayment_dedup(shared):
    r = _repo(shared)
    r.mark_repayment_fired("txn-1")
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    assert r.fired_repayments() == {"txn-1"}
    assert r.repayment_push_amounts_since(0) == [300000]


def test_mark_push_writes_a_ttl(shared):
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    item = r._table.store[("NOTIFY#REPAYPUSH", "FIRED")]
    assert isinstance(item["expires_at"], int) and item["expires_at"] > 0


def test_push_read_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.get_item = boom
    with pytest.raises(database_error):
        r.repayment_push_amounts_since(0)


def test_push_mark_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.mark_repayment_push(300000, "txn-1")


# --- milestone markers (WHIT-301): once-ever, NO TTL ------------------------------------

class FakeMilestoneTable:
    """Models the milestone marker's `ADD #f :m` update — deliberately WITHOUT the
    `SET #e = :exp` TTL the budget/repayment markers carry, and asserts none is written."""

    def __init__(self):
        self.store: dict = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        # ADD #f :m (mark) or DELETE #f :m (reconcile, WHIT-385) — both on a String Set, both
        # deliberately WITHOUT the `SET #e = :exp` TTL the budget/repayment markers carry.
        assert UpdateExpression in ("ADD #f :m", "DELETE #f :m"), UpdateExpression
        assert "#e" not in ExpressionAttributeNames and ":exp" not in ExpressionAttributeValues
        member = ExpressionAttributeValues[":m"]
        assert isinstance(member, set), "String-Set update must pass a set"
        item = self.store.setdefault((Key["pk"], Key["sk"]), {"pk": Key["pk"], "sk": Key["sk"]})
        fired_attr = ExpressionAttributeNames["#f"]
        current = set(item.get(fired_attr, set()))
        if UpdateExpression == "ADD #f :m":
            item[fired_attr] = current | member
            return
        # DELETE removes the members; emptying the set drops the attribute (DynamoDB behaviour),
        # so fired_milestones() reads back set().
        remaining = current - member
        if remaining:
            item[fired_attr] = remaining
        else:
            item.pop(fired_attr, None)


def _milestone_repo(shared):
    r = shared.notify.NotifyRepository()
    r._table = FakeMilestoneTable()
    return r


def test_no_milestones_fired_initially(shared):
    assert _milestone_repo(shared).fired_milestones() == set()


def test_mark_milestone_then_read_round_trips_as_strings(shared):
    r = _milestone_repo(shared)
    r.mark_milestone_fired("id:m1:bal:480000.00")  # WHIT-369 id-marker
    assert r.fired_milestones() == {"id:m1:bal:480000.00"}


def test_milestone_marks_accumulate_and_are_idempotent(shared):
    r = _milestone_repo(shared)
    r.mark_milestone_fired("0")
    r.mark_milestone_fired("1")
    r.mark_milestone_fired("0")  # re-mark harmless
    assert r.fired_milestones() == {"0", "1"}


def test_milestone_mark_writes_no_ttl(shared):
    # The FakeMilestoneTable asserts the update carries no expires_at; also confirm the
    # stored item never grows a TTL attribute (a milestone must never expire + re-fire). The
    # shared-tenant default keeps the historical sk="FIRED" so WHIT-369 doesn't orphan existing
    # markers (which would re-fire on a non-monotonic balance).
    r = _milestone_repo(shared)
    r.mark_milestone_fired("0")
    stored = r._table.store[("NOTIFY#MILESTONE", "FIRED")]
    assert "expires_at" not in stored


def test_milestone_fired_state_is_scoped_by_owner(shared):
    # WHIT-369 multi-tenant seam: a marker written under one scope is invisible to another and
    # to the shared default, and lands under sk=<scope>. Today only the shared tenant is used;
    # this proves the seam is a per-owner key, so multi-user is a one-line poller change.
    r = _milestone_repo(shared)
    r.mark_milestone_fired("id:m1:bal:480000.00", scope="user-1")
    assert r.fired_milestones(scope="user-1") == {"id:m1:bal:480000.00"}
    assert r.fired_milestones(scope="user-2") == set()
    assert r.fired_milestones() == set()  # shared default untouched
    assert ("NOTIFY#MILESTONE", "user-1") in r._table.store


# --- reconcile: remove dead milestone markers (WHIT-385) --------------------------------

def test_remove_milestone_markers_drops_given_keys(shared):
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:300000.00")
    r.mark_milestone_fired("bal:280000.00")
    r.mark_milestone_fired("0")
    r.remove_milestone_markers({"bal:300000.00"})
    assert r.fired_milestones() == {"bal:280000.00", "0"}


def test_remove_last_marker_drops_attribute_and_reads_empty(shared):
    # Deleting the last member drops the `fired` attribute entirely; the item survives and
    # fired_milestones() reads back an empty set.
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:300000.00")
    r.remove_milestone_markers({"bal:300000.00"})
    stored = r._table.store[("NOTIFY#MILESTONE", "FIRED")]
    assert "fired" not in stored
    assert r.fired_milestones() == set()


def test_remove_milestone_markers_empty_is_a_noop(shared):
    # An empty key set must not touch the table — DynamoDB rejects an empty String Set.
    r = _milestone_repo(shared)

    def boom(**kwargs):
        raise AssertionError("update_item must not be called for an empty key set")

    r._table.update_item = boom
    r.remove_milestone_markers(set())  # no raise


def test_remove_milestone_markers_writes_no_ttl(shared):
    # The reconcile delete must preserve the no-TTL, once-ever contract (the fake asserts no
    # #e/:exp on the update; also confirm the stored item never grows a TTL attribute).
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:300000.00")
    r.mark_milestone_fired("bal:280000.00")
    r.remove_milestone_markers({"bal:300000.00"})
    stored = r._table.store[("NOTIFY#MILESTONE", "FIRED")]
    assert "expires_at" not in stored


def test_remove_milestone_markers_error_surfaces_as_database_error(shared, client_error, database_error):
    r = _milestone_repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(database_error):
        r.remove_milestone_markers({"bal:300000.00"})


# --- migrate a legacy marker onto a just-minted id (WHIT-447) -------------------------------
# When the save endpoint mints an id for a legacy id-less row, its "already celebrated" marker
# must follow the row from "bal:<amount>" to "id:<id>:bal:<amount>", or the next poll sweeps the
# bare marker as dead and re-arms the celebration. migrate_milestone_markers does that rename,
# but ONLY for a marker actually in the fired set, and adds-new-before-deletes-old so a partial
# failure can never leave the row with zero markers.


class _RecordingMilestoneTable(FakeMilestoneTable):
    """FakeMilestoneTable that also records the order of update expressions, so a test can pin
    that ADD runs before DELETE (the partial-failure safety contract)."""

    def __init__(self):
        super().__init__()
        self.expressions = []

    def update_item(self, **kwargs):
        self.expressions.append(kwargs["UpdateExpression"])
        return super().update_item(**kwargs)


def _milestone_repo_with(shared, table):
    r = shared.notify.NotifyRepository()
    r._table = table
    return r


def test_migrate_renames_a_celebrated_marker_onto_its_new_id(shared):
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:400000.00")  # celebrated back when the row was id-less
    r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])
    # The once-ever record now follows the id; the bare legacy marker is gone.
    assert r.fired_milestones() == {"id:u1:bal:400000.00"}


def test_migrate_leaves_an_uncelebrated_marker_untouched(shared):
    # If the legacy marker was never celebrated, minting an id must NOT invent a "done" marker —
    # that would silently suppress a legitimate future first celebration.
    r = _milestone_repo(shared)
    r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])
    assert r.fired_milestones() == set()


def test_migrate_only_touches_the_celebrated_pairs_in_a_mixed_batch(shared):
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:400000.00")  # this one was celebrated
    r.migrate_milestone_markers([
        ("bal:400000.00", "id:u1:bal:400000.00"),   # migrates
        ("bal:250000.00", "id:u2:bal:250000.00"),   # never celebrated → skipped
    ])
    assert r.fired_milestones() == {"id:u1:bal:400000.00"}


def test_migrate_empty_is_a_noop(shared):
    r = _milestone_repo(shared)

    def boom(**kwargs):
        raise AssertionError("update_item must not be called for an empty migration list")

    r._table.update_item = boom
    r.migrate_milestone_markers([])  # no raise


def test_migrate_all_uncelebrated_does_not_touch_the_table(shared):
    # Nothing to add → not even the ADD should run (DynamoDB rejects an empty String Set, and a
    # no-op call must not touch the table).
    r = _milestone_repo(shared)

    def boom(**kwargs):
        raise AssertionError("update_item must not be called when no marker is celebrated")

    r._table.update_item = boom
    r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])  # no raise


def test_migrate_adds_the_new_marker_before_deleting_the_old(shared):
    # The order is the partial-failure contract: if the DELETE never runs, the row keeps BOTH
    # markers (safe), never zero. Pin ADD-before-DELETE so a reorder can't slip in.
    table = _RecordingMilestoneTable()
    r = _milestone_repo_with(shared, table)
    r.mark_milestone_fired("bal:400000.00")  # one ADD (the seed)
    table.expressions.clear()
    r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])
    assert table.expressions == ["ADD #f :m", "DELETE #f :m"]


def test_migrate_partial_failure_after_add_leaves_both_markers_never_zero(shared, client_error, database_error):
    # If the DELETE fails after the ADD, the row is left holding BOTH markers — deduped, and the
    # poller reaps the now-dead legacy one later. The one thing that must never happen is ZERO
    # markers (which would re-arm the celebration this migration exists to prevent).
    class _DeleteFailsTable(FakeMilestoneTable):
        def update_item(self, **kwargs):
            if kwargs["UpdateExpression"] == "DELETE #f :m":
                raise client_error("InternalServerError")
            return super().update_item(**kwargs)

    r = _milestone_repo_with(shared, _DeleteFailsTable())
    r.mark_milestone_fired("bal:400000.00")
    with pytest.raises(database_error):
        r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])
    assert r.fired_milestones() == {"bal:400000.00", "id:u1:bal:400000.00"}


def test_migrate_is_scoped_by_owner(shared):
    # Same multi-tenant seam as the other milestone writers: a migration under one scope must not
    # touch another scope's markers or the shared default.
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:400000.00", scope="user-1")
    r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")], scope="user-1")
    assert r.fired_milestones(scope="user-1") == {"id:u1:bal:400000.00"}
    assert r.fired_milestones() == set()  # shared default untouched


def test_migrate_writes_no_ttl(shared):
    # Same no-TTL once-ever contract as mark/remove (the fake asserts no #e/:exp on the update).
    r = _milestone_repo(shared)
    r.mark_milestone_fired("bal:400000.00")
    r.migrate_milestone_markers([("bal:400000.00", "id:u1:bal:400000.00")])
    stored = r._table.store[("NOTIFY#MILESTONE", "FIRED")]
    assert "expires_at" not in stored


# --- folded from test_repository_notify_gaps.py (WHIT-463) ---


_KEY = ("NOTIFY#REPAYMENT", "FIRED")


class _DecimalTable:
    """Returns the last_fired_at as a boto3-style Decimal, the way DynamoDB really does."""

    def __init__(self, stored):
        self._item = {"pk": _KEY[0], "sk": _KEY[1], "last_fired_at": stored}

    def get_item(self, Key):
        return {"Item": dict(self._item)}


def test_last_fired_at_decimal_from_dynamo_returns_int(shared):
    r = shared.notify.NotifyRepository()
    r._table = _DecimalTable(Decimal("1752000000"))
    result = r.last_repayment_fired_at()
    assert result == 1752000000
    assert type(result) is int  # not Decimal -> the int() cast is load-bearing


# --- folded from test_repository_notify_whit317_gaps.py (WHIT-463) ---


def test_push_exactly_at_cutoff_is_included(shared):
    # WHIT-317 — [A20] fired_at == cutoff is INSIDE the window (>=), not dropped.
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=1000)
    assert r.repayment_push_amounts_since(1000) == [300000]


def test_push_one_second_below_cutoff_is_excluded(shared):
    # WHIT-317 — [A20] fired_at == cutoff-1 is OUTSIDE the window.
    r = _repo(shared)
    r.mark_repayment_push(300000, "txn-1", fired_at=999)
    assert r.repayment_push_amounts_since(1000) == []


def test_mixed_window_keeps_only_the_in_window_amounts(shared):
    # Three pushes straddling the cutoff → only the two at/after cutoff survive.
    r = _repo(shared)
    r.mark_repayment_push(100000, "a", fired_at=500)   # out
    r.mark_repayment_push(200000, "b", fired_at=1000)  # in (==cutoff)
    r.mark_repayment_push(300000, "c", fired_at=1500)  # in
    assert sorted(r.repayment_push_amounts_since(1000)) == [200000, 300000]


def test_hash_in_txn_id_does_not_corrupt_amount(shared):
    # split('#', 2) caps at 2 splits → the amount field is always the 2nd token, even
    # if the id itself carries '#'. Up ids are UUIDs (no '#'), but the maxsplit is the
    # only thing protecting the amount, so prove it.
    r = _repo(shared)
    r.mark_repayment_push(357300, "weird#id#with#hashes", fired_at=1000)
    assert r.repayment_push_amounts_since(0) == [357300]


# --- folded from test_repository_notify_whit447_gaps.py (WHIT-463) ---


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


# --- goal-checkpoint markers (WHIT-479): once-ever, NO TTL, own item -----------------------
# Reuses FakeMilestoneTable — same `ADD #f :m` String-Set update, no TTL — but keyed under
# NOTIFY#GOALCHECKPOINT, a SEPARATE item from NOTIFY#MILESTONE so the mortgage feature is untouched.

def _goalcheckpoint_repo(shared):
    r = shared.notify.NotifyRepository()
    r._table = FakeMilestoneTable()
    return r


def test_no_goal_checkpoints_fired_initially(shared):
    assert _goalcheckpoint_repo(shared).fired_goal_checkpoints() == set()


def test_mark_goal_checkpoint_then_read_round_trips(shared):
    r = _goalcheckpoint_repo(shared)
    r.mark_goal_checkpoint_fired("g:g1:cp:cp1:bal:5000.00")
    assert r.fired_goal_checkpoints() == {"g:g1:cp:cp1:bal:5000.00"}


def test_goal_checkpoint_marks_accumulate_and_are_idempotent(shared):
    r = _goalcheckpoint_repo(shared)
    r.mark_goal_checkpoint_fired("g:g1:cp:a:bal:1000.00")
    r.mark_goal_checkpoint_fired("g:g1:cp:b:bal:2000.00")
    r.mark_goal_checkpoint_fired("g:g1:cp:a:bal:1000.00")  # re-mark harmless
    assert r.fired_goal_checkpoints() == {"g:g1:cp:a:bal:1000.00", "g:g1:cp:b:bal:2000.00"}


def test_goal_checkpoint_mark_writes_no_ttl(shared):
    # A crossing is once-ever (the balance isn't monotonic), so the marker must never expire.
    r = _goalcheckpoint_repo(shared)
    r.mark_goal_checkpoint_fired("g:g1:cp:a:bal:1000.00")
    stored = r._table.store[("NOTIFY#GOALCHECKPOINT", "FIRED")]
    assert "expires_at" not in stored


def test_goal_checkpoint_markers_are_a_separate_item_from_milestones(shared):
    # The goal-checkpoint set must NOT collide with the mortgage milestone set.
    r = _goalcheckpoint_repo(shared)
    r.mark_goal_checkpoint_fired("g:g1:cp:a:bal:1000.00")
    r.mark_milestone_fired("0")
    assert ("NOTIFY#GOALCHECKPOINT", "FIRED") in r._table.store
    assert ("NOTIFY#MILESTONE", "FIRED") in r._table.store
    assert r.fired_goal_checkpoints() == {"g:g1:cp:a:bal:1000.00"}
    assert r.fired_milestones() == {"0"}
