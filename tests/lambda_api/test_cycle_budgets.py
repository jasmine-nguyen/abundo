"""WHIT-703 slice 2 — GET /transactions/cycle?cycle=N also returns `budgets` for the same
window, so the export's Budgets tab is one request. Driven through lambda_handler (event in →
JSON out), next to GET /budgets on the same fakes.

Pay cycle: last_pay_date 2026-07-01, length 30, today 2026-07-25 →
cycle 0 = [2026-07-01, 2026-07-25], cycle 1 = [2026-06-01, 2026-06-30].
"""

import json
from datetime import date
from decimal import Decimal

import pytest

from _budget_fakes import recording_budget_repo

LENGTH = 30
PAYDATE = "2026-07-01"


class _DateFilteringTransactionRepo:
    """Honours the inclusive [start, end] read; serves the pool once so the per-account loop
    in read_window sees each transaction a single time."""

    def __init__(self, transactions):
        self._txns = list(transactions)
        self._served = False

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        if self._served:
            return [], None
        self._served = True
        return [dict(t) for t in self._txns if start_date <= t["date"] <= end_date], None


class _FakePayCycleRepo:
    def get_paycycle(self):
        return {"length": LENGTH, "last_pay_date": PAYDATE}


class _FakeCategoryRepo:
    def __init__(self):
        self.calls = 0

    def list_categories(self):
        self.calls += 1
        return [dict(c) for c in CATEGORIES]


CATEGORIES = [
    {"id": "food", "name": "Food", "bucket": "Lifestyle", "parent": None},
    {"id": "coffee", "name": "Coffee", "bucket": "Lifestyle", "parent": "food"},
    {"id": "fun", "name": "Fun", "bucket": "Lifestyle", "parent": None},
    {"id": "sink", "name": "Car service", "bucket": "Lifestyle", "parent": None},
    {"id": "insurance", "name": "Insurance", "bucket": "Lifestyle", "parent": None},
    {"id": "salary", "name": "Salary", "bucket": "Income", "parent": None},
    {"id": "nest_egg", "name": "Nest egg", "bucket": "Savings", "parent": None},
]


def _budgets():
    return {
        "food": {"target": Decimal("500")},
        "coffee": {"target": Decimal("50")},
        "salary": {"target": Decimal("4000")},
        "nest_egg": {"target": Decimal("300")},
        # Rollover anchored at the start of last cycle → /budgets reads wider than this cycle
        # and seals last cycle (writes a settlement), which the export must never do.
        "sink": {"target": Decimal("100"), "rollover": True, "carryover": Decimal(0),
                 "carryover_from": "2026-06-01", "carryover_len": Decimal(LENGTH),
                 "carryover_paydate": PAYDATE},
        # Bill spread anchored this cycle → a positive adjustment on both routes.
        "insurance": {"target": Decimal("100"), "spread_amount": Decimal("600"),
                      "spread_cycles": Decimal(4), "spread_from": "2026-07-01",
                      "spread_len": Decimal(LENGTH), "spread_paydate": PAYDATE},
    }


def _txn(txn_id, date_, amount, category, status="posted"):
    return {
        "transaction_id": txn_id, "date": date_, "amount": Decimal(str(amount)),
        "category": category, "status": status, "counts_to_budget": True,
        "merchant_name": "Shop", "description": "SHOP", "account_name": "Everyday",
        "pk": "ACCOUNT#up-spending", "sk": f"TXN#{txn_id}",
    }


TXNS = [
    _txn("before-last", "2026-05-31", -1, "coffee"),        # before cycle 1 → never counted
    # cycle 1 (last cycle)
    _txn("l-food", "2026-06-01", -10, "food"),              # tagged straight onto the parent
    _txn("l-coffee-pending", "2026-06-15", -4, "coffee", status="pending"),
    _txn("l-salary", "2026-06-15", 3000, "salary"),
    _txn("l-nest", "2026-06-10", -100, "nest_egg"),
    _txn("l-fun", "2026-06-12", -30, "fun"),
    _txn("l-sink", "2026-06-20", -60, "sink"),
    _txn("l-coffee", "2026-06-30", -20, "coffee"),
    # cycle 0 (this cycle)
    _txn("t-coffee", "2026-07-01", -5, "coffee"),
    _txn("t-food", "2026-07-02", -40, "food"),
    _txn("t-insurance", "2026-07-06", -600, "insurance"),
    _txn("t-salary", "2026-07-03", 4100, "salary"),
    _txn("t-nest", "2026-07-04", -50, "nest_egg"),
    _txn("t-fun", "2026-07-05", -25, "fun"),
    _txn("t-coffee-pending", "2026-07-20", -7.5, "coffee", status="pending"),
    _txn("t-sink", "2026-07-21", -30, "sink"),
    _txn("future", "2026-07-26", -99, "coffee"),            # after today → never counted
]


@pytest.fixture
def wired(handler, monkeypatch):
    """Patch every repository the routes build; each request gets fresh fakes."""
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2026, 7, 25))
    made = {"budget": [], "category": []}

    def budget_repo():
        repo = recording_budget_repo(_budgets())
        made["budget"].append(repo)
        return repo

    def category_repo():
        repo = _FakeCategoryRepo()
        made["category"].append(repo)
        return repo

    monkeypatch.setattr(handler, "TransactionRepository", lambda: _DateFilteringTransactionRepo(TXNS))
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: _FakePayCycleRepo())
    monkeypatch.setattr(handler, "BudgetRepository", budget_repo)
    monkeypatch.setattr(handler, "CategoryRepository", category_repo)
    return made


def _get(handler, path, query=None):
    event = {"rawPath": path, "requestContext": {"http": {"method": "GET"}}}
    if query is not None:
        event["queryStringParameters"] = query
    response = handler.lambda_handler(event, None)
    assert response["statusCode"] == 200, response
    return json.loads(response["body"], parse_float=Decimal)


BUDGETED = {"food", "coffee", "salary", "nest_egg", "sink", "insurance"}


def test_user_can_export_each_budgets_numbers_for_this_and_last_cycle(handler, wired):
    export = _get(handler, "/transactions/cycle")
    export_repos = list(wired["budget"])
    budgets_screen = _get(handler, "/budgets")
    screen_repo = wired["budget"][-1]
    # The Budgets screen lists every budget (Income earn-target and Savings included) and
    # seals the rollover as it reads.
    assert set(budgets_screen) == BUDGETED
    assert screen_repo.settle_calls != []

    # This cycle: exactly the Budgets screen's numbers; unbudgeted "fun" is absent.
    assert export["budgets"] == budgets_screen
    # Parent includes its child's spend and its own: 40 + 5 posted, 7.5 pending.
    assert Decimal(str(export["budgets"]["food"]["posted"])) == Decimal("45")
    assert Decimal(str(export["budgets"]["food"]["pending"])) == Decimal("7.5")
    # The export is read-only.
    for repo in export_repos:
        assert repo.settle_calls == []
        assert repo.set_spread_calls == []
        assert repo.clear_spread_calls == []
    # The wider rollover read doesn't leak into the exported transaction list.
    assert [r["transaction_id"] for r in export["transactions"]] == [
        "t-sink", "t-coffee-pending", "t-insurance", "t-fun", "t-nest",
        "t-salary", "t-food", "t-coffee"]

    # Last cycle: spend from [2026-06-01, 2026-06-30] only, against today's targets.
    before = len(wired["budget"])
    budgets = _get(handler, "/transactions/cycle", {"cycle": "1"})["budgets"]
    assert set(budgets) == BUDGETED

    def numbers(cat_id):
        entry = budgets[cat_id]
        return (Decimal(str(entry["target"])), Decimal(str(entry["posted"])), Decimal(str(entry["pending"])))

    # Parent: own 10 + child's 20 posted, child's 4 pending.
    assert numbers("food") == (Decimal("500"), Decimal("30"), Decimal("4"))
    assert numbers("coffee") == (Decimal("50"), Decimal("20"), Decimal("4"))
    # Income earn-target: positive earnings.
    assert numbers("salary") == (Decimal("4000"), Decimal("3000"), Decimal("0"))
    assert numbers("nest_egg")[0] == Decimal("300")
    assert numbers("sink") == (Decimal("100"), Decimal("60"), Decimal("0"))
    assert numbers("insurance") == (Decimal("100"), Decimal("0"), Decimal("0"))
    assert all(repo.settle_calls == [] for repo in wired["budget"][before:])

