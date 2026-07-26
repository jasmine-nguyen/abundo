"""WHIT-327 (PART B) — adversarial NON-FINITE gaps for get_repayment (read API).

The implementer covered quiet Decimal('NaN') (test_decimal_nan_*). These add the
SIGNALLING NaN (sNaN) variant end-to-end through the card: sNaN raises
InvalidOperation on comparison even more readily than quiet NaN, so proving the card
survives an sNaN leg locks that the shared is_number guard (via .is_finite()) screens
BOTH NaN kinds, not just the one the implementer happened to construct.
"""

from decimal import Decimal


class FakeTransactionRepo:
    """Returns the given rows (newest-first), like the real repo's page."""

    def __init__(self, rows):
        self._rows = rows

    def get_transactions_by_date_range(self, account_id, start, end, limit):
        return list(self._rows), None


def _repayment(date, amount="1440"):
    return {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN",
            "amount": Decimal(amount), "date": date}


def test_signalling_nan_repayment_amount_is_skipped_not_fatal(handler):
    # [A_SNAN_REPAY] (P0) A stored Decimal('sNaN') repayment amount would raise
    # InvalidOperation at is_repayment_credit's `amount > 0` and 500 the card. is_number
    # rejects it, so the scan skips it and falls through to the next valid repayment.
    # [fail-on-revert] reverting the finiteness branches makes this raise → 500.
    snan_repayment = {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN",
                      "amount": Decimal("sNaN"), "date": "2026-07-02"}
    out = handler.get_repayment(FakeTransactionRepo([snan_repayment, _repayment("2026-07-01")]))
    assert out["amount"] == Decimal("1440")   # fell through to the valid repayment


def test_signalling_nan_interest_amount_is_skipped_not_fatal(handler):
    # [A_SNAN_INT] (P1) A Decimal('sNaN') interest leg would raise on `amount_leg < 0`
    # in the interest loop. is_number screens it → the leg is skipped → total-only, no crash.
    snan_interest = {"category": "BANK_FEES", "amount": Decimal("sNaN"), "date": "2026-07-05"}
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01"), snan_interest]))
    assert out["amount"] == Decimal("1440")
    assert out["principal"] is None and out["interest"] is None   # skipped → total-only
