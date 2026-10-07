"""WHIT-802: pull-to-refresh runs the goal-checkpoint check too.

Pull-to-refresh rewrites the ACCTBAL row the daily poll compares a synced goal against, so a
checkpoint crossed first by a refresh must be celebrated there, once — otherwise the poll sees
old == new and the push is lost for good. Only the bank fetch, DynamoDB (FakeTable), time and the
push send are stubbed; the goal store is the real GoalsRepository over a FakeTable.
"""

import sys
from decimal import Decimal
from types import SimpleNamespace

import pytest

from _balance_fakes import balance_repo
from _dynamo_fakes import FakeTable
from _milestone_fakes import FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, goal_checkpoint_repo

_REFRESH_EVENT = {"rawPath": "/accounts/balances/refresh",
                  "requestContext": {"http": {"method": "POST"}}}
_PUSH_TITLE = "\U0001f389 Checkpoint reached — Halfway!"


def _ok_payload(amount, account_type):
    return {"success": True, "data": {"amount": amount, "date": "2026-10-06T00:00:00Z",
                                      "currency": "AUD", "accountType": account_type}}


_LIVE_PAYLOADS = {
    "3zVQJ8Btz_IRmqp78VrQnQ": _ok_payload("96270.59", "checking"),                       # up-spending
    "T6d8ppsYssBDFCwl1qEb0w": _ok_payload("-596642.43", "mortgage"),                     # up-homeloan
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": _ok_payload("-6492.26", "unknown"),   # anz
    "A3AC9195-9E8D-48B8-86D0-46D130D7F64A": _ok_payload("-230", "unknown"),              # westpac
}

_GOAL = {"direction": "grow", "name": "Holiday", "account_id": "up-spending",
         "target_amount": Decimal("120000"),
         "checkpoints": [{"id": "cp1", "label": "Halfway", "amount": Decimal("95000")}]}


def _spending_row(amount):
    return {"account_id": "up-spending", "amount": Decimal(amount), "available_balance": Decimal(amount),
            "currency": "AUD", "as_of": "2026-10-05T00:00:00Z", "account_type": "checking"}


def _goals_repo(handler):
    repo = handler.GoalsRepository()
    repo._table = FakeTable()
    repo.upsert_goal("g1", dict(_GOAL))
    return repo


@pytest.mark.parametrize(
    ("stored_spending", "last_refresh_at", "refresh_times", "expected_pushes"),
    [
        # 90,000 -> 96,270.59 crosses the 95,000 checkpoint: one push; a later refresh adds none.
        ("90000", None, (10_000, 20_000), [_PUSH_TITLE]),
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
    accounts = balance_repo(rows=[_spending_row(stored_spending)], last=last_refresh_at)
    goals = _goals_repo(handler)
    notify = goal_checkpoint_repo()
    pushes = []
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "GoalsRepository", lambda: goals)
    monkeypatch.setattr(handler, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: FakeLoanFactsRepo())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: FakeDeviceRepo())
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: FakeMilestoneRepo(stored=[]))
    monkeypatch.setattr(sys.modules["goal_checkpoints"], "send_push",
                        lambda title, body, tokens, **kw: pushes.append(title))
    monkeypatch.setattr(handler, "get_api_key", lambda: "test-key")
    bank_calls = []
    monkeypatch.setattr(handler, "fetch_balance",
                        lambda bid, aid, key, **kw: bank_calls.append(aid) or _LIVE_PAYLOADS[aid])

    assert 20_000 - 10_000 >= handler.REFRESH_THROTTLE_SECONDS
    for now in refresh_times:
        monkeypatch.setattr(handler, "time", SimpleNamespace(time=lambda now=now: now))
        assert handler.lambda_handler(_REFRESH_EVENT, None)["statusCode"] == 200

    assert pushes == expected_pushes
    if last_refresh_at is not None:
        assert bank_calls == []


def test_refresh_survives_a_failing_goal_read(handler, monkeypatch):
    accounts = balance_repo(rows=[_spending_row("90000")])

    class _BrokenGoals:
        def list_goals(self):
            raise RuntimeError("goals store unreadable")

    pushes = []
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "GoalsRepository", _BrokenGoals)
    monkeypatch.setattr(handler, "NotifyRepository", lambda: goal_checkpoint_repo())
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: FakeLoanFactsRepo())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: FakeDeviceRepo())
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: FakeMilestoneRepo(stored=[]))
    monkeypatch.setattr(sys.modules["goal_checkpoints"], "send_push",
                        lambda title, body, tokens, **kw: pushes.append(title))
    monkeypatch.setattr(handler, "get_api_key", lambda: "test-key")
    monkeypatch.setattr(handler, "fetch_balance", lambda bid, aid, key, **kw: _LIVE_PAYLOADS[aid])
    monkeypatch.setattr(handler, "time", SimpleNamespace(time=lambda: 10_000))

    response = handler.lambda_handler(_REFRESH_EVENT, None)

    assert response["statusCode"] == 200
    stored = {row["account_id"]: row["amount"] for row in accounts.list_balances(
        sorted(set(handler.ACCOUNT_ID_MAP.values())))}
    assert stored["up-spending"] == Decimal("96270.59")
    assert len(stored) == 4
    assert pushes == []
