"""Tests for the per-account balances read endpoint (GET /accounts/balances) and
its handler `get_account_balances` (WHIT-212).

Handler-level tests inject a FakeAccountBalanceRepo directly. The route test drives
`lambda_handler` with the repo class monkeypatched, proving the dispatch wiring and
the DecimalEncoder JSON shaping (signed Decimal amounts -> JSON numbers, null kept).
"""

import json
from decimal import Decimal


class FakeAccountBalanceRepo:
    """Handler-level stand-in for AccountBalanceRepository."""

    def __init__(self, rows=None):
        self._rows = rows or []
        self.list_calls = []

    def list_balances(self, account_ids):
        self.list_calls.append(list(account_ids))
        return self._rows


# --- get_account_balances (unit) ---------------------------------------------


def test_get_account_balances_asks_for_the_known_internal_ids(handler):
    repo = FakeAccountBalanceRepo()
    handler.get_account_balances(repo)
    # Queries the app's known accounts (ACCOUNT_ID_MAP's internal ids), sorted + deduped.
    assert repo.list_calls == [["anz-rewards-black-visa", "up-homeloan", "up-spending"]]


def test_get_account_balances_returns_the_stored_rows(handler):
    rows = [
        {"account_id": "up-spending", "amount": Decimal("96270.59"),
         "available_balance": Decimal("96270.59"), "currency": "AUD",
         "as_of": "2026-07-08T09:32:02.405Z", "account_type": "checking"},
    ]
    assert handler.get_account_balances(FakeAccountBalanceRepo(rows)) == rows


def test_get_account_balances_is_empty_before_any_poll(handler):
    assert handler.get_account_balances(FakeAccountBalanceRepo([])) == []


# --- GET /accounts/balances (route) ------------------------------------------


def test_route_serves_signed_balances_as_json_numbers(handler, monkeypatch):
    rows = [
        {"account_id": "up-homeloan", "amount": Decimal("-596642.43"),
         "available_balance": Decimal("0"), "currency": "AUD",
         "as_of": "2026-07-08T09:29:49.358Z", "account_type": "mortgage"},
        {"account_id": "anz-rewards-black-visa", "amount": Decimal("-6492.26"),
         "available_balance": Decimal("8171.88"), "currency": "AUD",
         "as_of": "2026-07-08T09:32:37.337Z", "account_type": "unknown"},
    ]
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: FakeAccountBalanceRepo(rows))

    event = {"rawPath": "/accounts/balances", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    # DecimalEncoder renders the signed amounts (and available_balance) as JSON numbers.
    assert body == [
        {"account_id": "up-homeloan", "amount": -596642.43, "available_balance": 0.0,
         "currency": "AUD", "as_of": "2026-07-08T09:29:49.358Z", "account_type": "mortgage"},
        {"account_id": "anz-rewards-black-visa", "amount": -6492.26, "available_balance": 8171.88,
         "currency": "AUD", "as_of": "2026-07-08T09:32:37.337Z", "account_type": "unknown"},
    ]


def test_route_empty_list_before_any_poll(handler, monkeypatch):
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: FakeAccountBalanceRepo([]))
    event = {"rawPath": "/accounts/balances", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []
