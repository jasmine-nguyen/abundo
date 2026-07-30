"""WHIT-378 — adversarial GAP: the handler must forward depositTarget to the repo as a
Decimal, not a float.

The existing test_loanfacts.py only asserts `set_calls[0]["depositTarget"] == 120000`,
which a bare float 120000.0 ALSO satisfies (Decimal == float == int all compare equal).
But the real LoanFactsRepository.put_item writes to DynamoDB, which REJECTS float and
requires Decimal — so a regression that dropped the `Decimal(str(...))` wrapper in
handler.py:2029 would pass the existing suite yet 500 in production. These lock the type
(and that a fractional value survives the str() round-trip exactly).
"""

import json
from decimal import Decimal

VALID = {"original": 600000, "homeValue": 770000, "lvr": 0.8, "ratePct": 5.74, "baseRepay": 1240, "extra": 200}


class FakeLoanFactsRepo:
    def __init__(self):
        self.set_calls = []

    def get_loanfacts(self):
        return None

    def set_loanfacts(self, payoffGoalDate=None, depositTarget=None, **kwargs):
        # Store the RAW object handed over so the test can inspect its runtime type.
        self.set_calls.append({**kwargs, "payoffGoalDate": payoffGoalDate, "depositTarget": depositTarget})
        return {
            **{k: float(v) for k, v in kwargs.items()},
            "payoffGoalDate": payoffGoalDate,
            "depositTarget": float(depositTarget) if depositTarget is not None else None,
        }


def _put_event(body):
    return {
        "rawPath": "/loanfacts",
        "requestContext": {"http": {"method": "PUT"}},
        "body": json.dumps(body),
        "isBase64Encoded": False,
    }


def test_handler_forwards_deposit_target_as_decimal_not_float(handler):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, "depositTarget": 120000}), repo)
    assert resp["statusCode"] == 200
    forwarded = repo.set_calls[0]["depositTarget"]
    # The load-bearing assertion the existing == check misses: DynamoDB needs Decimal.
    assert isinstance(forwarded, Decimal)
    assert forwarded == Decimal("120000")


def test_handler_preserves_a_fractional_deposit_target_exactly(handler):
    repo = FakeLoanFactsRepo()
    handler.set_loanfacts(_put_event({**VALID, "depositTarget": 120000.5}), repo)
    forwarded = repo.set_calls[0]["depositTarget"]
    assert isinstance(forwarded, Decimal)
    # Decimal(str(120000.5)) is exact — no binary-float drift like Decimal(120000.5) has.
    assert forwarded == Decimal("120000.5")
