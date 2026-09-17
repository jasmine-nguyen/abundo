"""Adversarial gap tests for the NAMELESS (description-stem) recurring-bill pass — WHIT-569.

detect_recurring_bills runs two passes: named merchants and nameless bank direct debits keyed by
description stem. The implementer's suites lock the nameless happy path, the 4-vs-3 occurrence floor,
the ±20%-drift rejection, the named/nameless partition, and (in _gaps) an unusable/all-numeric stem,
two distinct stems, and a nameless credit.

This suite hunts the nameless edges those miss: cadence variety beyond monthly, the EXACT ±15%
amount boundary (mirror of the named ±30% [A7]/[A8]), stem casing folding (mirror of named [A9]),
a stem that drops below the alphanumeric floor after the trailing reference is trimmed, interior-vs-
trailing reference trimming, cross-pass tie ordering, and cent quantisation on the nameless path.

Pure logic — imported in isolation via the `recurring_bills` fixture (tests/lambda_api/conftest.py).
"""

from decimal import Decimal

from _feed_fakes import ANZ, _row


def _bill(date, amount, merchant="TELSTRA", txn_id=None, **extra):
    return _row(ANZ, date, txn_id or f"{merchant}-{date}-{amount}", merchant_name=merchant,
                description=f"{merchant} DIRECT DEBIT", amount=Decimal(str(amount)), **extra)


def _nameless(date, amount, description="OSKO PAYMENT 447112", txn_id=None, **extra):
    return _row(ANZ, date, txn_id or f"n-{date}-{amount}-{description}", merchant_name="",
                description=description, amount=Decimal(str(amount)), **extra)


def _only(result):
    assert len(result["bills"]) == 1, result["bills"]
    return result["bills"][0]


# --- Nameless cadence variety (not just monthly) ------------------------------------------------

def test_a_nameless_fortnightly_direct_debit_is_detected(recurring_bills):
    # [N1] WHIT-569: the nameless pass names a ~14-day beat "fortnightly" too, not only monthly.
    charges = [_nameless(d, -30.00) for d in
               ("2026-01-01", "2026-01-15", "2026-01-29", "2026-02-12")]
    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["merchant"] == "OSKO PAYMENT"
    assert bill["cadence"] == "fortnightly"
    assert bill["occurrences"] == 4


def test_a_nameless_quarterly_direct_debit_is_detected(recurring_bills):
    # [N2] A ~91-day nameless beat maps to "quarterly" through the shared cadence helper.
    charges = [_nameless(d, -260.00) for d in
               ("2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01")]
    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["cadence"] == "quarterly"
    assert bill["occurrences"] == 4


# --- Nameless AMOUNT tolerance boundary (±15%) — mirror of named [A7]/[A8] -----------------------

def test_nameless_amounts_exactly_at_plus_minus_fifteen_percent_still_count(recurring_bills):
    # [N3] magnitudes [85, 100, 100, 115] → median 100; both 85 and 115 sit ON the ±15% edge
    # (_amount_steady uses <=). typicalAmount is the median 100. The named pass would take this
    # trivially; the nameless pass only just does — tighten NAMELESS_AMOUNT_TOLERANCE below 0.15
    # and it drops.
    amounts = (-85.00, -100.00, -115.00, -100.00)
    charges = [_nameless(f"2026-{m}-05", a)
               for m, a in zip(("01", "02", "03", "04"), amounts)]
    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["typicalAmount"] == Decimal("100.00")
    assert bill["cadence"] == "monthly"


def test_nameless_amounts_one_cent_past_fifteen_percent_are_rejected(recurring_bills):
    # [N4] median 100; 84.99 and 115.01 each sit ONE CENT past the ±15% edge (dev 15.01 > 15.00) →
    # too variable for the stricter nameless floor → no bill. This SAME drift passes the named
    # ±30% pass, so it pins the nameless tolerance specifically. FAIL-ON-REVERT: widen
    # NAMELESS_AMOUNT_TOLERANCE to 0.30 and this wrongly emits.
    amounts = (-84.99, -100.00, -115.01, -100.00)
    charges = [_nameless(f"2026-{m}-05", a)
               for m, a in zip(("01", "02", "03", "04"), amounts)]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


# --- Nameless stem casing folds into one bucket — mirror of named [A9] ---------------------------

def test_nameless_stem_casing_variants_fold_into_one_bill(recurring_bills):
    # [N5] the same direct debit whose description casing wobbles month to month folds to ONE stem
    # bucket (_bucket_nameless_by_stem keys on strip().lower()). One bill, occurrences=4, identity
    # the commonest stem spelling. Break the fold (bucket on raw case) and this splits into four
    # size-1 buckets, each below MIN_DESCRIPTION_GROUP_SIZE → zero bills.
    charges = [
        _nameless("2026-01-05", -42.50, description="osko payment 1101"),
        _nameless("2026-02-05", -42.50, description="OSKO PAYMENT 1102"),
        _nameless("2026-03-05", -42.50, description="Osko Payment 1103"),
        _nameless("2026-04-05", -42.50, description="OSKO payment 1104"),
    ]
    bill = _only(recurring_bills.detect_recurring_bills(charges))
    assert bill["merchant"].lower() == "osko payment"
    assert bill["occurrences"] == 4


# --- Nameless stem that drops below the alphanumeric floor after the trailing trim ---------------

def test_a_nameless_stem_below_the_alphanumeric_floor_is_not_a_bill(recurring_bills):
    # [N6] "DD 1300 655 506" → trailing reference tokens trimmed → "DD" (2 alnum < the 4-char
    # rule-value floor) → no rulable stem → the charge never buckets → no bill, even on a clean
    # monthly beat. Distinct from [A17] (all-numeric, no letter): here a LETTER survives but the
    # value is still too thin. FAIL-ON-REVERT: drop MIN_RULE_VALUE_ALPHANUMERICS below 2 and "DD"
    # becomes rulable → a phantom bill emits.
    charges = [_nameless(f"2026-{m}-05", -42.50, description="DD 1300 655 506")
               for m in ("01", "02", "03", "04")]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


def test_only_the_trailing_reference_is_trimmed_so_an_interior_wobble_splits(recurring_bills):
    # [N7] Trailing-only trim: only the tail reference goes, interior tokens stay. A series whose
    # INTERIOR number differs each month ("KMART 0421 ONLINE 88" → stem "KMART 0421 ONLINE") yields
    # a DIFFERENT stem per month, so nothing folds and no bill emits. Documents (and guards) that
    # the stem is not a fuzzy match — only "KMART 0421 ONLINE 88/89/90…" (trailing wobble) would
    # fold. Conservative: a false negative here, never a false pool.
    charges = [_nameless(f"2026-{month}-05", -42.50, description=f"KMART 04{ref} ONLINE 88")
               for month, ref in zip(("01", "02", "03", "04"), ("21", "22", "23", "24"))]
    assert recurring_bills.detect_recurring_bills(charges)["bills"] == []


# --- Cross-pass ordering -------------------------------------------------------------------------

def test_a_named_and_a_nameless_bill_tie_on_occurrences_sort_by_identity(recurring_bills):
    # [N8] Named bills are concatenated BEFORE nameless ones, then the whole list is sorted. With
    # equal occurrence counts (4 each), a nameless "OSKO PAYMENT" must sort before a named
    # "TELSTRA" on the identity string alone — proving the tie-break is the identity, not the pass
    # order. FAIL-ON-REVERT: drop bill["merchant"] from the sort key and Python's stable sort keeps
    # the named bill first → order flips to [TELSTRA, OSKO PAYMENT].
    named = [_bill(f"2026-{m}-05", -30.00, merchant="TELSTRA")
             for m in ("01", "02", "03", "04")]
    nameless = [_nameless(f"2026-{m}-18", -75.00) for m in ("01", "02", "03", "04")]

    bills = recurring_bills.detect_recurring_bills(named + nameless)["bills"]
    assert [bill["merchant"] for bill in bills] == ["OSKO PAYMENT", "TELSTRA"]
    assert [bill["occurrences"] for bill in bills] == [4, 4]


# --- Cent quantisation on the nameless path ------------------------------------------------------

def test_the_nameless_pass_quantises_a_half_cent_median_to_cents(recurring_bills):
    # [N9] The nameless pass runs through the SAME _bill_from_bucket, so its typicalAmount is
    # quantised to cents. Magnitudes [10.02, 10.02, 10.03, 10.03] → median 10.025 → ROUND_HALF_UP →
    # 10.03 (a whole number of cents, so the WHIT-559 consumer never re-rounds).
    amounts = (-10.02, -10.03, -10.02, -10.03)
    charges = [_nameless(f"2026-{m}-05", a)
               for m, a in zip(("01", "02", "03", "04"), amounts)]
    assert _only(recurring_bills.detect_recurring_bills(charges))["typicalAmount"] == Decimal("10.03")
