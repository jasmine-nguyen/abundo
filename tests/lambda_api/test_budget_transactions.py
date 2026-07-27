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

# Repo fakes + row/event builders, shared with the WHIT-362 gap file (tests/shared).
from _budget_endpoint_fakes import (
    _DateFilteringTransactionRepo,
    _FakeBudgetRepo,
    _FakeCategoryRepo,
    _FakePayCycleRepo,
    _event,
    _txn,
)


# A parent Cafes-&-Coffee budget with a sub-category (both same bucket, so the sub
# rolls into the parent's total + subtree).
CATEGORIES = [
    {"id": "coffee", "bucket": "Lifestyle", "parent": None},
    {"id": "coffee-beans", "bucket": "Lifestyle", "parent": "coffee"},
]


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


def test_refund_reconciles_across_endpoints(handler, monkeypatch):
    # WHIT-362: a refund (positive amount) that does NOT drive a bucket negative still
    # reconciles across both endpoints — the list shows the refund row and its signed sum
    # equals the /budgets header, cent-for-cent, across posted + pending and the subtree.
    # Reverting either endpoint's window/subtree/contributes filter (or dropping the
    # refund row from the list) breaks the equality.
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    transactions = [
        _txn("spend", "coffee", -30, "2026-07-10"),          # $30 posted spend
        _txn("refund", "coffee-beans", 10, "2026-07-11"),    # $10 posted refund (sub-category)
        _txn("pending", "coffee", -5, "2026-07-12", status="pending"),  # $5 pending spend
    ]

    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES),
    )["coffee"]
    header_spend = total["posted"] + total["pending"]  # 30 - 10 refund + 5 pending = 25

    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))
    rows = json.loads(resp["body"])

    assert "refund" in [r["transaction_id"] for r in rows]   # the list keeps the refund row
    listed = sum(Decimal(str(-r["amount"])) for r in rows)   # refund's +10 subtracts here too
    assert listed == header_spend == Decimal("25")


def test_refund_that_clamps_the_header_still_bounds_the_list(handler, monkeypatch):
    # WHIT-362: when refunds drive a status bucket net-negative, the header floors at 0
    # (a bar can't go negative — the aggregate-then-clamp rule) while the list still shows
    # every refund row. The invariant the user relies on: the header never reads BELOW the
    # signed sum of the visible rows. Locks header >= listed and both buckets >= 0 — goes
    # RED if the list ever drops refund rows (listed rises above the floored header) or the
    # rollup stops clamping (a bucket goes negative).
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    transactions = [
        _txn("spend", "coffee", -10, "2026-07-10"),    # $10 posted spend
        _txn("refund", "coffee", 30, "2026-07-11"),    # $30 posted refund → posted nets -20
    ]

    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES),
    )["coffee"]

    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))
    rows = json.loads(resp["body"])

    assert "refund" in [r["transaction_id"] for r in rows]   # refund row is still listed
    listed = sum(Decimal(str(-r["amount"])) for r in rows)   # 10 - 30 = -20 (net refund)
    assert total["posted"] >= 0 and total["pending"] >= 0    # clamp holds — no negative bar
    assert total["posted"] == 0                              # -20 floored to 0
    assert total["posted"] + total["pending"] >= listed      # header never reads below the rows


def test_null_amount_row_does_not_break_the_header_and_stays_in_the_list(handler, monkeypatch):
    # WHIT-362: a contributing row with a missing/None amount (malformed data) must not
    # 500 the /budgets header — it counts as $0 — while /budgets/{id}/transactions still
    # lists it. Fail-on-revert: reverting _spend_contribution to Decimal(str(amount)) makes
    # list_budgets raise on Decimal("None"), so this test errors.
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    null_row = {
        "transaction_id": "null_amt", "category": "coffee", "amount": None,
        "status": "posted", "counts_to_budget": True, "date": "2026-07-11",
        "pk": "ACCT#up-spending", "sk": "TXN#null_amt",
    }
    transactions = [_txn("spend", "coffee", -10, "2026-07-10"), null_row]

    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))["coffee"]
    assert total["posted"] == Decimal("10")   # the None row counts as $0, only the real $10 spend

    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))
    assert "null_amt" in [r["transaction_id"] for r in json.loads(resp["body"])]


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
