"""Tests for GET /budgets/{category}/transactions (get_budget_transactions) — the
transactions behind a budget's total, so the budget-detail list reconciles with the
header instead of the old rolling 7-day feed.

The endpoint MUST derive its rows from the SAME window (_cycle_window_for) + subtree
(subtree_ids) + contribution rule (contributes_to_budget) as list_budgets, so the
headline test proves sum(list rows) == /budgets total for the same id + data.
"""

import json
from decimal import Decimal

import pytest


# --- fakes (local; mirror the test_budgets.py stand-ins) ---------------------


class _DateFilteringTransactionRepo:
    """Honours the date bounds like DynamoDB `between` (inclusive both ends over
    YYYY-MM-DD strings), so a test proves the endpoint pulls the WHOLE cycle — not a
    7-day slice. Serves the pool once (then empty) so the per-account loop counts each
    transaction a single time."""

    def __init__(self, transactions):
        self._txns = list(transactions)
        self._served = False
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        if self._served:
            return [], None
        self._served = True
        page = [t for t in self._txns if start_date <= t["date"] <= end_date]
        return page, None


class _FakePayCycleRepo:
    def __init__(self, length=30, last_pay_date="2026-07-01"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


class _FakeCategoryRepo:
    def __init__(self, categories):
        self._categories = categories

    def list_categories(self):
        return [dict(c) for c in self._categories]


class _FakeBudgetRepo:
    def __init__(self, budgets):
        self._budgets = budgets

    def list_budgets(self):
        return {k: dict(v) for k, v in self._budgets.items()}


# A parent Cafes-&-Coffee budget with a sub-category (both same bucket, so the sub
# rolls into the parent's total + subtree).
CATEGORIES = [
    {"id": "coffee", "bucket": "Lifestyle", "parent": None},
    {"id": "coffee-beans", "bucket": "Lifestyle", "parent": "coffee"},
]


def _txn(txn_id, category, amount, date, status="posted", counts=True, excluded=False):
    row = {
        "transaction_id": txn_id,
        "category": category,
        "amount": Decimal(str(amount)),
        "status": status,
        "counts_to_budget": counts,
        "date": date,
        "pk": "ACCT#up-spending",
        "sk": f"TXN#{txn_id}",
    }
    if excluded:
        row["budget_excluded"] = True
    return row


def _event(category="coffee"):
    return {
        "rawPath": f"/budgets/{category}/transactions",
        "requestContext": {"http": {"method": "GET"}},
        "pathParameters": {"category": category},
    }


# The reported screenshot: cycle 01–25 Jul, total $52, but only the last-7-days rows
# were visible. These are the rows behind that $52.
def _screenshot_transactions():
    return [
        _txn("t1", "coffee", -11, "2026-07-21"),
        _txn("t2", "coffee", -12.5, "2026-07-20"),
        _txn("t3", "coffee", -17, "2026-07-13"),          # in-cycle but > 7 days old
        _txn("t4", "coffee-beans", -11.5, "2026-07-12"),  # sub-category, > 7 days old
        _txn("t5", "coffee", -9, "2026-07-19", counts=False),   # !counts_to_budget
        _txn("t6", "coffee", -4, "2026-07-19", excluded=True),  # budget_excluded
        _txn("t7", "coffee", -100, "2026-06-30"),         # BEFORE cycle_start
    ]


def test_list_reconciles_with_budget_total(handler, monkeypatch):
    # THE headline fail-on-revert: the rows sum to the /budgets header, over the WHOLE
    # cycle and the WHOLE subtree. Reverting the subtree filter drops t4; reverting to a
    # 7-day feed drops t3/t4; both flip this. contributes drops t5/t6; the window drops t7.
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))

    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(_screenshot_transactions()),
        _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES),
    )["coffee"]
    total_spend = total["posted"] + total["pending"]

    txn_repo = _DateFilteringTransactionRepo(_screenshot_transactions())
    resp = handler.get_budget_transactions(
        _event("coffee"), txn_repo, _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))

    assert resp["statusCode"] == 200
    rows = json.loads(resp["body"])
    assert [r["transaction_id"] for r in rows] == ["t1", "t2", "t3", "t4"]  # newest-first
    listed = sum(Decimal(str(-r["amount"])) for r in rows)
    assert listed == total_spend == Decimal("52.0")
    # The window is the whole cycle [cycle_start, today] — NOT a 7-day feed.
    assert txn_repo.calls[0][1] == "2026-07-01"
    assert txn_repo.calls[0][2] == "2026-07-25"


def test_excludes_non_contributing_rows(handler, monkeypatch):
    # budget_excluded, !counts_to_budget and an unknown status never appear (they're not
    # in the total either), so the eyeballed rows can't disagree with the header.
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    txns = [
        _txn("keep", "coffee", -10, "2026-07-10"),
        _txn("nocount", "coffee", -10, "2026-07-10", counts=False),
        _txn("excluded", "coffee", -10, "2026-07-10", excluded=True),
        _txn("unknown", "coffee", -10, "2026-07-10", status="cancelled"),
    ]
    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES))

    assert [r["transaction_id"] for r in json.loads(resp["body"])] == ["keep"]


def test_strips_pk_sk(handler, monkeypatch):
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    resp = handler.get_budget_transactions(
        _event("coffee"),
        _DateFilteringTransactionRepo([_txn("t1", "coffee", -5, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))

    row = json.loads(resp["body"])[0]
    assert "pk" not in row and "sk" not in row


def test_missing_category_id_returns_404(handler):
    event = {"rawPath": "/budgets//transactions",
             "requestContext": {"http": {"method": "GET"}},
             "pathParameters": {}}
    resp = handler.get_budget_transactions(
        event, _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES))

    assert resp["statusCode"] == 404


def test_empty_cycle_returns_empty_list(handler, monkeypatch):
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES))

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


# --- routing -----------------------------------------------------------------


def test_router_dispatches_budget_transactions(handler, monkeypatch):
    # GET /budgets/{id}/transactions reaches the new handler, NOT list_budgets.
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: object())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: object())
    monkeypatch.setattr(handler, "get_budget_transactions",
                        lambda *a: handler._json_response(200, [{"transaction_id": "sentinel"}]))
    monkeypatch.setattr(handler, "list_budgets",
                        lambda *a: pytest.fail("collection route reached from the item path"))

    resp = handler.lambda_handler(_event("coffee"), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])[0]["transaction_id"] == "sentinel"


def test_router_put_budget_not_captured_by_transactions_route(handler, monkeypatch):
    # A PUT /budgets/{id} must still reach set_budget, never the GET transactions handler.
    monkeypatch.setattr(handler, "BudgetRepository", lambda: object())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: object())
    monkeypatch.setattr(handler, "get_budget_transactions",
                        lambda *a: pytest.fail("PUT reached the GET transactions handler"))
    monkeypatch.setattr(handler, "set_budget",
                        lambda *a: handler._json_response(200, {"id": "coffee", "target": 58}))

    resp = handler.lambda_handler(
        {"rawPath": "/budgets/coffee", "requestContext": {"http": {"method": "PUT"}},
         "pathParameters": {"category": "coffee"}, "body": '{"target": 58}'}, None)

    assert resp["statusCode"] == 200
