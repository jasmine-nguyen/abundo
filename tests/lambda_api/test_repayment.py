"""Tests for GET /repayment and the get_repayment handler (WHIT-115).

Injects a FakeTransactionRepo returning newest-first up-homeloan rows. Covers:
the repayment + same-month interest split (principal = amount - |interest|),
total-only when no interest pairs, the null sentinel when there's no repayment,
non-repayment rows ignored, and the route's DecimalEncoder JSON shaping.
"""

import json
from decimal import Decimal


class FakeTransactionRepo:
    """Handler-level stand-in: returns the given rows (assumed newest-first)."""

    def __init__(self, rows):
        self._rows = rows
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start, end, limit):
        self.calls.append((account_id, start, end, limit))
        return list(self._rows), None


def _repayment(date, amount="1440"):
    return {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": Decimal(amount), "date": date}


def _interest(date, amount="-232"):
    return {"type": "TRANSFER_OUTGOING", "category": "BANK_FEES", "amount": Decimal(amount), "date": date}


# --- get_repayment -----------------------------------------------------------


def test_pairs_same_month_interest_into_a_split(handler):
    repo = FakeTransactionRepo([_interest("2026-07-05"), _repayment("2026-07-01")])
    out = handler.get_repayment(repo)
    assert out["amount"] == Decimal("1440")
    assert out["date"] == "2026-07-01"
    # interest stored negative -> shown as magnitude; principal = amount - |interest|.
    assert out["interest"] == Decimal("232")
    assert out["principal"] == Decimal("1208")
    # It reads the whole up-homeloan partition, newest-first (no date bounds).
    assert repo.calls[0][0] == "up-homeloan"
    assert repo.calls[0][1] is None and repo.calls[0][2] is None


def test_principal_plus_interest_equals_amount(handler):
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01"), _interest("2026-07-05")]))
    assert out["principal"] + abs(out["interest"]) == out["amount"]


def test_total_only_when_interest_is_a_different_month(handler):
    # June interest must NOT pair with a July repayment.
    repo = FakeTransactionRepo([_repayment("2026-07-01"), _interest("2026-06-05")])
    out = handler.get_repayment(repo)
    assert out["amount"] == Decimal("1440")
    assert out["date"] == "2026-07-01"
    assert out["principal"] is None
    assert out["interest"] is None


def test_picks_the_newest_repayment(handler):
    repo = FakeTransactionRepo([_repayment("2026-07-01", "1440"), _repayment("2026-06-01", "1400")])
    out = handler.get_repayment(repo)
    assert out["date"] == "2026-07-01"   # first (newest) TRANSFER_INCOMING wins


def test_null_sentinel_when_no_repayment(handler):
    # A lone interest leg (no incoming transfer) is not a repayment.
    out = handler.get_repayment(FakeTransactionRepo([_interest("2026-07-05")]))
    assert out == {"amount": None, "date": None, "principal": None, "interest": None}


def test_null_sentinel_when_no_rows(handler):
    assert handler.get_repayment(FakeTransactionRepo([])) == {
        "amount": None, "date": None, "principal": None, "interest": None,
    }


def test_ignores_negative_incoming_transfer(handler):
    # Only a POSITIVE incoming transfer is a repayment credit.
    repo = FakeTransactionRepo([{"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": Decimal("-5"), "date": "2026-07-01"}])
    assert handler.get_repayment(repo)["amount"] is None


def test_returns_a_sub_ten_dollar_repayment(handler):
    # The read API has NO $10 alert floor (that's the poller's concern). A small
    # repayment must still be returned. Fail-on-revert guard: this breaks if anyone
    # bakes MIN_REPAYMENT_NOTIFY into the shared is_repayment_credit rule.
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01", "5")]))
    assert out["amount"] == Decimal("5")
    assert out["date"] == "2026-07-01"


# --- route -------------------------------------------------------------------


def test_route_get_repayment_json_numbers(handler, monkeypatch):
    repo = FakeTransactionRepo([_repayment("2026-07-01"), _interest("2026-07-05")])
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    event = {"rawPath": "/repayment", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"amount": 1440, "date": "2026-07-01", "principal": 1208, "interest": 232}


def test_route_get_repayment_null_sentinel(handler, monkeypatch):
    monkeypatch.setattr(handler, "TransactionRepository", lambda: FakeTransactionRepo([]))
    event = {"rawPath": "/repayment", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"amount": None, "date": None, "principal": None, "interest": None}


# --- WHIT-325 GAP tests (adversarial; not duplicating the three seeded tests) -


def test_skips_a_malformed_newest_leg_and_returns_the_next_valid_repayment(handler):
    # WHIT-325 — [A30] the API-side analog of the poller's A26. The shared predicate
    # must SKIP a garbled newest leg (non-numeric amount, then a None amount) and let
    # the loop fall through to the next genuine repayment. Fail-on-revert: weaken the
    # isinstance guard in is_repayment_credit and the garbled leg is no longer skipped —
    # get_repayment then raises TypeError on 'oops' > 0, so this test goes red.
    rows = [
        {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": "oops", "date": "2026-07-10"},
        {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": None, "date": "2026-07-08"},
        _repayment("2026-07-01", "1440"),
    ]
    out = handler.get_repayment(FakeTransactionRepo(rows))
    assert out["amount"] == Decimal("1440")
    assert out["date"] == "2026-07-01"


def test_small_repayment_with_larger_same_month_interest_is_total_only(handler):
    # WHIT-325 — [A31] a sub-$10 repayment is selected by the shared predicate (no
    # floor) and STILL flows through the interest-summing loop. When same-month
    # interest exceeds the tiny repayment, the split is suppressed (total-only, never a
    # negative principal). Fail-on-revert twice over: a floor in the shared rule drops
    # the $5 leg (amount would be None); dropping the `interest < amount` guard yields a
    # negative principal.
    repo = FakeTransactionRepo([_repayment("2026-07-01", "5"), _interest("2026-07-05", "-8")])
    out = handler.get_repayment(repo)
    assert out["amount"] == Decimal("5")
    assert out["date"] == "2026-07-01"
    assert out["principal"] is None
    assert out["interest"] is None
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


def test_string_interest_amount_is_skipped_not_summed(handler):
    # WHIT-327: a non-numeric (string) interest amount is skipped by the shared is_number
    # guard, exactly as the old local _num did — total-only, never a `str < 0` crash.
    string_interest = {"category": "BANK_FEES", "amount": "-232", "date": "2026-07-05"}
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01"), string_interest]))
    assert out["amount"] == Decimal("1440")
    assert out["principal"] is None and out["interest"] is None   # skipped → total-only


def test_decimal_nan_interest_amount_is_skipped_not_fatal(handler):
    # WHIT-327 hardening: a stored Decimal('NaN') interest amount would raise
    # InvalidOperation on `amount_leg < 0` and 500 the card — is_number now rejects
    # non-finite values, so the leg is skipped → total-only, no crash.
    nan_interest = {"category": "BANK_FEES", "amount": Decimal("NaN"), "date": "2026-07-05"}
    out = handler.get_repayment(FakeTransactionRepo([_repayment("2026-07-01"), nan_interest]))
    assert out["amount"] == Decimal("1440")
    assert out["principal"] is None and out["interest"] is None


def test_decimal_nan_repayment_amount_is_skipped_not_fatal(handler):
    # WHIT-327 hardening: a Decimal('NaN') repayment amount would raise on `amount > 0`
    # in is_repayment_credit — is_number rejects it, so the leg is skipped and the scan
    # falls through to the next valid repayment instead of crashing.
    nan_repayment = {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN",
                     "amount": Decimal("NaN"), "date": "2026-07-02"}
    out = handler.get_repayment(FakeTransactionRepo([nan_repayment, _repayment("2026-07-01")]))
    assert out["amount"] == Decimal("1440")   # falls through to the valid repayment


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
