"""WHIT-700 QA — adversarial edges of GET /transactions/cycle (the Insights CSV export).

Pay cycle fixture: last_pay_date 2026-07-01, length 30, today 2026-07-25 →
cycle 0 = [2026-07-01, 2026-07-25], cycle 1 = [2026-06-01, 2026-06-30].
"""

import json
from datetime import date
from decimal import Decimal

import pytest

from _budget_endpoint_fakes import _FakePayCycleRepo


class _PerAccountRepo:
    """Serves each account its own rows (filtered to the inclusive date range), so the
    route must merge every account read_window walks, not just the first."""

    def __init__(self, by_account):
        self._by_account = by_account
        self.accounts_read = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.accounts_read.append(account_id)
        rows = self._by_account.get(account_id, [])
        return [dict(t) for t in rows if start_date <= t["date"] <= end_date], None


class _NoBudgetsRepo:
    def list_budgets(self):
        return {}


class _NoCategoriesRepo:
    def list_categories(self):
        return []


def _txn(txn_id, date_, amount, account, **extra):
    row = {
        "transaction_id": txn_id,
        "date": date_,
        "amount": Decimal(str(amount)),
        "category": "coffee",
        "status": "posted",
        "counts_to_budget": True,
        "account_id": account,
        "pk": f"ACCOUNT#{account}",
        "sk": f"TXN#{txn_id}",
    }
    row.update(extra)
    return row


BY_ACCOUNT = {
    "up-spending": [
        _txn("spend-a", "2026-07-02", -12.5, "up-spending"),
        _txn("unknown-status", "2026-07-15", -9, "up-spending", status="reversed"),
        _txn("no-flag", "2026-07-16", -4, "up-spending", counts_to_budget=None),
    ],
    "anz-rewards-black-visa": [
        _txn("card-b", "2026-07-10", -30, "anz-rewards-black-visa"),
    ],
    "up-homeloan": [
        _txn("loan-interest", "2026-07-05", -800, "up-homeloan", counts_to_budget=False),
    ],
    "westpac-altitude-qantas-black": [
        _txn("westpac-c", "2026-07-20", -1.1, "westpac-altitude-qantas-black"),
    ],
}


@pytest.fixture
def today(monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2026, 7, 25))


def _event(params=None, method="GET", path="/transactions/cycle"):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if params is not None:
        event["queryStringParameters"] = params
    return event


def _call(handler, monkeypatch, event, repo=None):
    repo = repo or _PerAccountRepo(BY_ACCOUNT)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: _FakePayCycleRepo())
    monkeypatch.setattr(handler, "BudgetRepository", lambda: _NoBudgetsRepo())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _NoCategoriesRepo())
    return handler.lambda_handler(event, None)


# [A1] rows from EVERY account are merged and sorted newest first across accounts.
def test_rows_from_every_account_merge_newest_first(handler, monkeypatch, today):
    repo = _PerAccountRepo(BY_ACCOUNT)
    response = _call(handler, monkeypatch, _event(), repo)
    assert response["statusCode"] == 200
    ids = [r["transaction_id"] for r in json.loads(response["body"])["transactions"]]
    assert ids == ["westpac-c", "no-flag", "unknown-status", "card-b", "loan-interest", "spend-a"]
    assert set(repo.accounts_read) == set(BY_ACCOUNT)


# [A2] the yes/no flag follows contributes_to_budget for the awkward rows: unknown status,
# missing/None counts flag, home-loan (counts_to_budget False).
def test_counts_flag_is_false_for_unknown_status_and_missing_flag(handler, monkeypatch, today):
    import spend
    body = json.loads(_call(handler, monkeypatch, _event())["body"])
    effective = {r["transaction_id"]: r["counts_to_budget_effective"] for r in body["transactions"]}
    assert effective["unknown-status"] is False
    assert effective["no-flag"] is False
    assert effective["loan-interest"] is False
    assert effective["spend-a"] is True
    for row in body["transactions"]:
        assert row["counts_to_budget_effective"] is spend.contributes_to_budget(row)


# [A3] amounts reach the app as JSON NUMBERS with their sign (the client calls toFixed on them).
def test_amounts_are_signed_json_numbers(handler, monkeypatch, today):
    body = json.loads(_call(handler, monkeypatch, _event())["body"])
    amounts = {r["transaction_id"]: r["amount"] for r in body["transactions"]}
    assert amounts["spend-a"] == -12.5
    assert isinstance(amounts["spend-a"], float)
    assert amounts["westpac-c"] == -1.1


# [A4] an empty ?cycle= means this cycle, the max look-back (12) is allowed, and the
# boundaries either side are rejected.
@pytest.mark.parametrize("params, expected_start", [
    ({"cycle": ""}, "2026-07-01"),
    ({}, "2026-07-01"),
    ({"cycle": "0"}, "2026-07-01"),
    ({"cycle": "12"}, "2025-07-06"),
])
def test_valid_cycle_values(handler, monkeypatch, today, params, expected_start):
    import handler as handler_module
    response = _call(handler, monkeypatch, _event(params))
    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    start, end = handler_module._cycle_window_for_lookback(_FakePayCycleRepo(), int(params.get("cycle") or 0))
    assert (body["start"], body["end"]) == (start, end)
    assert body["start"] == expected_start


@pytest.mark.parametrize("bad", ["1.5", " ", "1e1", "99999999999999999999"])
def test_bad_cycle_values_are_rejected(handler, monkeypatch, today, bad):
    response = _call(handler, monkeypatch, _event({"cycle": bad}))
    assert response["statusCode"] == 400
    assert "error" in json.loads(response["body"])


# WHIT-703: with no budgets set, `budgets` is {} and the categories are never read.
@pytest.mark.parametrize("cycle", [None, {"cycle": "1"}])
def test_no_budgets_skips_the_category_read(handler, monkeypatch, today, cycle):
    class _UnreadCategoryRepo:
        def list_categories(self):
            raise AssertionError("categories read with no budgets")

    _call(handler, monkeypatch, _event())
    monkeypatch.setattr(handler, "CategoryRepository", _UnreadCategoryRepo)
    response = handler.lambda_handler(_event(cycle), None)
    assert response["statusCode"] == 200
    assert json.loads(response["body"])["budgets"] == {}


# [A5] an empty window returns 200 with an empty list, still carrying the dates.
def test_empty_cycle_returns_dates_and_no_rows(handler, monkeypatch, today):
    response = _call(handler, monkeypatch, _event(), _PerAccountRepo({}))
    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == {"start": "2026-07-01", "end": "2026-07-25", "transactions": [], "budgets": {}}


# [A6] the route is GET-only and exact-path.
def test_non_get_and_sub_paths_do_not_hit_the_export(handler, monkeypatch, today):
    called = []
    monkeypatch.setattr(handler, "get_cycle_transactions", lambda *a, **k: called.append(a) or {"statusCode": 200})
    _call(handler, monkeypatch, _event(method="POST"))
    _call(handler, monkeypatch, _event(path="/transactions/cycle/extra"))
    assert called == []
    _call(handler, monkeypatch, _event())
    assert len(called) == 1


# [A7] regression: the helper split left the drill-in response shape untouched (a bare array).
def test_windowed_rows_response_still_wraps_a_bare_array(handler):
    rows = [
        {"transaction_id": "a", "date": "2026-07-01", "pk": "p", "sk": "s"},
        {"transaction_id": "b", "date": "2026-07-03", "pk": "p", "sk": "s"},
    ]
    response = handler._windowed_rows_response(rows, lambda t: True)
    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == [
        {"transaction_id": "b", "date": "2026-07-03"},
        {"transaction_id": "a", "date": "2026-07-01"},
    ]
