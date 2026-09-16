"""Tests for the recurring-bill detector (WHIT-559 prereq) — detect_recurring_bills.

Given a user's charges, find the recurring bills: one per named merchant billed on enough distinct
days at a regular, nameable cadence with a steady-ish amount, each carrying {merchant, typicalAmount,
cadence, medianGapDays, occurrences}. Pure logic — imported in isolation via the `recurring_bills`
fixture, no handler, no repo.

Named merchants only (decision A): a nameless direct debit is a deliberate miss, proven below.
"""

from decimal import Decimal

import pytest

from _feed_fakes import ANZ, _row


def _bill(date, amount, merchant="ORIGIN ENERGY", txn_id=None, **extra):
    return _row(ANZ, date, txn_id or f"{merchant}-{date}", merchant_name=merchant,
                description=f"{merchant} DIRECT DEBIT", amount=Decimal(str(amount)), **extra)


def _monthly(amount=-42.50, merchant="ORIGIN ENERGY", start_months=("01", "02", "03", "04")):
    return [_bill(f"2026-{month}-05", amount, merchant=merchant) for month in start_months]


def _only(result):
    assert len(result["bills"]) == 1
    return result["bills"][0]


def test_detects_a_monthly_bill_with_amount_and_cadence(recurring_bills):
    bill = _only(recurring_bills.detect_recurring_bills(_monthly()))

    assert bill["merchant"] == "ORIGIN ENERGY"
    assert bill["typicalAmount"] == Decimal("42.50")
    assert bill["cadence"] == "monthly"
    assert bill["occurrences"] == 4
    # medianGapDays is a whole number of days (int), never a half-day from an even gap count.
    # Gaps here are [31, 28, 31] → median 31.
    assert bill["medianGapDays"] == 31
    assert isinstance(bill["medianGapDays"], int)


@pytest.mark.parametrize("dates, cadence", [
    (["2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22"], "weekly"),
    (["2026-01-01", "2026-01-15", "2026-01-29", "2026-02-12"], "fortnightly"),
    (["2026-01-05", "2026-02-05", "2026-03-05", "2026-04-05"], "monthly"),
    (["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"], "quarterly"),
])
def test_maps_the_gap_to_the_right_cadence(recurring_bills, dates, cadence):
    # FAIL-ON-REVERT for the cadence windows: a ~14-day beat is fortnightly, never monthly. Widen
    # a window to overlap its neighbour and the wrong label reddens here.
    charges = [_bill(date, -30.00) for date in dates]

    assert _only(recurring_bills.detect_recurring_bills(charges))["cadence"] == cadence


def test_a_drifting_utility_still_counts_and_reports_its_median(recurring_bills):
    charges = [_bill(f"2026-{m}-05", amount) for m, amount in
               (("01", -95.00), ("02", -110.00), ("03", -100.00), ("04", -105.00))]

    bill = _only(recurring_bills.detect_recurring_bills(charges))

    assert bill["cadence"] == "monthly"
    assert bill["typicalAmount"] == Decimal("102.50")  # median of 95/100/105/110


def test_an_even_occurrence_count_quantises_the_half_cent_median(recurring_bills):
    charges = [_bill(f"2026-{m}-05", amount) for m, amount in
               (("01", -10.00), ("02", -10.05), ("03", -10.00), ("04", -10.05))]

    # median magnitude = (10.00 + 10.05) / 2 = 10.025 → ROUND_HALF_UP to cents = 10.03
    assert _only(recurring_bills.detect_recurring_bills(charges))["typicalAmount"] == Decimal("10.03")


def test_a_wildly_variable_amount_is_not_a_bill(recurring_bills):
    charges = [_bill(f"2026-{m}-05", amount) for m, amount in
               (("01", -50.00), ("02", -100.00), ("03", -160.00), ("04", -100.00))]

    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


def test_a_missed_cycle_doubles_a_gap_and_rejects_the_bill(recurring_bills):
    # FAIL-ON-REVERT for INTERVAL_TOLERANCE: the last gap is ~60 days (a skipped month), so the beat
    # is not regular. Loosen the tolerance and this bill would wrongly emit.
    charges = [_bill(date, -42.50) for date in
               ("2026-01-01", "2026-01-31", "2026-03-02", "2026-05-01")]

    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


def test_three_occurrences_is_the_floor(recurring_bills):
    # FAIL-ON-REVERT for MIN_OCCURRENCES: three billed months emit, two do not. Drop the floor to 2
    # and the two-charge case would wrongly emit.
    three = recurring_bills.detect_recurring_bills(_monthly(start_months=("01", "02", "03")))
    two = recurring_bills.detect_recurring_bills(_monthly(start_months=("01", "02")))

    assert _only(three)["occurrences"] == 3
    assert two["bills"] == []


def test_recurring_income_is_never_a_bill(recurring_bills):
    salary = [_bill(f"2026-{m}-05", 3200.00, merchant="ACME PAYROLL")
              for m in ("01", "02", "03", "04")]

    assert recurring_bills.detect_recurring_bills(salary)["bills"] == []


def test_same_merchant_filed_to_two_categories_is_one_bill(recurring_bills):
    charges = [_bill(f"2026-{m}-05", -42.50, category=category) for m, category in
               (("01", "utilities"), ("02", "bills"), ("03", "utilities"), ("04", "bills"))]

    # The detector keys on merchant + amount + date, never category, so a merchant filed two ways is
    # still ONE bill — unlike filing_habits, which must pick a winning category.
    assert _only(recurring_bills.detect_recurring_bills(charges))["occurrences"] == 4


def test_a_nameless_direct_debit_is_not_detected(recurring_bills):
    # Decision A: named merchants only. A nameless recurring transfer is bucketed by no merchant, so
    # it is a known miss (a follow-up card covers the description-stem pass).
    charges = [_row(ANZ, f"2026-{m}-05", f"n{m}", merchant_name="",
                    description="OSKO PAYMENT 447112", amount=Decimal("-42.50"))
               for m in ("01", "02", "03", "04")]

    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


def test_same_day_duplicate_is_one_occurrence(recurring_bills):
    charges = [
        _bill("2026-01-05", -42.50, txn_id="a"),
        _bill("2026-01-05", -42.50, txn_id="b"),  # same day → collapses, no 0-day gap
        _bill("2026-02-05", -42.50, txn_id="c"),
        _bill("2026-03-05", -42.50, txn_id="d"),
    ]

    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["occurrences"] == 3
    assert bill["cadence"] == "monthly"


def test_malformed_rows_are_skipped_not_crashed(recurring_bills):
    charges = _monthly() + [
        _row(ANZ, "2026-05-05", "no-amount", merchant_name="ORIGIN ENERGY"),
        _row(ANZ, "2026-06-05", "nan", merchant_name="ORIGIN ENERGY", amount=Decimal("NaN")),
        _row(ANZ, "bad-date", "bad", merchant_name="ORIGIN ENERGY", amount=Decimal("-42.50")),
    ]

    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["occurrences"] == 4  # the four clean months; the three malformed rows skipped


def test_bills_are_returned_strongest_first_then_by_merchant(recurring_bills):
    four = _monthly(merchant="ORIGIN ENERGY", start_months=("01", "02", "03", "04"))
    three_a = _monthly(merchant="AGL", start_months=("01", "02", "03"))
    three_b = _monthly(merchant="TELSTRA", start_months=("01", "02", "03"))

    bills = recurring_bills.detect_recurring_bills(three_b + three_a + four)["bills"]

    # Most occurrences first (ORIGIN, 4); the two 3-occurrence bills tie-break on merchant (AGL < TELSTRA).
    assert [bill["merchant"] for bill in bills] == ["ORIGIN ENERGY", "AGL", "TELSTRA"]
