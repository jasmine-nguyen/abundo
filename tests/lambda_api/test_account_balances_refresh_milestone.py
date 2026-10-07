"""WHIT-792: pull-to-refresh runs the home-loan milestone check (sign-off decision B).

Pull-to-refresh rewrites the same ACCTBAL#up-homeloan row the daily poll compares against, so
a repayment seen first by a refresh must celebrate a crossed milestone there, once — a later
refresh (or poll) sees no change and stays quiet. A throttled refresh calls no bank and pushes
nothing. Only the bank fetch, DynamoDB (FakeTable), time and the push send are stubbed.
"""

import sys
from decimal import Decimal
from types import SimpleNamespace

import pytest

from _balance_fakes import LIVE_PAYLOADS, REFRESH_EVENT, balance_repo, stub_bank
from _milestone_fakes import FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, notify_repo, _row

_PUSH_TITLE = "\U0001f389 Milestone reached — Under 598k!"


def _homeloan_row(amount):
    return {"account_id": "up-homeloan", "amount": Decimal(amount), "available_balance": Decimal("0"),
            "currency": "AUD", "as_of": "2026-10-05T00:00:00Z", "account_type": "mortgage"}


@pytest.mark.parametrize(
    ("stored_homeloan", "last_refresh_at", "refresh_times", "expected_pushes"),
    [
        # Owed 600,000 -> 596,642.43 crosses 598,000: one push; a later refresh adds none.
        ("-600000", None, (10_000, 20_000), [_PUSH_TITLE]),
        # Owed 597,000 -> 596,642.43 crosses nothing.
        ("-597000", None, (10_000,), []),
        # Throttled: no bank call, stored balances served as-is, no push.
        ("-600000", 9_999, (10_000,), []),
    ],
    ids=["crossing-fires-once", "no-crossing", "throttled"],
)
def test_refresh_celebrates_a_home_loan_milestone_crossing_once(
    handler, monkeypatch, stored_homeloan, last_refresh_at, refresh_times, expected_pushes
):
    accounts = balance_repo(rows=[_homeloan_row(stored_homeloan)], last=last_refresh_at)
    notify = notify_repo()
    pushes = []
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: FakeLoanFactsRepo())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: FakeDeviceRepo())
    monkeypatch.setattr(handler, "MilestoneRepository",
                        lambda: FakeMilestoneRepo(stored=[_row("Under 598k", 598000)]))
    monkeypatch.setattr(sys.modules["milestones"], "send_push",
                        lambda title, body, tokens, **kw: pushes.append(title)
                        or {"sent": len(tokens), "ok": len(tokens), "pruned": []})
    stub_bank(handler, monkeypatch, lambda bid, aid, key, **kw: LIVE_PAYLOADS[aid])

    assert 20_000 - 10_000 >= handler.REFRESH_THROTTLE_SECONDS
    for now in refresh_times:
        monkeypatch.setattr(handler, "time", SimpleNamespace(time=lambda now=now: now))
        assert handler.lambda_handler(REFRESH_EVENT, None)["statusCode"] == 200

    assert pushes == expected_pushes
