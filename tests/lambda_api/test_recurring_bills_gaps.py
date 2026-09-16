"""Adversarial gap tests for the recurring-bill detector (WHIT-559 prereq) — detect_recurring_bills.

The implementer's suite (test_recurring_bills.py) locks the happy paths: cadence mapping,
drift-within-tolerance median, half-cent quantise, volatile/missed-cycle rejection, the 3-occurrence
floor, income exclusion, multi-category folding, nameless miss, same-day dup, malformed skip, order.

This suite hunts the edges those miss: the exact tolerance/window BOUNDARIES, casing folding,
one-off charges polluting a real bill, regular-but-unnameable beats, empty/degenerate inputs, and
the shape (Decimal, positive, medianGapDays int) the WHIT-559 consumer will read.

Pure logic — imported in isolation via the `recurring_bills` fixture (tests/lambda_api/conftest.py).
"""

from decimal import Decimal

from _feed_fakes import ANZ, _row


def _bill(date, amount, merchant="ORIGIN ENERGY", txn_id=None, **extra):
    return _row(ANZ, date, txn_id or f"{merchant}-{date}-{amount}", merchant_name=merchant,
                description=f"{merchant} DIRECT DEBIT", amount=Decimal(str(amount)), **extra)


def _only(result):
    assert len(result["bills"]) == 1, result["bills"]
    return result["bills"][0]


# --- Cadence-window boundaries ------------------------------------------------------------------

def test_gap_exactly_on_the_weekly_high_edge_is_weekly(recurring_bills):
    # [A1] median gap == 8 sits on the weekly window's inclusive high edge (_CADENCE_WINDOWS
    # "weekly", 6, 8). Shrink the edge to 7 and this reddens.
    charges = [_bill(d, -30.00) for d in ("2026-01-01", "2026-01-09", "2026-01-17", "2026-01-25")]
    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["cadence"] == "weekly"
    assert bill["medianGapDays"] == 8


def test_a_regular_beat_between_two_windows_is_not_a_bill(recurring_bills):
    # [A2] a rock-steady 9-day beat falls in the GAP between weekly (..8) and fortnightly (12..):
    # a real cadence, but not one we name → not emitted. Widen a window over 9 and this breaks.
    charges = [_bill(d, -30.00) for d in ("2026-01-01", "2026-01-10", "2026-01-19", "2026-01-28")]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


def test_a_regular_twenty_day_beat_falls_between_fortnightly_and_monthly(recurring_bills):
    # [A3] median gap 20 sits in the dead band between fortnightly (..16) and monthly (27..).
    # Regular, steady amount, >=3 occurrences — rejected only because no window holds 20.
    charges = [_bill(d, -30.00) for d in ("2026-01-01", "2026-01-21", "2026-02-10", "2026-03-02")]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


def test_a_regular_fifty_day_beat_falls_between_monthly_and_quarterly(recurring_bills):
    # [A4] median gap 50 sits between monthly (..33) and quarterly (85..) → not emitted.
    charges = [_bill(d, -30.00) for d in ("2026-01-01", "2026-02-20", "2026-04-11", "2026-05-31")]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


# --- INTERVAL_TOLERANCE boundary (±25%) ---------------------------------------------------------

def test_a_gap_exactly_at_plus_twentyfive_percent_still_counts(recurring_bills):
    # [A5] gaps [28, 28, 35] → median 28; 35 == 28 + 0.25*28 sits ON the inclusive tolerance edge
    # (_gaps_regular uses <=). Flip that <= to < and the bill vanishes.
    charges = [_bill(d, -50.00) for d in
               ("2026-01-01", "2026-01-29", "2026-02-26", "2026-04-02")]
    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["cadence"] == "monthly"
    assert bill["occurrences"] == 4


def test_a_gap_one_day_past_the_tolerance_is_rejected(recurring_bills):
    # [A6] same series but the last gap is 36 (28 + 8 > 0.25*28) → beat irregular → no bill.
    # Guards the boundary from the OTHER side so [A5] can't pass by the check being a no-op.
    charges = [_bill(d, -50.00) for d in
               ("2026-01-01", "2026-01-29", "2026-02-26", "2026-04-03")]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


# --- AMOUNT_TOLERANCE boundary (±30%) -----------------------------------------------------------

def test_amounts_exactly_at_plus_minus_thirty_percent_still_count(recurring_bills):
    # [A7] magnitudes [70, 100, 130] → median 100; both 70 and 130 sit ON the ±30% edge
    # (_amount_steady uses <=). Tighten to < and the bill drops. typicalAmount is the median 100.
    charges = [_bill("2026-01-05", -70.00), _bill("2026-02-05", -100.00), _bill("2026-03-05", -130.00)]
    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["typicalAmount"] == Decimal("100.00")


def test_amounts_one_cent_past_the_tolerance_are_rejected(recurring_bills):
    # [A8] median 100; 69.99 and 130.01 each sit ONE CENT past the ±30% edge (dev 30.01 > 30.00) →
    # too variable to spread → no bill. Pins the boundary to the cent, the other side of [A7]'s <=.
    charges = [_bill("2026-01-05", -69.99), _bill("2026-02-05", -100.00), _bill("2026-03-05", -130.01)]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


# --- Merchant casing folds into one bucket ------------------------------------------------------

def test_casing_variants_fold_into_one_bill_displayed_as_first_seen(recurring_bills):
    # [A9] "Origin Energy" / "ORIGIN ENERGY" / "origin energy" fold to one bucket (bucket_by_merchant
    # keys on lower()). One bill, occurrences=4, merchant shown in the FIRST-seen casing. Break the
    # fold (bucket on raw name) and this splits into 4 sub-floor buckets → zero bills.
    charges = [
        _bill("2026-01-05", -42.50, merchant="Origin Energy", txn_id="a"),
        _bill("2026-02-05", -42.50, merchant="ORIGIN ENERGY", txn_id="b"),
        _bill("2026-03-05", -42.50, merchant="origin energy", txn_id="c"),
        _bill("2026-04-05", -42.50, merchant="Origin ENERGY", txn_id="d"),
    ]
    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["merchant"] == "Origin Energy"
    assert bill["occurrences"] == 4


# --- Mixed bills and non-bills at the same merchant ---------------------------------------------

def test_a_single_offcycle_charge_at_the_merchant_breaks_the_bill(recurring_bills):
    # [A10] four clean monthly charges PLUS one off-cycle charge (Jan 20) at the SAME merchant. The
    # detector treats every money-out charge at a merchant as one series, so the extra day makes the
    # gaps irregular and the whole bill is rejected. Intended conservative behaviour: a spreading
    # seed needs a clean recurring series, not just a recurring one.
    charges = [
        _bill("2026-01-05", -42.50, txn_id="m1"),
        _bill("2026-01-20", -42.50, txn_id="oneoff"),
        _bill("2026-02-05", -42.50, txn_id="m2"),
        _bill("2026-03-05", -42.50, txn_id="m3"),
        _bill("2026-04-05", -42.50, txn_id="m4"),
    ]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


def test_a_same_day_outlier_amount_pollutes_the_magnitude_series(recurring_bills):
    # [A11] a big same-day charge collapses to one occurrence (distinct days), BUT its magnitude is
    # still counted in _amount_steady (which uses every charge, not distinct days). The -200 breaches
    # ±30% of the 42.50 median → the whole bill is rejected though occurrences would read 4. Intended:
    # an erratic merchant is skipped rather than spread on a wrong amount (see recurring_bills.py).
    charges = [
        _bill("2026-01-05", -42.50, txn_id="m1"),
        _bill("2026-01-05", -200.00, txn_id="outlier"),
        _bill("2026-02-05", -42.50, txn_id="m2"),
        _bill("2026-03-05", -42.50, txn_id="m3"),
        _bill("2026-04-05", -42.50, txn_id="m4"),
    ]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


# --- Degenerate inputs --------------------------------------------------------------------------

def test_empty_input_returns_no_bills(recurring_bills):
    # [A12]
    assert recurring_bills.detect_recurring_bills([]) == {"bills": []}


def test_a_single_charge_is_never_a_bill(recurring_bills):
    # [A13] one charge → below the 3-occurrence floor.
    assert recurring_bills.detect_recurring_bills([_bill("2026-01-05", -42.50)])["bills"] == []


def test_three_charges_on_two_distinct_days_is_below_the_floor(recurring_bills):
    # [A14] three charges but two share a day → 2 DISTINCT days → below MIN_OCCURRENCES. The floor
    # counts distinct days, not rows, so a same-day pair cannot fake the third occurrence.
    charges = [
        _bill("2026-01-05", -42.50, txn_id="a"),
        _bill("2026-01-05", -42.50, txn_id="b"),
        _bill("2026-02-05", -42.50, txn_id="c"),
    ]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


# --- Shape the WHIT-559 consumer reads ----------------------------------------------------------

def test_typical_amount_is_a_positive_decimal(recurring_bills):
    # [A15] typicalAmount must be a positive Decimal in cents (amounts are stored negative). A
    # consumer seeding a spreading plan cannot spread a float or a negative.
    charges = [_bill("2026-01-05", -42.50), _bill("2026-02-05", -42.50), _bill("2026-03-05", -42.50)]
    amount = _only(recurring_bills.detect_recurring_bills(charges))["typicalAmount"]
    assert isinstance(amount, Decimal)
    assert amount > 0
    assert amount == Decimal("42.50")


def test_median_gap_days_is_a_rounded_int_for_an_even_gap_count(recurring_bills):
    # [A16] 3 charges → 2 gaps [14, 15] (even count) → raw median is their mean, 14.5, a fortnightly
    # beat. medianGapDays is reported as a whole-number int: round(14.5) → 14 (banker's rounding to
    # even). The cadence label uses the RAW median, so it stays fortnightly regardless of the round.
    charges = [_bill(d, -30.00) for d in ("2026-01-01", "2026-01-15", "2026-01-30")]
    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["cadence"] == "fortnightly"
    assert bill["medianGapDays"] == 14
    assert isinstance(bill["medianGapDays"], int)
