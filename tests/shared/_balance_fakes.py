"""The REAL AccountBalanceRepository over a FakeTable for the balance-refresh suites (WHIT-625).

The refresh throttle marker and the stored balances are production's rows, so a later read sees
what an earlier write really stored. ``balance_writes`` reads the table's put log in order.

Resolved by pytest.ini's `pythonpath = tests/shared`. The shared layer is imported lazily, inside
``balance_repo``, so inside a ``handler``-style fixture it comes from the freshly loaded copy.
"""

from decimal import Decimal

from _dynamo_fakes import FakeTable
from _milestone_fakes import FakeDeviceRepo, FakeGoalsRepo, FakeLoanFactsRepo, FakeMilestoneRepo

_MARKER_PK = "ACCTBAL#REFRESH"
_BALANCE_PREFIX = "ACCTBAL#"


REFRESH_EVENT = {"rawPath": "/accounts/balances/refresh", "requestContext": {"http": {"method": "POST"}}}


def ok_payload(amount, account_type):
    """A successful BankSync getBalance payload."""
    return {"success": True, "data": {"amount": amount, "date": "2026-10-06T00:00:00Z",
                                      "currency": "AUD", "accountType": account_type}}


# BankSync getBalance payloads keyed by the source `aid` a refresh fans out over.
LIVE_PAYLOADS = {
    "3zVQJ8Btz_IRmqp78VrQnQ": ok_payload("96270.59", "checking"),                       # up-spending
    "T6d8ppsYssBDFCwl1qEb0w": ok_payload("-596642.43", "mortgage"),                     # up-homeloan
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": ok_payload("-6492.26", "unknown"),   # anz
    "A3AC9195-9E8D-48B8-86D0-46D130D7F64A": ok_payload("-230", "unknown"),              # westpac
}


HOMELOAN_AID = "T6d8ppsYssBDFCwl1qEb0w"


def fetch_all(bid, aid, key, **kw):
    """A bank fetch where every account succeeds with its LIVE_PAYLOADS reading."""
    return LIVE_PAYLOADS[aid]


def fetch_all_but_homeloan(bid, aid, key, **kw):
    """A bank fetch where only the home loan fails."""
    if aid == HOMELOAN_AID:
        return {"success": False}
    return LIVE_PAYLOADS[aid]


# A synced grow goal on up-spending whose "Halfway" checkpoint sits at 95,000.
CHECKPOINT_GOAL = {"direction": "grow", "name": "Holiday", "account_id": "up-spending",
                   "target_amount": Decimal("120000"),
                   "checkpoints": [{"id": "cp1", "label": "Halfway", "amount": Decimal("95000")}]}
CHECKPOINT_PUSH_TITLE = "\U0001f389 Checkpoint reached — Halfway!"


class BrokenGoalsRepo:
    """A goal store whose read fails."""

    def list_goals(self):
        raise RuntimeError("goals store unreadable")


def milestone_spy(calls, raises=False):
    """A stand-in for notify_homeloan_milestone that records each (old, new) in ``calls`` and,
    when ``raises``, then fails."""
    def spy(old, new, **repos):
        calls.append((old, new))
        if raises:
            raise RuntimeError("milestone push down")
        return 0
    return spy


def homeloan_row(amount, as_of="2026-10-05T00:00:00Z"):
    """A stored up-homeloan balance (list_balances-shaped) owing the signed ``amount``."""
    return {"account_id": "up-homeloan", "amount": Decimal(amount), "available_balance": Decimal("0"),
            "currency": "AUD", "as_of": as_of, "account_type": "mortgage"}


def balance_repo(rows=(), last=None, upsert_fails=False):
    """The real AccountBalanceRepository holding ``rows`` (list_balances-shaped dicts, stored
    through the real upsert_balance) and, when ``last`` is given, a refresh marker at that epoch.
    The put log is cleared after that setup, so ``balance_writes`` shows only the code under test.
    ``upsert_fails`` makes every later write raise (DynamoDB down); the attempt is still logged."""
    from repository import AccountBalanceRepository

    repo = AccountBalanceRepository()
    repo._table = FakeTable()
    for row in rows:
        repo.upsert_balance(row["account_id"], row["amount"], row["available_balance"],
                            row["currency"], row["as_of"], row["account_type"])
    if last is not None:
        repo.set_last_refresh_at(last)
    repo._table.put_calls.clear()
    if upsert_fails:
        repo._table.fail("put_item")
    return repo


def stub_bank(handler, monkeypatch, fetch):
    """Stub a refresh's bank fetch with ``fetch`` and its goal store with no goals, so the
    refresh's goal-checkpoint check runs against a known empty list, not the stubbed boto3."""
    monkeypatch.setattr(handler, "get_api_key", lambda: "test-key")
    monkeypatch.setattr(handler, "fetch_balance", fetch)
    monkeypatch.setattr(handler, "GoalsRepository", lambda: FakeGoalsRepo())


def stub_refresh_side_effects(handler, monkeypatch, *, accounts, goals, notify, pushes):
    """Patch the stores a refresh writes and checks: ``accounts`` balances, ``goals`` and the
    ``notify`` marker store as given; canned loan facts, one device and no milestones. Each
    goal-checkpoint push title is appended to ``pushes``. Call after ``stub_bank``, which
    resets the goal store to empty."""
    import sys

    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: accounts)
    monkeypatch.setattr(handler, "GoalsRepository", lambda: goals)
    monkeypatch.setattr(handler, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: FakeLoanFactsRepo())
    monkeypatch.setattr(handler, "DeviceRepository", lambda: FakeDeviceRepo())
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: FakeMilestoneRepo(stored=[]))
    monkeypatch.setattr(sys.modules["goal_checkpoints"], "send_push",
                        lambda title, body, tokens, **kw: pushes.append(title))


def balance_writes(repo):
    """Each write in order: ("set", epoch) for the refresh marker, ("upsert", account_id) for a
    stored balance."""
    writes = []
    for item in repo._table.put_calls:
        if item["pk"] == _MARKER_PK:
            writes.append(("set", item["last_fetch_at"]))
        else:
            writes.append(("upsert", item["pk"][len(_BALANCE_PREFIX):]))
    return writes


def marker_writes(repo):
    """The epoch of each refresh-marker write, in order."""
    return [at for kind, at in balance_writes(repo) if kind == "set"]


def upserted(repo):
    """{account_id: amount} of every balance the code stored."""
    return {item["pk"][len(_BALANCE_PREFIX):]: item["amount"]
            for item in repo._table.put_calls if item["pk"] != _MARKER_PK}


def feed_watch_repo(handler, watches=None):
    """The REAL FeedWatchRepository (from ``handler``'s loaded copy) over a FakeTable, with
    ``watches`` ({account_id: put_watch kwargs}) already stored through the real put_watch. The put
    log is cleared after that setup, so ``put_calls`` shows only the code under test."""
    watch_repo = handler.FeedWatchRepository()
    watch_repo._table = FakeTable()
    for account_id, watch in (watches or {}).items():
        watch_repo.put_watch(account_id, **watch)
    watch_repo._table.put_calls.clear()
    return watch_repo
