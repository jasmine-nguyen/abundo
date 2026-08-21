"""WHIT-479 slice 4a — gap tests for the balance-poller's goal-checkpoint hook.

Complements tests/balance_poller/test_handler.py: adds the empty-deltas short-circuit, the
MULTI-goal-in-one-poll loop, and the per-goal FAILURE isolation the existing single-goal tests
miss. The crossing math itself is unit-tested in tests/shared/test_goal_checkpoints.py; here we
prove the poller WIRING (which goals fire, with what old/new, and that one goal's failure or a
no-op poll touches nothing/keeps going).
"""

from decimal import Decimal


class _FakeGoalsRepo:
    def __init__(self, goals):
        self._goals = goals
        self.list_calls = 0

    def list_goals(self):
        self.list_calls += 1
        return dict(self._goals)


def _record_notify(handler, monkeypatch):
    seen = []
    monkeypatch.setattr(
        handler, "notify_goal_checkpoint_crossing",
        lambda old, new, **kw: seen.append((kw["goal_id"], old, new, kw["synced"])) or 1,
    )
    monkeypatch.setattr(handler, "NotifyRepository", lambda: object())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: object())
    return seen


# [A30] empty deltas -> no repos are even constructed (the store-nothing poll stays cheap/safe).
def test_check_goal_checkpoints_empty_deltas_touches_no_repo(handler, monkeypatch):
    def boom():
        raise AssertionError("GoalsRepository must not be built for an empty poll")
    monkeypatch.setattr(handler, "GoalsRepository", boom)
    handler._check_goal_checkpoints([])   # must return before constructing anything


# [A31] no goals stored -> the loop is skipped, no crossing check runs.
def test_check_goal_checkpoints_no_goals_does_nothing(handler, monkeypatch):
    seen = _record_notify(handler, monkeypatch)
    monkeypatch.setattr(handler, "GoalsRepository", lambda: _FakeGoalsRepo({}))
    handler._check_goal_checkpoints([{"account_id": "up-spending", "old": Decimal("1"), "new": Decimal("2")}])
    assert seen == []


# [A32] TWO synced goals on TWO accounts both crossing in one poll -> each fires with ITS delta.
def test_check_goal_checkpoints_fires_every_matching_goal_in_one_poll(handler, monkeypatch):
    goals = {
        "g1": {"direction": "grow", "name": "Holiday", "account_id": "up-spending",
               "checkpoints": [{"id": "c", "label": "H", "amount": Decimal("95000")}]},
        "g2": {"direction": "paydown", "name": "Card", "account_id": "anz-rewards-black-visa",
               "checkpoints": [{"id": "c", "label": "L", "amount": Decimal("5000")}]},
    }
    monkeypatch.setattr(handler, "GoalsRepository", lambda: _FakeGoalsRepo(goals))
    seen = _record_notify(handler, monkeypatch)

    handler._check_goal_checkpoints([
        {"account_id": "up-spending", "old": Decimal("90000"), "new": Decimal("96270.59")},
        {"account_id": "anz-rewards-black-visa", "old": Decimal("-6000"), "new": Decimal("-4000")},
    ])
    # Both fired, each with its OWN account's old/new (order = goals map order).
    assert seen == [
        ("g1", Decimal("90000"), Decimal("96270.59"), True),
        ("g2", Decimal("-6000"), Decimal("-4000"), True),
    ]


# [A33] a synced goal whose account had NO prior balance passes old=None through (seed guard).
def test_check_goal_checkpoints_passes_none_old_for_a_first_poll_account(handler, monkeypatch):
    goals = {"g1": {"direction": "grow", "name": "Holiday", "account_id": "up-spending",
                    "checkpoints": [{"id": "c", "label": "H", "amount": Decimal("95000")}]}}
    monkeypatch.setattr(handler, "GoalsRepository", lambda: _FakeGoalsRepo(goals))
    seen = _record_notify(handler, monkeypatch)

    handler._check_goal_checkpoints([{"account_id": "up-spending", "old": None, "new": Decimal("96000")}])
    assert seen == [("g1", None, Decimal("96000"), True)]


# [A34] one goal's crossing check RAISING must not abort the loop: the next goal still fires.
def test_check_goal_checkpoints_isolates_a_single_goal_failure(handler, monkeypatch):
    goals = {
        "boom": {"direction": "grow", "name": "Bad", "account_id": "up-spending",
                 "checkpoints": [{"id": "c", "label": "H", "amount": Decimal("95000")}]},
        "ok": {"direction": "paydown", "name": "Card", "account_id": "anz-rewards-black-visa",
               "checkpoints": [{"id": "c", "label": "L", "amount": Decimal("5000")}]},
    }
    monkeypatch.setattr(handler, "GoalsRepository", lambda: _FakeGoalsRepo(goals))
    monkeypatch.setattr(handler, "NotifyRepository", lambda: object())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: object())
    fired = []

    def flaky(old, new, **kw):
        if kw["goal_id"] == "boom":
            raise RuntimeError("expo down for this goal")
        fired.append(kw["goal_id"])
        return 1

    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing", flaky)
    # Must not raise, and the healthy 'ok' goal must still fire despite 'boom' blowing up first.
    handler._check_goal_checkpoints([
        {"account_id": "up-spending", "old": Decimal("90000"), "new": Decimal("96000")},
        {"account_id": "anz-rewards-black-visa", "old": Decimal("-6000"), "new": Decimal("-4000")},
    ])
    assert fired == ["ok"]
