"""WHIT-700 — GET /transactions/cycle?cycle=N: every transaction in one pay cycle, for the
Insights CSV export. Driven through lambda_handler routing (event in → JSON out).

Pay cycle fixture: last_pay_date 2026-07-01, length 30, today 2026-07-25 →
cycle 0 = [2026-07-01, 2026-07-25], cycle 1 = [2026-06-01, 2026-06-30].
"""

import json
from datetime import date
from decimal import Decimal

from _api_event import api_event
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _transaction_range_fakes import _AccountTransactionRepo, _DateFilteringTransactionRepo


class _NoBudgetsRepo:
    def list_budgets(self):
        return {}


def _txn(txn_id, date_, amount, category="coffee", status="posted", counts=True, excluded=False):
    row = {
        "transaction_id": txn_id,
        "date": date_,
        "amount": Decimal(str(amount)),
        "category": category,
        "status": status,
        "counts_to_budget": counts,
        "merchant_name": "Shop",
        "description": "SHOP",
        "account_name": "Everyday",
        "pk": "ACCOUNT#up-spending",
        "sk": f"TXN#{txn_id}",
    }
    if excluded:
        row["budget_excluded"] = True
    return row


TXNS = [
    _txn("before-last", "2026-05-31", -1),                       # one day before cycle 1
    _txn("last-start", "2026-06-01", -10),                       # cycle 1 first day
    _txn("last-end", "2026-06-30", -20),                         # cycle 1 last day
    _txn("this-start", "2026-07-01", -5),                        # cycle 0 first day
    _txn("income", "2026-07-03", 2500, category="income"),
    _txn("transfer", "2026-07-05", -500, category=None, counts=False),
    _txn("excluded", "2026-07-08", -40, excluded=True),
    _txn("pending", "2026-07-20", -7.5, status="pending"),
    _txn("today", "2026-07-25", -3),                             # cycle 0 last day (today)
    _txn("future", "2026-07-26", -99),                           # after today → outside
]


def _event(cycle=None):
    query = {"cycle": cycle} if cycle is not None else None
    return api_event("GET", "/transactions/cycle", query=query)


def _call(handler, monkeypatch, event, repo=None):
    repo = repo or _DateFilteringTransactionRepo(TXNS)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: _FakePayCycleRepo())
    monkeypatch.setattr(handler, "BudgetRepository", lambda: _NoBudgetsRepo())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _FakeCategoryRepo())
    return handler.lambda_handler(event, None)


def test_user_can_fetch_every_transaction_in_this_and_last_cycle(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2026, 7, 25))

    current = _call(handler, monkeypatch, _event())
    assert current["statusCode"] == 200
    body = json.loads(current["body"])
    assert body["start"] == "2026-07-01"
    assert body["end"] == "2026-07-25"
    rows = body["transactions"]
    # Every row type in the window (income, transfer, budget-excluded, pending), both edge
    # dates included, newest first; nothing outside the window.
    assert [r["transaction_id"] for r in rows] == [
        "today", "pending", "excluded", "transfer", "income", "this-start"]
    assert all("pk" not in r and "sk" not in r for r in rows)
    effective = {r["transaction_id"]: r["counts_to_budget_effective"] for r in rows}
    assert effective == {
        "today": True, "pending": True, "excluded": False,
        "transfer": False, "income": True, "this-start": True,
    }
    for r in rows:
        assert r["counts_to_budget_effective"] == spend.contributes_to_budget(r)

    last = json.loads(_call(handler, monkeypatch, _event("1"))["body"])
    assert last["start"] == "2026-06-01"
    assert last["end"] == "2026-06-30"
    assert [r["transaction_id"] for r in last["transactions"]] == ["last-end", "last-start"]

    assert _call(handler, monkeypatch, _event("12"))["statusCode"] == 200   # the max look-back
    for bad in ("abc", "-1", "13"):
        assert _call(handler, monkeypatch, _event(bad))["statusCode"] == 400


def _on_account(account, txn_id, date_):
    return {**_txn(txn_id, date_, -1), "account_id": account, "pk": f"ACCOUNT#{account}"}


BY_ACCOUNT = {
    "up-spending": [
        _on_account("up-spending", "spend-a", "2026-07-02"),
        _on_account("up-spending", "spend-b", "2026-07-15"),
        _on_account("up-spending", "spend-c", "2026-07-16"),
    ],
    "anz-rewards-black-visa": [_on_account("anz-rewards-black-visa", "card-b", "2026-07-10")],
    "up-homeloan": [_on_account("up-homeloan", "loan-interest", "2026-07-05")],
    "westpac-altitude-qantas-black": [_on_account("westpac-altitude-qantas-black", "westpac-c", "2026-07-20")],
}


def test_rows_from_every_account_merge_newest_first(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2026, 7, 25))
    repo = _AccountTransactionRepo([t for rows in BY_ACCOUNT.values() for t in rows])

    response = _call(handler, monkeypatch, _event(), repo)

    assert response["statusCode"] == 200
    ids = [r["transaction_id"] for r in json.loads(response["body"])["transactions"]]
    assert ids == ["westpac-c", "spend-c", "spend-b", "card-b", "loan-interest", "spend-a"]
    assert {c[0] for c in repo.calls} == set(BY_ACCOUNT)
