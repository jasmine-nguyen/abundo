"""Tests for GET /categories/{id}/transactions (get_category_transactions) — the
transactions behind one /breakdown row, so the category drill-in reconciles with the
Insights card instead of reading the rolling 7-day feed.

Reconciliation is the headline: the endpoint's rows (clamped the way the client + server
_summarise do) must equal list_category_breakdown[id] for the same fixture — for a named
category AND the uncategorized bucket, over the current and a prior cycle.
"""

import json
from datetime import date
from decimal import Decimal

import pytest


def _contributes(transaction):
    # Mirror of shared/spend.py contributes_to_budget (imported lazily is fragile at collect
    # time). Kept local like the other test fakes; the reconciliation asserts against the real
    # list_category_breakdown too, so any drift here is caught.
    if not transaction.get("counts_to_budget") or transaction.get("budget_excluded"):
        return False
    return transaction["status"] in ("posted", "pending")


# --- fakes (local; mirror test_budget_transactions.py) -----------------------


class _DateFilteringTransactionRepo:
    """Honours DynamoDB `between` (inclusive both ends over YYYY-MM-DD). Serves the pool
    once so the per-account loop counts each transaction a single time."""

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


# A parent Cafes & Coffee with a same-bucket sub-category (so a subtree bug would leak it).
CATS = [
    {"id": "coffee", "bucket": "Lifestyle", "parent": None},
    {"id": "coffee-beans", "bucket": "Lifestyle", "parent": "coffee"},
]


def _txn(txn_id, category, amount, date_, status="posted", counts=True, excluded=False):
    row = {
        "transaction_id": txn_id,
        "category": category,
        "amount": Decimal(str(amount)),
        "status": status,
        "counts_to_budget": counts,
        "date": date_,
        "pk": "ACCT#up-spending",
        "sk": f"TXN#{txn_id}",
    }
    if excluded:
        row["budget_excluded"] = True
    return row


def _event(category_id="coffee", cycle=None):
    event = {
        "rawPath": f"/categories/{category_id}/transactions",
        "requestContext": {"http": {"method": "GET"}},
        "pathParameters": {"id": category_id},
    }
    if cycle is not None:
        event["queryStringParameters"] = {"cycle": cycle}
    return event


def _pin_today(monkeypatch, day=date(2026, 7, 25)):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: day)


def _clamped_total(rows):
    """The rows' contributing spend, clamped per bucket at >= 0 then summed — the same
    reconciliation math the client (categoryTransactions) and /breakdown (_summarise) use."""
    posted = sum((-Decimal(str(r["amount"])) for r in rows
                  if _contributes(r) and r["status"] == "posted"), Decimal(0))
    pending = sum((-Decimal(str(r["amount"])) for r in rows
                   if _contributes(r) and r["status"] == "pending"), Decimal(0))
    return max(Decimal(0), posted) + max(Decimal(0), pending)


# --- reconciliation ----------------------------------------------------------


def test_named_category_reconciles_with_breakdown_exact_not_subtree(handler, monkeypatch):
    # The headline: the drilled rows sum to the /breakdown row for the SAME id, over the whole
    # cycle (incl. a >7-day-old charge the feed would miss). EXACT category — a sub-category's
    # rows are NOT folded in (that's what makes it match /breakdown, which is per-id).
    # FAIL-ON-REVERT: adopting subtree_ids would pull 'beans' in and break both assertions.
    _pin_today(monkeypatch)
    txns = [
        _txn("c1", "coffee", -11, "2026-07-21"),
        _txn("c2", "coffee", -17, "2026-07-08"),          # > 7 days old, in cycle
        _txn("beans", "coffee-beans", -9, "2026-07-09"),  # sub-category → must NOT appear
    ]
    breakdown = handler.list_category_breakdown(
        _FakeCategoryRepo(CATS), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo())

    resp = handler.get_category_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    rows = json.loads(resp["body"])

    assert [r["transaction_id"] for r in rows] == ["c1", "c2"]  # newest-first, no 'beans'
    card = breakdown["coffee"]
    assert _clamped_total(rows) == card["posted"] + card["pending"] == Decimal("28")


def test_named_list_shows_refund_and_excluded_but_total_excludes_them(handler, monkeypatch):
    # A named category LISTS refunds + budget-excluded rows (like the tab), but the reconciling
    # total counts only contributors — matching /breakdown.
    _pin_today(monkeypatch)
    txns = [
        _txn("spend", "coffee", -20, "2026-07-10"),
        _txn("refund", "coffee", 5, "2026-07-11"),
        _txn("excluded", "coffee", -8, "2026-07-12", excluded=True),
    ]
    breakdown = handler.list_category_breakdown(
        _FakeCategoryRepo(CATS), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo())
    resp = handler.get_category_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    rows = json.loads(resp["body"])

    assert {r["transaction_id"] for r in rows} == {"spend", "refund", "excluded"}  # all listed
    card = breakdown["coffee"]
    assert _clamped_total(rows) == card["posted"] + card["pending"] == Decimal("15")  # 20 - 5


def test_uncategorized_reconciles_and_excludes_income_mapped_transfer(handler, monkeypatch):
    # The uncategorized bucket matches /breakdown's __uncategorized__: contributing unmapped spend
    # only — income, a mapped category, and a not-in-budget transfer (counts_to_budget=false) are
    # all excluded. FAIL-ON-REVERT: dropping the contributes_to_budget/taxonomy filter leaks them.
    _pin_today(monkeypatch)
    txns = [
        _txn("u1", None, -30, "2026-07-10"),
        _txn("u2", "RAW_ENUM", -8, "2026-07-11"),               # unknown id → uncategorized
        _txn("income", "income", 500, "2026-07-10"),            # income sentinel → excluded
        _txn("mapped", "coffee", -20, "2026-07-10"),            # in taxonomy → excluded
        _txn("transfer", None, -500, "2026-07-10", counts=False),  # not-in-budget → excluded
    ]
    breakdown = handler.list_category_breakdown(
        _FakeCategoryRepo(CATS), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo())
    resp = handler.get_category_transactions(
        _event("__uncategorized__"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    rows = json.loads(resp["body"])

    assert [r["transaction_id"] for r in rows] == ["u2", "u1"]  # newest-first, only unmapped spend
    card = breakdown["__uncategorized__"]
    assert _clamped_total(rows) == card["posted"] + card["pending"] == Decimal("38")


# --- cycle look-back ---------------------------------------------------------


def test_prior_cycle_uses_the_nth_prior_window(handler, monkeypatch):
    # ?cycle=1 windows the PRIOR full cycle (the fix for the always-empty "last cycle" drill).
    # With last_pay_date 2026-07-01 length 30, cycle 0 = [2026-07-01, today]; cycle 1 =
    # [2026-06-01, 2026-06-30]. A charge dated in June shows for cycle=1, not cycle=0.
    _pin_today(monkeypatch)
    txns = [
        _txn("this", "coffee", -10, "2026-07-10"),
        _txn("last", "coffee", -20, "2026-06-15"),
    ]
    current = json.loads(handler.get_category_transactions(
        _event("coffee", cycle="0"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))["body"])
    prior_repo = _DateFilteringTransactionRepo(txns)
    prior = json.loads(handler.get_category_transactions(
        _event("coffee", cycle="1"), prior_repo, _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))["body"])

    assert [r["transaction_id"] for r in current] == ["this"]
    assert [r["transaction_id"] for r in prior] == ["last"]
    assert prior_repo.calls[0][1] == "2026-06-01"  # prior window start
    assert prior_repo.calls[0][2] == "2026-06-30"  # prior window end


def test_empty_prior_cycle_returns_empty_list(handler, monkeypatch):
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _event("coffee", cycle="1"),
        _DateFilteringTransactionRepo([_txn("this", "coffee", -10, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


def test_cycle_out_of_range_returns_400(handler):
    resp = handler.get_category_transactions(
        _event("coffee", cycle="13"), _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 400


# --- shape / edges -----------------------------------------------------------


def test_missing_category_id_returns_404(handler):
    event = {"rawPath": "/categories//transactions",
             "requestContext": {"http": {"method": "GET"}}, "pathParameters": {}}
    resp = handler.get_category_transactions(
        event, _DateFilteringTransactionRepo([]), _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 404


def test_strips_pk_sk(handler, monkeypatch):
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _event("coffee"),
        _DateFilteringTransactionRepo([_txn("c1", "coffee", -5, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    row = json.loads(resp["body"])[0]
    assert "pk" not in row and "sk" not in row


def test_matches_a_weird_id_by_exact_equality(handler, monkeypatch):
    # An id carrying '/' or '__' (a route round-trips it via encodeURIComponent) is matched by
    # exact string equality — the endpoint does NO id parsing. (Moved from the client gaps.)
    _pin_today(monkeypatch)
    weird = "food/sub__direct"
    txns = [
        _txn("w1", weird, -7, "2026-07-10"),
        _txn("other", "food", -7, "2026-07-10"),
    ]
    resp = handler.get_category_transactions(
        _event(weird), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo([{"id": weird, "bucket": "Living", "parent": None},
                           {"id": "food", "bucket": "Living", "parent": None}]))
    assert [r["transaction_id"] for r in json.loads(resp["body"])] == ["w1"]


# --- routing -----------------------------------------------------------------


def test_router_dispatches_category_transactions(handler, monkeypatch):
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: object())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: object())
    monkeypatch.setattr(handler, "get_category_transactions",
                        lambda *a: handler._json_response(200, [{"transaction_id": "sentinel"}]))
    monkeypatch.setattr(handler, "update_category",
                        lambda *a: pytest.fail("PATCH handler reached from a GET transactions path"))

    resp = handler.lambda_handler(_event("coffee"), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])[0]["transaction_id"] == "sentinel"


def test_router_patch_category_not_captured_by_transactions_route(handler, monkeypatch):
    monkeypatch.setattr(handler, "CategoryRepository", lambda: object())
    monkeypatch.setattr(handler, "BudgetRepository", lambda: object())
    monkeypatch.setattr(handler, "get_category_transactions",
                        lambda *a: pytest.fail("PATCH reached the GET transactions handler"))
    monkeypatch.setattr(handler, "update_category",
                        lambda *a: handler._json_response(200, {"id": "coffee"}))

    resp = handler.lambda_handler(
        {"rawPath": "/categories/coffee", "requestContext": {"http": {"method": "PATCH"}},
         "pathParameters": {"id": "coffee"}, "body": "{}"}, None)

    assert resp["statusCode"] == 200
