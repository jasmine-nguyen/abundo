"""Tests for the home-loan balance read endpoint (GET /homeloan) and its handler
`get_homeloan` (WHIT-8).

Handler-level tests inject a FakeHomeLoanRepo directly. The route test drives
`lambda_handler` with the repo class monkeypatched, proving the dispatch wiring
and the DecimalEncoder JSON shaping (Decimal balance -> JSON number).
"""

import json
from decimal import Decimal


class FakeHomeLoanRepo:
    """Handler-level stand-in for HomeLoanBalanceRepository."""

    def __init__(self, row=None):
        self._row = row
        self.get_calls = []

    def get_balance(self, account_id):
        self.get_calls.append(account_id)
        return self._row


# --- get_homeloan (unit) -----------------------------------------------------


def test_get_homeloan_returns_stored_balance(handler):
    repo = FakeHomeLoanRepo(
        {"balance": Decimal("596642.43"), "as_of": "2026-07-04T00:24:37.614Z", "currency": "AUD"}
    )
    out = handler.get_homeloan(repo)
    assert out == {
        "balance": Decimal("596642.43"),
        "as_of": "2026-07-04T00:24:37.614Z",
        "currency": "AUD",
    }
    # Reads the mortgage's internal id, not a raw BankSync id.
    assert repo.get_calls == ["up-homeloan"]


def test_get_homeloan_returns_null_sentinel_before_first_poll(handler):
    # No row yet -> a 200-friendly null shape, so the client keeps its placeholder.
    out = handler.get_homeloan(FakeHomeLoanRepo(None))
    assert out == {"balance": None, "as_of": None, "currency": None}


# --- GET /homeloan (route) ---------------------------------------------------


def test_route_get_homeloan_serves_balance_as_json_number(handler, monkeypatch):
    repo = FakeHomeLoanRepo(
        {"balance": Decimal("596642.43"), "as_of": "2026-07-04T00:24:37.614Z", "currency": "AUD"}
    )
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: repo)

    event = {"rawPath": "/homeloan", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    # DecimalEncoder renders the Decimal balance as a JSON number.
    assert body == {"balance": 596642.43, "as_of": "2026-07-04T00:24:37.614Z", "currency": "AUD"}


def test_route_get_homeloan_null_sentinel(handler, monkeypatch):
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: FakeHomeLoanRepo(None))

    event = {"rawPath": "/homeloan", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"balance": None, "as_of": None, "currency": None}
