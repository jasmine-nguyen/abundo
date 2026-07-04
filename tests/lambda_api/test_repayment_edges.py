"""WHIT-115 — adversarial GAP tests for get_repayment.

Does NOT duplicate test_repayment.py (same-month split, total-only for a different
month, newest repayment, null sentinels, negative-incoming ignored, route JSON).
This file locks robustness + selection behaviour the happy-path suite omits:

  * incidental malformed rows (missing keys, no amount) are skipped, not fatal,
    and a valid repayment further down the page is still found;
  * the interest leg is paired on category+month ONLY, regardless of its `type`;
  * when several BANK_FEES legs fall in the repayment's month, the FIRST (newest,
    since rows are newest-first) is used — see the ranked critique: arguably this
    should sum the month's interest rather than take one leg.
"""

from decimal import Decimal


class FakeTransactionRepo:
    """Returns the given rows (assumed newest-first), like the real repo's page."""

    def __init__(self, rows):
        self._rows = rows

    def get_transactions_by_date_range(self, account_id, start, end, limit):
        return list(self._rows), None


def _repayment(date, amount="1440"):
    return {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": Decimal(amount), "date": date}


def _interest(date, amount="-232"):
    return {"type": "TRANSFER_OUTGOING", "category": "BANK_FEES", "amount": Decimal(amount), "date": date}


def test_skips_incidental_malformed_rows_and_still_finds_the_repayment(handler):
    # A junk row with none of type/category/amount must not crash the scan and
    # must be skipped; the real repayment + its interest still resolve.
    rows = [{"description": "weird row, no keys we read"}, _repayment("2026-07-01"), _interest("2026-07-05")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["amount"] == Decimal("1440")
    assert out["principal"] == Decimal("1208")
    assert out["interest"] == Decimal("232")


def test_pairs_interest_on_category_and_month_regardless_of_type(handler):
    # The interest matcher anchors on category==BANK_FEES + same month, NOT on
    # any transaction `type` — a BANK_FEES row with no `type` still pairs.
    interest_no_type = {"category": "BANK_FEES", "amount": Decimal("-232"), "date": "2026-07-05"}
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01"), interest_no_type]))
    assert out["interest"] == Decimal("232")
    assert out["principal"] == Decimal("1208")


def test_uses_the_first_same_month_interest_leg_when_several_exist(handler):
    # Two BANK_FEES legs in the repayment's month. Rows are newest-first, so the
    # first-matched (newest, -300) is used — the older -232 leg is NOT added.
    rows = [_interest("2026-07-20", "-300"), _interest("2026-07-05", "-232"), _repayment("2026-07-01")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] == Decimal("300")
    assert out["principal"] == Decimal("1140")   # 1440 - 300, NOT 1440 - 532


# --- robustness: a malformed row must not 500 the card (R1–R3) ----------------


def test_null_amount_on_incoming_transfer_is_skipped_not_fatal(handler):
    # amount present but None (key exists, value null) must NOT crash (None > 0).
    bad = {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": None, "date": "2026-07-02"}
    out = handler.get_repayment(FakeTransactionRepo([bad, _repayment("2026-07-01")]))
    assert out["amount"] == Decimal("1440")   # falls through to the valid repayment


def test_repayment_without_a_date_is_skipped(handler):
    dateless = {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": Decimal("1440")}
    out = handler.get_repayment(FakeTransactionRepo([dateless]))
    assert out == {"amount": None, "date": None, "principal": None, "interest": None}


def test_interest_row_with_no_amount_falls_back_to_total_only(handler):
    bad_interest = {"category": "BANK_FEES", "date": "2026-07-05"}   # no amount
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01"), bad_interest]))
    assert out["amount"] == Decimal("1440")
    assert out["principal"] is None and out["interest"] is None   # total-only, no crash


# --- correctness: never a negative or reversal-poisoned split (R4–R5) ---------


def test_interest_at_or_above_the_repayment_falls_back_to_total_only(handler):
    # A tiny repayment against a big same-month fee must NOT show a negative principal.
    small = _repayment("2026-07-01", "100")
    out = handler.get_repayment(FakeTransactionRepo([small, _interest("2026-07-05", "-232")]))
    assert out["amount"] == Decimal("100")
    assert out["principal"] is None and out["interest"] is None


def test_positive_bank_fees_reversal_is_not_treated_as_interest(handler):
    # A positive BANK_FEES (interest refund/reversal) must not be abs()'d into a split.
    reversal = {"type": "TRANSFER_OUTGOING", "category": "BANK_FEES", "amount": Decimal("232"), "date": "2026-07-05"}
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01"), reversal]))
    assert out["principal"] is None and out["interest"] is None   # total-only
