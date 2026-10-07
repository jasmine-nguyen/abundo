"""WHIT-802 QA: on a refresh the home-loan milestone check and the goal-checkpoint check are
independent — neither one's failure, nor a missing home-loan reading, stops the other.

Only the bank fetch, DynamoDB (FakeTable), time and the push send are stubbed.
"""

import pytest

from _balance_fakes import (
    CHECKPOINT_GOAL, CHECKPOINT_PUSH_TITLE, REFRESH_EVENT, BrokenGoalsRepo, balance_repo, fetch_all,
    fetch_all_but_homeloan, freeze_time, milestone_spy, spending_row, stub_bank, stub_refresh_side_effects,
)
from _milestone_fakes import FakeGoalsRepo, goal_checkpoint_repo


@pytest.mark.parametrize(
    ("fetch", "milestone_raises", "goals", "expected_milestone_calls", "expected_pushes"),
    [
        # [A1] Home-loan fetch fails: no milestone check, but the goal check still runs.
        (fetch_all_but_homeloan, False, lambda: FakeGoalsRepo({"g1": dict(CHECKPOINT_GOAL)}), 0,
         [CHECKPOINT_PUSH_TITLE]),
        # [A2] The milestone check raises: the goal check still runs.
        (fetch_all, True, lambda: FakeGoalsRepo({"g1": dict(CHECKPOINT_GOAL)}), 1, [CHECKPOINT_PUSH_TITLE]),
        # [A3] The goal read raises: the milestone check still ran.
        (fetch_all, False, BrokenGoalsRepo, 1, []),
    ],
    ids=["homeloan-fetch-fails", "milestone-raises", "goal-read-raises"],
)
def test_refresh_runs_milestone_and_goal_checks_independently(
    handler, monkeypatch, fetch, milestone_raises, goals, expected_milestone_calls, expected_pushes
):
    accounts = balance_repo(rows=[spending_row("90000")])
    milestone_calls = []
    pushes = []
    stub_bank(handler, monkeypatch, fetch)
    stub_refresh_side_effects(handler, monkeypatch, accounts=accounts, goals=goals(),
                              notify=goal_checkpoint_repo(), pushes=pushes)
    monkeypatch.setattr(handler, "notify_homeloan_milestone", milestone_spy(milestone_calls, milestone_raises))
    freeze_time(handler, monkeypatch, 10_000)

    assert handler.lambda_handler(REFRESH_EVENT, None)["statusCode"] == 200

    assert len(milestone_calls) == expected_milestone_calls
    assert pushes == expected_pushes
