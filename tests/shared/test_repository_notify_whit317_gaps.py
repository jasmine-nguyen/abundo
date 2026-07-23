"""WHIT-317 GAP tests (adversarial) for NotifyRepository push-marker windowing.

Complements tests/shared/test_repository_notify.py — does NOT duplicate it. Focus:
  - the >= cutoff boundary (exactly-at vs one-second-below), which the implementer's
    tests bracket loosely (fired_at=1000 with cutoff 500/2000) but never pin AT the edge.
  - token-parse robustness: a txn_id containing '#' must not bleed into the amount field
    (split('#', 2) maxsplit guard).
"""

import pytest


class FakeNotifyTable:
    """Local copy of the notify ADD-to-set + SET-ttl fake (see test_repository_notify.py)."""

    def __init__(self):
        self.store: dict = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
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


# --- [A20] the >= cutoff boundary, pinned AT the edge ----------------------

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


# --- [A21] token parse robustness: a '#' in the txn_id must not corrupt amount ---

def test_hash_in_txn_id_does_not_corrupt_amount(shared):
    # split('#', 2) caps at 2 splits → the amount field is always the 2nd token, even
    # if the id itself carries '#'. Up ids are UUIDs (no '#'), but the maxsplit is the
    # only thing protecting the amount, so prove it.
    r = _repo(shared)
    r.mark_repayment_push(357300, "weird#id#with#hashes", fired_at=1000)
    assert r.repayment_push_amounts_since(0) == [357300]
