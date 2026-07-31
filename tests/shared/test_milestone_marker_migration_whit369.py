"""WHIT-369 MIGRATION GUARANTEE — an already-celebrated shared-tenant marker written by a
PRIOR deploy (at the historical sk="FIRED") must stay visible to the post-WHIT-369 None
default, so an existing user gets NO spurious duplicate push after the seam lands.

The round-trip tests in test_repository_notify.py write AND read through the new API, so they
would still pass if the None default silently moved to a new sort key (e.g. "SHARED"): both
sides would just relocate together. This test PRE-SEEDS the raw store at the old location an
existing deploy left behind, then reads via the new API — the only check that actually fails
if the shared default is re-keyed and orphans live markers (round-1 critique #1)."""

import pytest


class _FakeTable:
    def __init__(self):
        self.store = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        item = self.store.setdefault((Key["pk"], Key["sk"]), {"pk": Key["pk"], "sk": Key["sk"]})
        f = ExpressionAttributeNames["#f"]
        item[f] = set(item.get(f, set())) | ExpressionAttributeValues[":m"]


def _repo(shared):
    r = shared.notify.NotifyRepository()
    r._table = _FakeTable()
    return r


def test_existing_FIRED_marker_is_read_by_the_post_whit369_none_default(shared):
    # WHIT-369 — a prior deploy celebrated built-in sprint "2" and a saved milestone, leaving
    # the fired SET at the raw historical key ("NOTIFY#MILESTONE", "FIRED"). After WHIT-369
    # the None default must still land there → both markers are seen → no re-fire.
    r = _repo(shared)
    r._table.store[("NOTIFY#MILESTONE", "FIRED")] = {
        "pk": "NOTIFY#MILESTONE", "sk": "FIRED", "fired": {"2", "id:m1:bal:480000.00"},
    }
    assert r.fired_milestones() == {"2", "id:m1:bal:480000.00"}   # None default reads the old item
    assert r.fired_milestones(scope=None) == {"2", "id:m1:bal:480000.00"}


def test_none_default_marks_into_the_same_historical_item_not_a_new_one(shared):
    # WHIT-369 — a new mark under the None default must ACCUMULATE into the historical FIRED
    # item alongside a pre-existing marker, never spawn a parallel item that splits the set.
    r = _repo(shared)
    r._table.store[("NOTIFY#MILESTONE", "FIRED")] = {
        "pk": "NOTIFY#MILESTONE", "sk": "FIRED", "fired": {"0"},
    }
    r.mark_milestone_fired("id:m1:bal:480000.00")            # no scope → shared default
    assert set(r._table.store.keys()) == {("NOTIFY#MILESTONE", "FIRED")}   # still ONE item
    assert r.fired_milestones() == {"0", "id:m1:bal:480000.00"}
