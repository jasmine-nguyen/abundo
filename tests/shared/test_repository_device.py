"""Tests for DeviceRepository (shared/repository_device.py).

The device-token store uses a DynamoDB String Set with atomic ADD/DELETE. The real repository runs
over the shared FakeTable (WHIT-625), which applies set-union / set-difference and drops an emptied
set as DynamoDB does; the expression-shape test pins that the repo issues ADD/DELETE (not SET) on
the right attribute.
"""

from _dynamo_fakes import FakeTable

_KEY = ("DEVICES", "DEVICES")


def _repo(shared):
    r = shared.device.DeviceRepository()
    r._table = FakeTable()
    return r


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
    assert "tokens" not in r._table.store[_KEY]   # empty set can't linger


def test_remove_absent_token_is_a_noop(shared):
    r = _repo(shared)
    r.register("ExpoPushToken[a]")
    r.remove("ExpoPushToken[zzz]")
    assert r.list_tokens() == ["ExpoPushToken[a]"]
