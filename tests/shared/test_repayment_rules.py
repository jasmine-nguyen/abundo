"""Tests for the shared home-loan repayment-leg rule (shared/repayment_rules.py).

WHIT-325 lifted this predicate out of two drifting copies (the balance poller's
miss-detector and the read API's get_repayment). These lock its contract: identify
an incoming-transfer credit with a positive numeric amount and a date, apply NO $10
alert floor (so the read API keeps returning sub-$10 repayments), and skip a
malformed row rather than raising.
"""

from decimal import Decimal

# Mirrors constants.REPAYMENT_INCOMING_TYPE (the Up transfer-in type).
INCOMING = "TRANSFER_INCOMING"


def _row(**overrides):
    row = {"type": INCOMING, "amount": Decimal("3667.50"), "date": "2026-07-01"}
    row.update(overrides)
    return row


def test_incoming_positive_dated_credit_is_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row()) is True


def test_wrong_type_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(type="TRANSFER_OUTGOING")) is False


def test_missing_type_is_not_a_repayment(shared):
    row = _row()
    del row["type"]
    assert shared.repayment_rules.is_repayment_credit(row) is False


def test_empty_date_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(date="")) is False


def test_none_date_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(date=None)) is False


def test_none_amount_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(amount=None)) is False


def test_zero_amount_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(amount=Decimal("0"))) is False


def test_negative_amount_is_not_a_repayment(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(amount=Decimal("-5"))) is False


def test_non_numeric_amount_is_skipped_not_raised(shared):
    # A stringified amount must be skipped, never crash the caller's scan.
    assert shared.repayment_rules.is_repayment_credit(_row(amount="3667.50")) is False


def test_int_and_float_amounts_are_accepted(shared):
    assert shared.repayment_rules.is_repayment_credit(_row(amount=100)) is True
    assert shared.repayment_rules.is_repayment_credit(_row(amount=100.5)) is True


def test_sub_ten_dollar_credit_is_still_a_repayment(shared):
    # The rule carries NO $10 alert floor — that lives at the poller's call site.
    # This is the single source of truth that keeps the read API showing small repayments.
    assert shared.repayment_rules.is_repayment_credit(_row(amount=Decimal("5"))) is True
