"""WHIT-479 slice 4a — gap test for the balance-poller's goal-checkpoint hook.

The per-goal loop (which goals fire, with what old/new, per-goal failure isolation) moved to the
shared check_goal_checkpoints in WHIT-802 and is tested in tests/shared/test_goal_checkpoints_gaps.py.
Here we prove only the poller wiring a no-op poll relies on.
"""


# [A30] empty deltas -> no repos are even constructed (the store-nothing poll stays cheap/safe).
def test_check_goal_checkpoints_empty_deltas_touches_no_repo(handler, monkeypatch):
    def boom():
        raise AssertionError("GoalsRepository must not be built for an empty poll")
    monkeypatch.setattr(handler, "GoalsRepository", boom)
    handler._check_goal_checkpoints([])   # must return before constructing anything
