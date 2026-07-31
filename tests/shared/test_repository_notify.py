"""Tests for NotifyRepository (shared/repository_notify.py).

The debounce marker uses a combined "ADD #f :m SET #e = :exp" update on a String
Set + a TTL attribute, which the shared FakeTable can't model — so this carries a
small local fake that emulates the ADD (set-union) + SET and asserts the expression
shape. Different cycle keys map to different items, so a new cycle re-arms.
"""

import pytest


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
