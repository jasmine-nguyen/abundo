"""Tests for GET /breakdown (list_category_breakdown) — spend by category for the
current pay cycle, plus the Uncategorized bucket (WHIT-23).

Reuses the direct-call pattern from test_budgets.py: the handler is provided by the
`handler` fixture (conftest.py), and list_category_breakdown takes its three repos
as params, so tests call it directly with fakes — no patching, no AWS.
"""

from datetime import date
from decimal import Decimal

import pytest


class FakeCategoryRepo:
    """Stand-in for CategoryRepository — serves a fixed taxonomy."""

    def __init__(self, categories=None):
        self._categories = categories or []
        self.list_calls = 0

    def list_categories(self):
        self.list_calls += 1
        return [dict(c) for c in self._categories]


class FakeTransactionRepo:
    """Serves a single page of `transactions` per account then empties, so the
    per-account loop in _fetch_windowed_transactions sums each txn once."""

    def __init__(self, transactions=None):
        self._queue = [(list(transactions or []), None)]
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        return self._queue.pop(0) if self._queue else ([], None)


class _DateFilteringTransactionRepo:
    """Honours the date bounds the way DynamoDB `between` does — inclusive on both
    ends over YYYY-MM-DD strings — so a window test can prove which dates are pulled
    in. Serves the pool once total (then empties)."""

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


class FakePayCycleRepo:
    def __init__(self, length=14, last_pay_date="2024-01-03"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


def _category(cat_id, bucket, name=None):
    return {"id": cat_id, "name": name or cat_id.title(), "icon": "tag",
            "color": "#123456", "bucket": bucket}


def _transaction(category, amount, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": counts}


# --- happy path --------------------------------------------------------------


def test_breakdown_splits_posted_and_pending_per_category(handler):
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle"), _category("groceries", "Living")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -50, "posted"),
        _transaction("coffee", -12, "pending"),
        _transaction("groceries", -30, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {
        "coffee": {"posted": Decimal("50"), "pending": Decimal("12")},
        "groceries": {"posted": Decimal("30"), "pending": Decimal("0")},
    }


def test_breakdown_no_uncategorized_key_when_clean(handler):
    # Every spend txn maps to a spend-bucket category -> no __uncategorized__ row.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([_transaction("coffee", -10, "posted")])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"coffee": {"posted": Decimal("10"), "pending": Decimal("0")}}
    assert "__uncategorized__" not in result


# --- Uncategorized bucket (the core gap this card closes) --------------------


def test_breakdown_raw_bank_enum_folds_into_uncategorized(handler):
    # An un-ruled txn keeps its raw uppercase BankSync category (not a slug, not in
    # the taxonomy). It counts to budget, so it must land in __uncategorized__, not
    # be silently dropped.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -50, "posted"),
        _transaction("MEDICAL", -20, "posted"),
        _transaction("ENTERTAINMENT", -5, "pending"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["coffee"] == {"posted": Decimal("50"), "pending": Decimal("0")}
    assert result["__uncategorized__"] == {"posted": Decimal("20"), "pending": Decimal("5")}


def test_breakdown_null_category_folds_into_uncategorized(handler):
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -10, "posted"),
        _transaction(None, -15, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__uncategorized__"] == {"posted": Decimal("15"), "pending": Decimal("0")}


def test_breakdown_deleted_category_spend_folds_into_uncategorized(handler):
    # A txn points at an id no longer in the taxonomy (category was deleted). Its
    # spend folds into Uncategorized rather than vanishing.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -10, "posted"),
        _transaction("oldcat", -25, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "oldcat" not in result
    assert result["__uncategorized__"] == {"posted": Decimal("25"), "pending": Decimal("0")}


# --- Income/Savings exclusion (spend view) -----------------------------------


def test_breakdown_excludes_income_and_savings_buckets(handler):
    # A user category in an Income/Savings bucket is in the taxonomy, so it is
    # NEITHER a spend row NOR folded into Uncategorized. The literal "income"
    # sentinel is excluded too. No $0 phantom rows.
    cats = FakeCategoryRepo([
        _category("coffee", "Lifestyle"),
        _category("salary", "Income"),
        _category("mortgage", "Savings"),
    ])
    txns = FakeTransactionRepo([
        _transaction("coffee", -40, "posted"),
        _transaction("salary", -100, "posted"),    # Income bucket -> excluded
        _transaction("mortgage", -200, "posted"),  # Savings bucket -> excluded
        _transaction("income", -100, "posted"),    # income sentinel -> excluded
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"coffee": {"posted": Decimal("40"), "pending": Decimal("0")}}


# --- refund clamping ---------------------------------------------------------


def test_breakdown_net_refund_spend_category_clamps_to_zero(handler):
    # Refunds exceed charges -> the per-category bucket clamps at 0 (never negative).
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -30, "posted"),
        _transaction("coffee", 50, "posted"),  # refund (positive amount)
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["coffee"] == {"posted": Decimal("0"), "pending": Decimal("0")}


def test_breakdown_net_refund_uncategorized_is_omitted(handler):
    # A net-refund Uncategorized bucket clamps to 0 -> no __uncategorized__ key.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -10, "posted"),
        _transaction("MEDICAL", -30, "posted"),
        _transaction("MEDICAL", 50, "posted"),  # refund > charge
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "__uncategorized__" not in result


# --- window ------------------------------------------------------------------


def test_breakdown_applies_current_cycle_window(handler, monkeypatch):
    # The window is the current pay cycle (Melbourne clock), inclusive [start, today].
    # A tomorrow-dated txn is excluded; older-than-7-days but in-cycle spend is IN
    # (guards the FEED_WINDOW_DAYS trap that made a client-side derivation wrong).
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-03"},  # cycle_start -> IN (13 days ago)
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-16"},  # today       -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-17"},  # tomorrow    -> OUT
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"coffee": {"posted": Decimal("20"), "pending": Decimal("0")}}
    assert txns.calls[0][2] == "2024-01-16"  # queried end bound is today, not today+1


def test_breakdown_empty_when_no_spend(handler):
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])

    result = handler.list_category_breakdown(cats, FakeTransactionRepo([]), FakePayCycleRepo())

    assert result == {}


# --- dispatch (through lambda_handler) ---------------------------------------


def test_get_breakdown_dispatches_and_runs_real_body(handler, monkeypatch):
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([_transaction("coffee", -42, "posted")])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = {"rawPath": "/breakdown", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    import json
    assert json.loads(resp["body"]) == {"coffee": {"posted": 42, "pending": 0}}


# --- adversarial gaps (qa) ---------------------------------------------------


def test_breakdown_ignores_non_budget_counting_spend(handler):
    # A transfer/excluded charge (counts_to_budget=False) must not appear as a
    # category row NOR fold into Uncategorized — whether its category is a real
    # spend id or a raw enum. Guards the counts_to_budget gate in BOTH summarisers.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -10, "posted"),                 # in
        _transaction("coffee", -99, "posted", counts=False),   # excluded spend cat
        _transaction("MEDICAL", -77, "posted", counts=False),  # excluded raw enum
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"coffee": {"posted": Decimal("10"), "pending": Decimal("0")}}
    assert "__uncategorized__" not in result


def test_breakdown_uncategorized_ignores_unknown_status(handler):
    # summarise_uncategorized only buckets known posted/pending statuses; an
    # unexpected status (e.g. "cancelled") must not be silently counted as posted.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("MEDICAL", -20, "posted"),
        _transaction("MEDICAL", -50, "cancelled"),   # unknown status -> dropped
        _transaction("MEDICAL", -5, "pending"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__uncategorized__"] == {"posted": Decimal("20"), "pending": Decimal("5")}


def test_breakdown_only_uncategorized_bucket(handler):
    # Taxonomy exists but nothing landed in a spend category this cycle — the whole
    # response is just the Uncategorized bucket, no phantom spend-category keys.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction(None, -12, "posted"),
        _transaction("MEDICAL", -8, "pending"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"__uncategorized__": {"posted": Decimal("12"), "pending": Decimal("8")}}


def test_breakdown_fractional_amounts_survive_decimal_encoder(handler, monkeypatch):
    # Through lambda_handler -> _json_response -> DecimalEncoder(float). Sub-dollar
    # amounts must serialise as JSON numbers with their cents intact, not be dropped
    # or stringified. (Binary-exact values chosen so the assert is deterministic.)
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -12.50, "posted"),
        _transaction("coffee", -0.25, "posted"),
        _transaction("coffee", -0.50, "pending"),
    ])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = {"rawPath": "/breakdown", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    import json
    body = json.loads(resp["body"])
    assert body == {"coffee": {"posted": 12.75, "pending": 0.5}}
    assert isinstance(body["coffee"]["posted"], float)  # number, not "12.75"
