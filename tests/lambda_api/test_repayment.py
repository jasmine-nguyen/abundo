"""Tests for GET /repayment and the get_repayment handler (WHIT-115).

Injects a _QueuedTransactionRepo returning newest-first up-homeloan rows. Covers:
the repayment + same-month interest split (principal = amount - |interest|),
total-only when no interest pairs, the null sentinel when there's no repayment,
non-repayment rows ignored, and the route's JSON shaping.
"""

import json
from decimal import Decimal

import pytest

from _api_event import api_event
from _transaction_range_fakes import _QueuedTransactionRepo


def _repayment(date, amount="1440"):
    return {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": Decimal(amount), "date": date}


def _interest(date, amount="-232"):
    return {"type": "TRANSFER_OUTGOING", "category": "BANK_FEES", "amount": Decimal(amount), "date": date}


# --- get_repayment -----------------------------------------------------------


def test_pairs_same_month_interest_into_a_split(handler):
    repo = _QueuedTransactionRepo([_interest("2026-07-05"), _repayment("2026-07-01")])
    out = handler.get_repayment(repo)
    assert out["amount"] == Decimal("1440")
    assert out["date"] == "2026-07-01"
    # interest stored negative -> shown as magnitude; principal = amount - |interest|.
    assert out["interest"] == Decimal("232")
    assert out["principal"] == Decimal("1208")
    # It reads the whole up-homeloan partition, newest-first (no date bounds).
    assert repo.calls[0][0] == "up-homeloan"
    assert repo.calls[0][1] is None and repo.calls[0][2] is None
    assert len(repo.calls) == 1


def test_null_sentinel_when_no_repayment(handler):
    # A lone interest leg (no incoming transfer) is not a repayment.
    out = handler.get_repayment(_QueuedTransactionRepo([_interest("2026-07-05")]))
    assert out == {"amount": None, "date": None, "principal": None, "interest": None}


def test_returns_a_sub_ten_dollar_repayment(handler):
    # The read API has NO $10 alert floor (that's the poller's concern). A small
    # repayment must still be returned. Fail-on-revert guard: this breaks if anyone
    # bakes MIN_REPAYMENT_NOTIFY into the shared is_repayment_credit rule.
    out = handler.get_repayment(_QueuedTransactionRepo([_repayment("2026-07-01", "5")]))
    assert out["amount"] == Decimal("5")
    assert out["date"] == "2026-07-01"


# --- WHIT-325: malformed rows are skipped ----------------------------------------------------


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
    out = handler.get_repayment(_QueuedTransactionRepo(rows))
    assert out["amount"] == Decimal("1440")
    assert out["date"] == "2026-07-01"


def test_skips_incidental_malformed_rows_and_still_finds_the_repayment(handler):
    # A junk row with none of type/category/amount must not crash the scan and
    # must be skipped; the real repayment + its interest still resolve.
    rows = [{"description": "weird row, no keys we read"}, _repayment("2026-07-01"), _interest("2026-07-05")]
    out = handler.get_repayment(_QueuedTransactionRepo(rows))
    assert out["amount"] == Decimal("1440")
    assert out["principal"] == Decimal("1208")
    assert out["interest"] == Decimal("232")


def test_pairs_interest_on_category_and_month_regardless_of_type(handler):
    # The interest matcher anchors on category==BANK_FEES + same month, NOT on
    # any transaction `type` — a BANK_FEES row with no `type` still pairs.
    interest_no_type = {"category": "BANK_FEES", "amount": Decimal("-232"), "date": "2026-07-05"}
    out = handler.get_repayment(_QueuedTransactionRepo([_repayment("2026-07-01"), interest_no_type]))
    assert out["interest"] == Decimal("232")
    assert out["principal"] == Decimal("1208")


def test_sums_all_same_month_interest_legs(handler):
    # WHIT-120: two BANK_FEES legs in the repayment's month sum into the interest
    # (not just the newest). Fail-on-revert: the old `break`-on-newest gives 300/1140.
    rows = [_interest("2026-07-20", "-300"), _interest("2026-07-05", "-232"), _repayment("2026-07-01")]
    out = handler.get_repayment(_QueuedTransactionRepo(rows))
    assert out["interest"] == Decimal("532")     # 300 + 232, both same-month legs
    assert out["principal"] == Decimal("908")    # 1440 - 532


def test_adjacent_month_interest_leg_is_excluded_from_the_sum(handler):
    # Only the repayment's own calendar month sums. A June leg must not be added to a
    # July repayment even though it's the larger, newer-adjacent one.
    rows = [_interest("2026-07-05", "-232"), _interest("2026-06-30", "-300"),
            _repayment("2026-07-01")]
    out = handler.get_repayment(_QueuedTransactionRepo(rows))
    assert out["interest"] == Decimal("232")     # only the July leg
    assert out["principal"] == Decimal("1208")   # 1440 - 232


def test_one_good_and_one_malformed_same_month_leg_still_sums_the_good_one(handler):
    # A malformed interest leg (no amount) in the month must be skipped, not abort or
    # zero the sum — the valid same-month leg still produces a real split. (plan-critic)
    malformed = {"category": "BANK_FEES", "date": "2026-07-20"}  # no amount
    rows = [malformed, _interest("2026-07-05", "-232"), _repayment("2026-07-01")]
    out = handler.get_repayment(_QueuedTransactionRepo(rows))
    assert out["interest"] == Decimal("232")
    assert out["principal"] == Decimal("1208")


# --- robustness: a malformed row must not 500 the card ------------------------


@pytest.mark.parametrize("bad", [
    # A stored Decimal('sNaN') would raise InvalidOperation at `amount > 0` and 500 the card.
    {"type": "TRANSFER_INCOMING", "category": "TRANSFER_IN", "amount": Decimal("sNaN"), "date": "2026-07-02"},
])
def test_unreadable_repayment_leg_is_skipped(handler, bad):
    out = handler.get_repayment(_QueuedTransactionRepo([bad, _repayment("2026-07-01")]))
    assert out["amount"] == Decimal("1440")   # fell through to the valid repayment


@pytest.mark.parametrize("bad", [
    {"category": "BANK_FEES", "amount": Decimal("sNaN"), "date": "2026-07-05"},
    # A zero-amount leg is not a debit, so it neither makes a bogus 0-interest split nor crashes.
    {"category": "BANK_FEES", "amount": Decimal("0"), "date": "2026-07-05"},
], ids=["signalling-nan", "lone-zero-leg"])
def test_unreadable_interest_leg_gives_total_only(handler, bad):
    out = handler.get_repayment(_QueuedTransactionRepo([_repayment("2026-07-01"), bad]))
    assert out["amount"] == Decimal("1440")
    assert out["principal"] is None and out["interest"] is None


# --- WHIT-120: every same-month interest leg sums ---------------------------------------------
# [fail-on-revert] fails if the loop reverts to `interest = abs(amt); break`;
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
    out = handler.get_repayment(_QueuedTransactionRepo(rows))
    assert out["date"] == "2026-07-01"
    assert out["interest"] == Decimal("332")     # 232 + 100, July only
    assert out["principal"] == Decimal("1108")   # 1440 - 332


def test_summed_interest_exactly_equal_to_amount_total_only(handler):
    # [fail-on-revert] The guard is strict `<`, so a SUM that lands exactly ON the amount is
    # total-only (no zero principal). Two -720 legs == 1440 repayment. Revert (break) uses one
    # 720 leg < 1440 and fabricates a 720/720 split, so this fails on revert.
    rows = [_interest("2026-07-06", "-720"), _interest("2026-07-05", "-720"),
            _repayment("2026-07-01", "1440")]
    out = handler.get_repayment(_QueuedTransactionRepo(rows))
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
    out = handler.get_repayment(_QueuedTransactionRepo(rows))
    assert out["interest"] == Decimal("532")     # 300 + 232, reversal excluded
    assert out["principal"] == Decimal("908")


def test_different_category_same_month_leg_is_ignored(handler):
    # [guard] A negative same-month leg of a DIFFERENT category (GROCERIES) must never fold
    # into interest — the matcher is category==BANK_FEES only. Holds under a WHIT-120 revert.
    other = {"type": "TRANSFER_OUTGOING", "category": "GROCERIES",
             "amount": Decimal("-500"), "date": "2026-07-05"}
    rows = [other, _interest("2026-07-06", "-232"), _repayment("2026-07-01")]
    out = handler.get_repayment(_QueuedTransactionRepo(rows))
    assert out["interest"] == Decimal("232")     # not 732
    assert out["principal"] == Decimal("1208")


def test_route_sums_multi_leg_interest_json(handler, monkeypatch):
    # [fail-on-revert] End-to-end through lambda_handler: the /repayment route serialises a
    # SUMMED split as plain JSON numbers (default=float), and interest stays a Decimal so the
    # subtraction + encoding stay exact (not float). Revert -> 300/1140.
    rows = [_interest("2026-07-20", "-300"), _interest("2026-07-05", "-232"), _repayment("2026-07-01")]
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _QueuedTransactionRepo(rows))
    event = api_event("GET", "/repayment")
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {
        "amount": 1440, "date": "2026-07-01", "principal": 908, "interest": 532}
    assert isinstance(handler.get_repayment(_QueuedTransactionRepo(rows))["interest"], Decimal)  # not float
