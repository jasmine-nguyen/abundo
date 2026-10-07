"""WHIT-802 QA: on a refresh the home-loan milestone check and the goal-checkpoint check are
independent — neither one's failure, nor a missing home-loan reading, stops the other.

Only the bank fetch, DynamoDB (FakeTable), time and the push send are stubbed.
"""

import sys
from decimal import Decimal
from types import SimpleNamespace

import pytest

from _balance_fakes import LIVE_PAYLOADS, REFRESH_EVENT, balance_repo, stub_bank
from _milestone_fakes import FakeDeviceRepo, FakeGoalsRepo, goal_checkpoint_repo

_HOMELOAN_AID = "T6d8ppsYssBDFCwl1qEb0w"
_CHECKPOINT_PUSH = "\U0001f389 Checkpoint reached — Halfway!"
_GOAL = {"direction": "grow", "name": "Holiday", "account_id": "up-spending",
         "target_amount": Decimal("120000"),
         "checkpoints": [{"id": "cp1", "label": "Halfway", "amount": Decimal("95000")}]}


class _BrokenGoals:
    def list_goals(self):
        raise RuntimeError("goals store unreadable")


def _fetch_all(bid, aid, key, **kw):
    return LIVE_PAYLOADS[aid]


def _fetch_without_homeloan(bid, aid, key, **kw):
    if aid == _HOMELOAN_AID:
        raise OSError("home loan feed down")
    return LIVE_PAYLOADS[aid]


@pytest.mark.parametrize(
    ("fetch", "milestone_raises", "goals", "expected_milestone_calls", "expected_pushes"),
    [
        # [A1] Home-loan fetch fails: no milestone check, but the goal check still runs.
        (_fetch_without_homeloan, False, lambda: FakeGoalsRepo({"g1": dict(_GOAL)}), 0, [_CHECKPOINT_PUSH]),
        # [A2] The milestone check raises: the goal check still runs.
        (_fetch_all, True, lambda: FakeGoalsRepo({"g1": dict(_GOAL)}), 1, [_CHECKPOINT_PUSH]),
        # [A3] The goal read raises: the milestone check still ran.
        (_fetch_all, False, _BrokenGoals, 1, []),
    ],
    ids=["homeloan-fetch-fails", "milestone-raises", "goal-read-raises"],
)
def test_refresh_runs_milestone_and_goal_checks_independently(
    handler, monkeypatch, fetch, milestone_raises, goals, expected_milestone_calls, expected_pushes
):
    accounts = balance_repo(rows=[{"account_id": "up-spending", "amount": Decimal("90000"),
                                   "available_balance": Decimal("90000"), "currency": "AUD",
                                   "as_of": "2026-10-05T00:00:00Z", "account_type": "checking"}])
    milestone_calls = []

    def milestone_spy(old, new, **repos):
        milestone_calls.append((old, new))
        if milestone_raises:
            raise RuntimeError("milestone store down")
        return 0

    pushes = []
    stub_bank(handler, monkeypatch, fetch)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "GoalsRepository", goals)
    monkeypatch.setattr(handler, "NotifyRepository", lambda: goal_checkpoint_repo())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: FakeDeviceRepo())
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: None)
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: None)
    monkeypatch.setattr(handler, "notify_homeloan_milestone", milestone_spy)
    monkeypatch.setattr(sys.modules["goal_checkpoints"], "send_push",
                        lambda title, body, tokens, **kw: pushes.append(title))
    monkeypatch.setattr(handler, "time", SimpleNamespace(time=lambda: 10_000))

    assert handler.lambda_handler(REFRESH_EVENT, None)["statusCode"] == 200

    assert len(milestone_calls) == expected_milestone_calls
    assert pushes == expected_pushes
