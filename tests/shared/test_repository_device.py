"""Tests for DeviceRepository (shared/repository_device.py).

The device-token store uses a DynamoDB String Set with atomic ADD/DELETE, which
the shared FakeTable's update_item (flat SET only) can't model — so these carry a
small local fake that emulates set-union / set-difference AND asserts the repo
issues ADD/DELETE (not SET) with the right names/values. That assertion is what
makes these fail-on-revert: a repo that used SET, or the wrong attribute, trips it.
"""

import pytest


class FakeDeviceTable:
    """In-memory stand-in modelling only the ADD/DELETE String-Set update_item +
    get_item the DeviceRepository issues, and asserting the expression shape."""

    def __init__(self):
        self.item = None  # the single DEVICES config item, or None before any write

    def get_item(self, Key):
        return {"Item": dict(self.item)} if self.item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues):
        verb = UpdateExpression.split(" ", 1)[0]
        assert verb in ("ADD", "DELETE"), f"expected a set op, got {UpdateExpression!r}"
        attr = ExpressionAttributeNames["#t"]
        assert attr == "tokens"
        val = ExpressionAttributeValues[":tok"]
        assert isinstance(val, set), "String-Set ops must pass a Python set"
        if self.item is None:
            self.item = {"pk": Key["pk"], "sk": Key["sk"]}
        current = set(self.item.get(attr, set()))
        current = current | val if verb == "ADD" else current - val
        if current:
            self.item[attr] = current
        else:
            # DynamoDB forbids an empty set; DELETE of the last element drops the attr.
            self.item.pop(attr, None)


def _repo(shared):
    r = shared.device.DeviceRepository()
    r._table = FakeDeviceTable()
    return r


def test_register_then_list_round_trips(shared):
    r = _repo(shared)
    r.register("ExpoPushToken[a]")
    assert r.list_tokens() == ["ExpoPushToken[a]"]


def test_register_is_idempotent(shared):
    r = _repo(shared)
    r.register("ExpoPushToken[a]")
    r.register("ExpoPushToken[a]")
    assert r.list_tokens() == ["ExpoPushToken[a]"]   # set-union dedupes


def test_two_tokens_returned_sorted(shared):
    r = _repo(shared)
    r.register("ExpoPushToken[b]")
    r.register("ExpoPushToken[a]")
    assert r.list_tokens() == ["ExpoPushToken[a]", "ExpoPushToken[b]"]


def test_remove_one_leaves_the_rest(shared):
    r = _repo(shared)
    r.register("ExpoPushToken[a]")
    r.register("ExpoPushToken[b]")
    r.remove("ExpoPushToken[a]")
    assert r.list_tokens() == ["ExpoPushToken[b]"]


def test_remove_last_token_drops_the_attribute(shared):
    r = _repo(shared)
    r.register("ExpoPushToken[a]")
    r.remove("ExpoPushToken[a]")
    assert r.list_tokens() == []
    assert "tokens" not in r._table.item   # empty set can't linger


def test_remove_absent_token_is_a_noop(shared):
    r = _repo(shared)
    r.register("ExpoPushToken[a]")
    r.remove("ExpoPushToken[zzz]")
    assert r.list_tokens() == ["ExpoPushToken[a]"]


def test_list_before_any_register_is_empty(shared):
    assert _repo(shared).list_tokens() == []


def test_client_error_surfaces_as_runtime_error(shared, client_error):
    r = _repo(shared)

    def boom(**kwargs):
        raise client_error("InternalServerError")

    r._table.update_item = boom
    with pytest.raises(RuntimeError):
        r.register("ExpoPushToken[a]")
