"""WHIT-802: pull-to-refresh runs the goal-checkpoint check too.

Pull-to-refresh rewrites the ACCTBAL row the daily poll compares a synced goal against, so a
checkpoint crossed first by a refresh must be celebrated there, once — otherwise the poll sees
old == new and the push is lost for good. Only the bank fetch, DynamoDB (FakeTable), time and the
push send are stubbed; the goal store is the real GoalsRepository over a FakeTable.
"""

from decimal import Decimal

import pytest

from _balance_fakes import (
    CHECKPOINT_GOAL, CHECKPOINT_PUSH_TITLE, LIVE_PAYLOADS, REFRESH_EVENT, BrokenGoalsRepo, balance_repo,
    fetch_all, freeze_time, spending_row, stub_bank, stub_refresh_side_effects,
)
from _dynamo_fakes import FakeTable
from _milestone_fakes import goal_checkpoint_repo


def _goals_repo(handler):
    repo = handler.GoalsRepository()
    repo._table = FakeTable()
    repo.upsert_goal("g1", dict(CHECKPOINT_GOAL))
    return repo


@pytest.mark.parametrize(
    ("stored_spending", "last_refresh_at", "refresh_times", "expected_pushes"),
    [
        # 90,000 -> 96,270.59 crosses the 95,000 checkpoint: one push; a later refresh adds none.
        ("90000", None, (10_000, 20_000), [CHECKPOINT_PUSH_TITLE]),
        # 96,000 -> 96,270.59 crosses nothing.
        ("96000", None, (10_000,), []),
        # Throttled: no bank call, no push.
        ("90000", 9_999, (10_000,), []),
    ],
    ids=["crossing-fires-once", "no-crossing", "throttled"],
)
def test_refresh_celebrates_a_goal_checkpoint_crossing_once(
    handler, monkeypatch, stored_spending, last_refresh_at, refresh_times, expected_pushes
):
    accounts = balance_repo(rows=[spending_row(stored_spending)], last=last_refresh_at)
    goals = _goals_repo(handler)
    pushes = []
    bank_calls = []
    stub_bank(handler, monkeypatch, lambda bid, aid, key, **kw: bank_calls.append(aid) or LIVE_PAYLOADS[aid])
    stub_refresh_side_effects(handler, monkeypatch, accounts=accounts, goals=goals,
                              notify=goal_checkpoint_repo(), pushes=pushes)

    assert 20_000 - 10_000 >= handler.REFRESH_THROTTLE_SECONDS
    for now in refresh_times:
        freeze_time(handler, monkeypatch, now)
        assert handler.lambda_handler(REFRESH_EVENT, None)["statusCode"] == 200

    assert pushes == expected_pushes
    if last_refresh_at is not None:
        assert bank_calls == []


def test_refresh_survives_a_failing_goal_read(handler, monkeypatch):
    accounts = balance_repo(rows=[spending_row("90000")])

    pushes = []
    stub_bank(handler, monkeypatch, fetch_all)
    stub_refresh_side_effects(handler, monkeypatch, accounts=accounts, goals=BrokenGoalsRepo(),
                              notify=goal_checkpoint_repo(), pushes=pushes)
    freeze_time(handler, monkeypatch, 10_000)

    response = handler.lambda_handler(REFRESH_EVENT, None)

    assert response["statusCode"] == 200
    stored = {row["account_id"]: row["amount"] for row in handler.get_account_balances(accounts)}
    assert stored["up-spending"] == Decimal("96270.59")
    assert len(stored) == 4
    assert pushes == []
