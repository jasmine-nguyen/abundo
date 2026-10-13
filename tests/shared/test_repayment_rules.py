"""Tests for the shared home-loan repayment-leg rule (shared/repayment_rules.py).

WHIT-325 lifted this predicate out of two drifting copies (the balance poller's
miss-detector and the read API's get_repayment). These lock its contract: identify
an incoming-transfer credit with a positive numeric amount and a date, apply NO $10
alert floor (so the read API keeps returning sub-$10 repayments), and skip a
malformed row rather than raising.
"""

from decimal import Decimal

import pytest

# Mirrors constants.REPAYMENT_INCOMING_TYPE (the Up transfer-in type).
INCOMING = "TRANSFER_INCOMING"
_MISSING = object()


def _row(**overrides):
    row = {"type": INCOMING, "amount": Decimal("3667.50"), "date": "2026-07-01"}
    row.update(overrides)
    return {key: value for key, value in row.items() if value is not _MISSING}


@pytest.mark.parametrize("row, expected", [
    pytest.param(_row(), True, id="valid"),
    pytest.param(_row(type="TRANSFER_OUTGOING"), False, id="wrong-type"),
    pytest.param(_row(type=_MISSING), False, id="missing-type"),
    pytest.param(_row(date=""), False, id="empty-date"),
    pytest.param(_row(date=None), False, id="none-date"),
    pytest.param(_row(amount=None), False, id="none-amount"),
    pytest.param(_row(amount=Decimal("0")), False, id="zero"),
    pytest.param(_row(amount=Decimal("-5")), False, id="negative"),
    pytest.param(_row(amount="3667.50"), False, id="string-amount-skipped-not-raised"),
    pytest.param(_row(amount=100), True, id="int"),
    pytest.param(_row(amount=100.5), True, id="float"),
    # NO $10 alert floor here — that lives at the poller's call site, so the read API keeps small repayments.
    pytest.param(_row(amount=Decimal("5")), True, id="sub-ten-dollars"),
    pytest.param(_row(amount=float("inf")), False, id="inf"),
    pytest.param(_row(amount=Decimal("Infinity")), False, id="decimal-infinity"),
    # A stored Decimal('NaN') used to reach `amount > 0` and raise InvalidOperation (a 500).
    pytest.param(_row(amount=Decimal("NaN")), False, id="decimal-nan-no-raise"),
])
def test_is_repayment_credit(shared, row, expected):
    assert shared.repayment_rules.is_repayment_credit(row) is expected


@pytest.mark.parametrize("value, expected", [
    # is_number is a TYPE check, not a sign check: get_repayment layers its own `< 0` (interest)
    # and is_repayment_credit its own `> 0` on top.
    (0, True),
    (Decimal("0"), True),
    (-232, True),
    (Decimal("-232"), True),
    # non-finite would raise or mis-sort on the call sites' comparisons
    (float("nan"), False),
    (float("inf"), False),
    (float("-inf"), False),
    (Decimal("NaN"), False),
    (Decimal("Infinity"), False),
    (Decimal("sNaN"), False),   # signalling NaN: is_finite() screens it without raising
])
def test_is_number(shared, value, expected):
    assert shared.repayment_rules.is_number(value) is expected
