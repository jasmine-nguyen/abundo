"""WHIT-792: the poller fetches and stores the home loan once, through the BALANCE_SOURCES loop.

The home-loan checks (WHIT-301 milestone push, WHIT-316 drop alarm, WHIT-317 precise miss
check) run off that single fetch: `old` is the stored ACCTBAL#up-homeloan amount, `new` the
fresh one, both as the positive amount still owed. Driven end to end through lambda_handler,
with only the bank (urlopen), DynamoDB (FakeTable) and the push send stubbed.
"""

import logging
import sys
from decimal import Decimal

import pytest

from _balance_fakes import balance_repo, upserted
from _http_fakes import FakeResponse, http_error
from _milestone_fakes import FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, notify_repo, _row
from _transaction_range_fakes import _QueuedTransactionRepo

_HOMELOAN_AID = "T6d8ppsYssBDFCwl1qEb0w"
_HEARTBEAT = "BALANCE_POLL_ALL_STORED"
_DROP_ALARM = "UP_WEBHOOK_REPAYMENT_MISSED mortgage balance dropped"


def _payload(amount, account_type):
    return {"success": True, "data": {
        "date": "2026-10-06T00:00:00.000Z", "amount": amount, "availableBalance": 0,
        "currency": "AUD", "accountType": account_type,
    }}


_PAYLOADS_BY_AID = {
    "3zVQJ8Btz_IRmqp78VrQnQ": _payload(96270.59, "checking"),                        # up-spending
    _HOMELOAN_AID: _payload(-596642.43, "mortgage"),                                 # up-homeloan
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": _payload(-6492.26, "unknown"),    # anz
    "A3AC9195-9E8D-48B8-86D0-46D130D7F64A": _payload(-230, "unknown"),               # westpac
}

# Last poll stored the home loan at -600000 (owed 600,000). Today's reading owes 596,642.43:
# a 3,357.57 drop (over the 3,000 alarm threshold) that crosses the 598,000 milestone.
_PRIOR_HOMELOAN = {"account_id": "up-homeloan", "amount": Decimal("-600000"),
                   "available_balance": Decimal("0"), "currency": "AUD",
                   "as_of": "2026-10-05T00:00:00.000Z", "account_type": "mortgage"}


@pytest.fixture
def poll(handler, monkeypatch, caplog):
    """Wire lambda_handler to fakes at the system boundaries. Returns a runner that takes the
    aids whose bank fetch fails and reports what happened."""
    accounts = balance_repo(rows=[_PRIOR_HOMELOAN])
    notify = notify_repo()
    transactions = _QueuedTransactionRepo([])
    fetched = []
    pushes = []

    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: transactions)
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: FakeLoanFactsRepo())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: FakeDeviceRepo())
    monkeypatch.setattr(handler, "MilestoneRepository",
                        lambda: FakeMilestoneRepo(stored=[_row("Under 598k", 598000)]))
    monkeypatch.setattr(sys.modules["milestones"], "send_push",
                        lambda title, body, tokens, **kw: pushes.append(title)
                        or {"sent": len(tokens), "ok": len(tokens), "pruned": []})
    caplog.set_level(logging.INFO)

    def run(failing_aids=()):
        def urlopen(req, timeout=None):
            aid = next(a for a in _PAYLOADS_BY_AID if a in req.full_url)
            fetched.append(aid)
            if aid in failing_aids:
                raise http_error(503)
            return FakeResponse(_PAYLOADS_BY_AID[aid])

        monkeypatch.setattr(handler.urllib.request, "urlopen", urlopen)
        result = handler.lambda_handler({}, None)
        messages = [r.getMessage() for r in caplog.records]
        return {
            "result": result,
            "fetched": fetched,
            "stored": upserted(accounts),
            "pushes": pushes,
            "drop_alarms": [m for m in messages if _DROP_ALARM in m],
            "heartbeat": any(_HEARTBEAT in m for m in messages),
            "precise_check_reads": [call[0] for call in transactions.calls],
        }

    return run


def test_poll_fetches_the_home_loan_once_and_runs_its_checks_on_the_owed_amount(handler, poll):
    outcome = poll()

    # One bank call per balance source: the home loan is no longer fetched a second time.
    assert sorted(outcome["fetched"]) == sorted(source["aid"] for source in handler.BALANCE_SOURCES)
    assert outcome["stored"]["up-homeloan"] == Decimal("-596642.43")
    # Milestone push: owed went 600,000 -> 596,642.43, crossing 598,000 exactly once.
    assert outcome["pushes"] == ["\U0001f389 Milestone reached — Under 598k!"]
    # WHIT-316: the 3,357.57 drop with no recent repayment push raises the alarm line.
    assert len(outcome["drop_alarms"]) == 1
    assert "3357.57" in outcome["drop_alarms"][0]
    # WHIT-317 still reads the home loan's transactions (the feed-stall check reads the others).
    assert [a for a in outcome["precise_check_reads"] if a == "up-homeloan"] == ["up-homeloan"]
    assert outcome["result"] == {"accounts_stored": len(handler.BALANCE_SOURCES)}
    assert outcome["heartbeat"]


def test_a_failed_home_loan_fetch_skips_its_balance_checks_but_not_the_precise_miss_check(handler, poll):
    outcome = poll(failing_aids={_HOMELOAN_AID})

    assert sorted(outcome["fetched"]) == sorted(source["aid"] for source in handler.BALANCE_SOURCES)
    assert "up-homeloan" not in outcome["stored"]
    assert outcome["pushes"] == []
    assert outcome["drop_alarms"] == []
    assert [a for a in outcome["precise_check_reads"] if a == "up-homeloan"] == ["up-homeloan"]
    assert outcome["result"] == {"accounts_stored": len(handler.BALANCE_SOURCES) - 1}
    assert not outcome["heartbeat"]
