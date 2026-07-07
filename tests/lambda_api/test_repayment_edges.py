"""WHIT-115 — adversarial GAP tests for get_repayment.

Does NOT duplicate test_repayment.py (same-month split, total-only for a different
month, newest repayment, null sentinels, negative-incoming ignored, route JSON).
This file locks robustness + selection behaviour the happy-path suite omits:

  * incidental malformed rows (missing keys, no amount) are skipped, not fatal,
    and a valid repayment further down the page is still found;
  * the interest leg is paired on category+month ONLY, regardless of its `type`;
  * when several BANK_FEES legs fall in the repayment's month, ALL are summed into
    the interest (WHIT-120) — not just the newest.
"""

import json
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


def test_sums_all_same_month_interest_legs(handler):
    # WHIT-120: two BANK_FEES legs in the repayment's month sum into the interest
    # (not just the newest). Fail-on-revert: the old `break`-on-newest gives 300/1140.
    rows = [_interest("2026-07-20", "-300"), _interest("2026-07-05", "-232"), _repayment("2026-07-01")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] == Decimal("532")     # 300 + 232, both same-month legs
    assert out["principal"] == Decimal("908")    # 1440 - 532


def test_three_same_month_interest_legs_all_sum(handler):
    # WHIT-120: more than two legs still all sum — guards a fix that only paired two.
    rows = [
        _interest("2026-07-20", "-100"), _interest("2026-07-12", "-200"),
        _interest("2026-07-05", "-232"), _repayment("2026-07-01"),
    ]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] == Decimal("532")     # 100 + 200 + 232
    assert out["principal"] == Decimal("908")    # 1440 - 532


def test_positive_bank_fees_reversal_is_not_added_to_the_sum(handler):
    # A positive BANK_FEES row (a fee reversal/credit) is NOT interest and must not
    # net into the sum — only negative debits accumulate. So a -300 leg plus a +232
    # reversal in the same month yields interest 300, not 68 or 532.
    reversal = {"category": "BANK_FEES", "amount": Decimal("232"), "date": "2026-07-12"}
    rows = [_interest("2026-07-20", "-300"), reversal, _repayment("2026-07-01")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] == Decimal("300")
    assert out["principal"] == Decimal("1140")


def test_summed_interest_at_or_above_amount_falls_back_to_total_only(handler):
    # The `interest < amount` guard fires on the SUM, not a single leg. Repayment 500,
    # two legs -300 + -232 = 532 >= 500 → total-only (no fabricated/negative principal).
    # Either leg alone (< 500) would have produced a split, so this locks the guard on
    # the summed value.
    rows = [_interest("2026-07-20", "-300"), _interest("2026-07-05", "-232"),
            _repayment("2026-07-01", "500")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] is None
    assert out["principal"] is None
    assert out["amount"] == Decimal("500")


def test_adjacent_month_interest_leg_is_excluded_from_the_sum(handler):
    # Only the repayment's own calendar month sums. A June leg must not be added to a
    # July repayment even though it's the larger, newer-adjacent one.
    rows = [_interest("2026-07-05", "-232"), _interest("2026-06-30", "-300"),
            _repayment("2026-07-01")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] == Decimal("232")     # only the July leg
    assert out["principal"] == Decimal("1208")   # 1440 - 232


def test_one_good_and_one_malformed_same_month_leg_still_sums_the_good_one(handler):
    # A malformed interest leg (no amount) in the month must be skipped, not abort or
    # zero the sum — the valid same-month leg still produces a real split. (plan-critic)
    malformed = {"category": "BANK_FEES", "date": "2026-07-20"}  # no amount
    rows = [malformed, _interest("2026-07-05", "-232"), _repayment("2026-07-01")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] == Decimal("232")
    assert out["principal"] == Decimal("1208")


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


# WHIT-120 gap tests (adversarial half, authored by qa): multi-repayment month-selection,
# the exact `== amount` guard boundary, reversal-before-negatives ordering, foreign-category
# isolation, zero-leg boundary, high-volume summing, and the /repayment route JSON for a
# summed split. [fail-on-revert] fails if the loop reverts to `interest = abs(amt); break`;
# [guard] locks an adjacent invariant WHIT-120 didn't change and holds under both.


def test_only_chosen_repayments_month_sums(handler):
    # [fail-on-revert] Two repayments in different months. The NEWEST (July) is chosen, and
    # ONLY July's legs sum — June's leg must not leak in even though June also has a
    # repayment. Pins "sum the CHOSEN repayment's month", not just "same month".
    rows = [
        _repayment("2026-07-01"),
        _interest("2026-07-20", "-232"), _interest("2026-07-05", "-100"),
        _repayment("2026-06-01", "1400"), _interest("2026-06-15", "-500"),
    ]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["date"] == "2026-07-01"
    assert out["interest"] == Decimal("332")     # 232 + 100, July only
    assert out["principal"] == Decimal("1108")   # 1440 - 332


def test_summed_interest_exactly_equal_to_amount_total_only(handler):
    # [fail-on-revert] The guard is strict `<`, so a SUM that lands exactly ON the amount is
    # total-only (no zero principal). Two -720 legs == 1440 repayment. Revert (break) uses one
    # 720 leg < 1440 and fabricates a 720/720 split, so this fails on revert.
    rows = [_interest("2026-07-06", "-720"), _interest("2026-07-05", "-720"),
            _repayment("2026-07-01", "1440")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] is None
    assert out["principal"] is None
    assert out["amount"] == Decimal("1440")


def test_reversal_before_two_negatives_sums_only_negatives(handler):
    # [fail-on-revert] Ordering variant: a positive reversal is the NEWEST row, followed by
    # two real debits. The reversal is skipped and BOTH debits still accumulate. Revert (break)
    # stops at the first debit -> 300, fails.
    reversal = {"category": "BANK_FEES", "amount": Decimal("232"), "date": "2026-07-25"}
    rows = [reversal, _interest("2026-07-20", "-300"), _interest("2026-07-05", "-232"),
            _repayment("2026-07-01")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] == Decimal("532")     # 300 + 232, reversal excluded
    assert out["principal"] == Decimal("908")


def test_different_category_same_month_leg_is_ignored(handler):
    # [guard] A negative same-month leg of a DIFFERENT category (GROCERIES) must never fold
    # into interest — the matcher is category==BANK_FEES only. Holds under a WHIT-120 revert.
    other = {"type": "TRANSFER_OUTGOING", "category": "GROCERIES",
             "amount": Decimal("-500"), "date": "2026-07-05"}
    rows = [other, _interest("2026-07-06", "-232"), _repayment("2026-07-01")]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["interest"] == Decimal("232")     # not 732
    assert out["principal"] == Decimal("1208")


def test_lone_zero_amount_interest_leg_is_total_only(handler):
    # [guard] A zero-amount BANK_FEES leg is not a debit (amt < 0 is False), so it neither
    # creates a bogus 0-interest split nor trips `(interest or 0)`. Locks the `< 0` boundary.
    zero = {"category": "BANK_FEES", "amount": Decimal("0"), "date": "2026-07-05"}
    out = handler.get_repayment(FakeTransactionRepo([zero, _repayment("2026-07-01")]))
    assert out["interest"] is None
    assert out["principal"] is None


def test_many_same_month_legs_all_sum(handler):
    # [fail-on-revert] Volume: twelve same-month debits all accumulate — guards against any
    # accidental cap or two-leg-only pairing. Revert (break) -> 50, fails.
    legs = [_interest(f"2026-07-{d:02d}", "-50") for d in range(2, 14)]  # 12 legs
    out = handler.get_repayment(FakeTransactionRepo(legs + [_repayment("2026-07-01")]))
    assert out["interest"] == Decimal("600")     # 12 * 50
    assert out["principal"] == Decimal("840")    # 1440 - 600


def test_route_sums_multi_leg_interest_json(handler, monkeypatch):
    # [fail-on-revert] End-to-end through lambda_handler: the /repayment route serialises a
    # SUMMED split as plain JSON numbers (DecimalEncoder), and interest stays a Decimal so the
    # subtraction + encoding stay exact (not float). Revert -> 300/1140.
    repo = FakeTransactionRepo([_interest("2026-07-20", "-300"), _interest("2026-07-05", "-232"),
                                _repayment("2026-07-01")])
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    event = {"rawPath": "/repayment", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {
        "amount": 1440, "date": "2026-07-01", "principal": 908, "interest": 532}
    assert isinstance(handler.get_repayment(repo)["interest"], Decimal)  # not float
