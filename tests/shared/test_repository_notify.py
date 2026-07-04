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
        assert UpdateExpression == "ADD #f :m SET #e = :exp", UpdateExpression
        fired_attr = ExpressionAttributeNames["#f"]
        exp_attr = ExpressionAttributeNames["#e"]
        member = ExpressionAttributeValues[":m"]
        assert isinstance(member, set), "String-Set ADD must pass a set"
        item = self.store.setdefault((Key["pk"], Key["sk"]), {"pk": Key["pk"], "sk": Key["sk"]})
        item[fired_attr] = set(item.get(fired_attr, set())) | member
        item[exp_attr] = ExpressionAttributeValues[":exp"]


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
