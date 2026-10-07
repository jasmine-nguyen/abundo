"""WHIT-792: GET /homeloan reads the one saved account-balance copy (ACCTBAL#up-homeloan).

The stored amount is signed (a mortgage is negative); the Goal screen gets the positive amount
still owed, in the same {balance, as_of, currency} shape, or the null sentinel before the first
poll. The real AccountBalanceRepository runs over a FakeTable.
"""

import json
from decimal import Decimal

import pytest

from _balance_fakes import balance_repo, homeloan_row

_HOMELOAN_ROW = homeloan_row("-596642.43", as_of="2026-10-06T00:24:37.614Z")
_SPENDING_ROW = {"account_id": "up-spending", "amount": Decimal("96270.59"), "available_balance": Decimal("96270.59"),
                 "currency": "AUD", "as_of": "2026-10-06T00:24:37.614Z", "account_type": "checking"}


@pytest.mark.parametrize(
    ("rows", "expected_body"),
    [
        ([_SPENDING_ROW, _HOMELOAN_ROW],
         {"balance": 596642.43, "as_of": "2026-10-06T00:24:37.614Z", "currency": "AUD"}),
        ([_SPENDING_ROW], {"balance": None, "as_of": None, "currency": None}),
    ],
    ids=["owed-amount-from-signed-row", "null-sentinel-before-first-poll"],
)
def test_homeloan_route_serves_the_owed_amount_from_the_account_balance_row(handler, monkeypatch, rows, expected_body):
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: balance_repo(rows=rows))

    resp = handler.lambda_handler({"rawPath": "/homeloan", "requestContext": {"http": {"method": "GET"}}}, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == expected_body
