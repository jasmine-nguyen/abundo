"""Tests for the recurring-bill detector (WHIT-559 prereq) — detect_recurring_bills.

Given a user's charges, find the recurring bills: one per named merchant billed on enough distinct
days at a regular, nameable cadence with a steady-ish amount, each carrying {merchant, typicalAmount,
cadence, medianGapDays, occurrences}. Pure logic — imported in isolation via the `recurring_bills`
fixture, no handler, no repo.

Two passes (WHIT-569): named merchants, and nameless bank direct debits keyed by description stem
(fuzzier, so it demands 4+ occurrences and a tighter amount).
"""

from decimal import Decimal

import pytest

from _feed_fakes import ANZ, _row


def _bill(date, amount, merchant="ORIGIN ENERGY", txn_id=None, **extra):
    return _row(ANZ, date, txn_id or f"{merchant}-{date}", merchant_name=merchant,
                description=f"{merchant} DIRECT DEBIT", amount=Decimal(str(amount)), **extra)


def _nameless(date, amount, description="OSKO PAYMENT 447112", txn_id=None, **extra):
    # A bank direct debit: no merchant name, only a description with a trailing reference number.
    return _row(ANZ, date, txn_id or f"n-{date}", merchant_name="",
                description=description, amount=Decimal(str(amount)), **extra)


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


def test_a_nameless_direct_debit_is_detected_by_its_stem(recurring_bills):
    # WHIT-569: a nameless recurring direct debit is now caught by the description-stem pass. The
    # trailing reference number is trimmed, so the bill's identity is the stem "OSKO PAYMENT".
    charges = [_nameless(f"2026-{m}-05", -42.50) for m in ("01", "02", "03", "04")]

    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["merchant"] == "OSKO PAYMENT"
    assert bill["typicalAmount"] == Decimal("42.50")
    assert bill["cadence"] == "monthly"
    assert bill["occurrences"] == 4


def test_nameless_needs_a_fourth_occurrence_that_a_named_bill_does_not(recurring_bills):
    # WHIT-569 stricter floor: 3 nameless occurrences are below the nameless floor (4), while 3 NAMED
    # occurrences still emit. FAIL-ON-REVERT: drop NAMELESS_MIN_OCCURRENCES to 3 and the nameless
    # three-charge case wrongly emits.
    three_nameless = [_nameless(f"2026-{m}-05", -42.50) for m in ("01", "02", "03")]
    three_named = _monthly(start_months=("01", "02", "03"))

    assert recurring_bills.detect_recurring_bills(three_nameless)["bills"] == []
    assert _only(recurring_bills.detect_recurring_bills(three_named))["occurrences"] == 3


def test_a_nameless_amount_drift_a_named_bill_tolerates_rejects_the_nameless_bill(recurring_bills):
    # WHIT-569 tighter amount: a ±20% amount drift passes the named ±30% tolerance but fails the
    # nameless ±15% one. FAIL-ON-REVERT: widen NAMELESS_AMOUNT_TOLERANCE to 0.30 and the nameless
    # case wrongly emits. Amounts 80/100/120/100 → median 100, max drift 20%.
    amounts = (-80.00, -100.00, -120.00, -100.00)
    nameless = [_nameless(f"2026-{m}-05", amount)
                for m, amount in zip(("01", "02", "03", "04"), amounts)]
    named = [_bill(f"2026-{m}-05", amount)
             for m, amount in zip(("01", "02", "03", "04"), amounts)]

    assert recurring_bills.detect_recurring_bills(nameless)["bills"] == []
    assert _only(recurring_bills.detect_recurring_bills(named))["cadence"] == "monthly"


def test_a_named_and_a_nameless_bill_in_one_scan_both_emit(recurring_bills):
    # Both passes run over one history; the named merchant and the nameless direct debit each become a
    # bill, sorted by occurrences then identity.
    charges = _monthly() + [_nameless(f"2026-{m}-05", -75.00) for m in ("01", "02", "03", "04")]

    bills = recurring_bills.detect_recurring_bills(charges)["bills"]
    identities = {bill["merchant"] for bill in bills}
    assert identities == {"ORIGIN ENERGY", "OSKO PAYMENT"}
    assert len(bills) == 2


def test_a_named_charge_with_a_stem_is_never_counted_by_the_nameless_pass(recurring_bills):
    # Partition lock: a charge that carries BOTH a merchant name AND a stem-worthy description must
    # land in exactly one pass (named). It appears in at most one bill, never two. FAIL-ON-REVERT:
    # feed the nameless pass the full transaction list (drop the blank-merchant pre-filter) and this
    # merchant emits a second, duplicate bill.
    charges = _monthly()  # ORIGIN ENERGY, description "ORIGIN ENERGY DIRECT DEBIT" (a usable stem)

    bills = recurring_bills.detect_recurring_bills(charges)["bills"]
    assert len(bills) == 1
    assert bills[0]["merchant"] == "ORIGIN ENERGY"


def test_a_bill_split_named_and_nameless_across_months_falls_below_both_floors(recurring_bills):
    # The same real bill where the bank populated the name some months and left it blank others:
    # the named side (2) and the nameless side (2) each sit below their floor, so nothing emits —
    # the conservative outcome the card's "fuzzier" warning implies.
    charges = (
        [_bill(f"2026-{m}-05", -42.50) for m in ("01", "02")]
        + [_nameless(f"2026-{m}-05", -42.50) for m in ("03", "04")]
    )

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
