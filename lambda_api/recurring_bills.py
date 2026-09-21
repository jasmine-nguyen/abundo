"""Detect recurring bills from transaction history — amount + cadence (prereq for WHIT-559).

WHIT-559 ("a rule auto-spreads a recurring bill") needs two things a rule cannot supply on its
own: how much the bill is, and how often it lands. Neither exists anywhere today — a rule holds
matching text + a category, and a spread plan is seeded by user-typed numbers. This module is
that missing signal: given a user's charges, it returns each recurring bill it can find as
`{merchant, typicalAmount, cadence, ...}`, ready for the WHIT-559 consumer to turn into a category
spread plan.

Sibling of filing_habits (WHIT-542): pure logic, no I/O, on-demand scan, no new stored state — the
handler owns the scan. It reuses `bucket_by_merchant` (WHIT-515) so a merchant is folded here
exactly as the merchant screen and the habit miner fold it, and `is_number` (WHIT-327) so a
malformed amount is skipped, never crashed on.

Two passes. Named merchants fold through `bucket_by_merchant` (WHIT-515). Nameless bank direct
debits — an OSKO transfer with no merchant name — fold through the description-stem pass
`_bucket_nameless_by_stem` (WHIT-519), the same seam the unfiled-merchant screen uses (WHIT-569).
The nameless match is fuzzier, so it demands more occurrences and a tighter amount before a bill
auto-spreads real money; the two passes see disjoint charges (blank vs named merchant), so nothing
is counted twice.

Cadence stops at a label + the median gap. The map from a cadence to a "how many pay cycles"
count belongs with the WHIT-559 consumer, which knows the user's pay-cycle length
(`get_paycycle()["length"]`); keeping it out here leaves the detector pure and pay-cycle-agnostic.
"""

from datetime import date as date_type
from decimal import ROUND_HALF_UP, Decimal

from merchant_groups import (
    bucket_by_merchant,
    _bucket_nameless_by_stem,
    _rule_value_for_stem_bucket,
)
from repayment_rules import is_number

# How many times a merchant must be billed before it counts as recurring. Three occurrences is the
# floor: it gives two gaps, the minimum needed to judge whether the beat is regular. Local, not a
# constants.py value — filing_habits keeps its own floor the same way, and it sidesteps the
# lambda_api/constants.py-shadows-the-shared-layer landmine (WHIT-136).
MIN_OCCURRENCES = 3

# How far each gap between charges may sit from the median gap before the beat reads as irregular.
# 0.25 = ±25%: month-length wobble (28 vs 31 days ≈ 10%) passes; a skipped cycle (a ~doubled gap)
# fails, so a bill with a missed month is rejected rather than mis-timed — conservative on purpose
# for a spread seed.
INTERVAL_TOLERANCE = 0.25

# How far each charge amount may sit from the median amount before the bill reads as too variable
# to spread. Decimal (not float) so it multiplies the Decimal amounts without a type clash. 0.30 =
# ±30%: a utility that drifts month to month still counts; genuinely variable spend does not.
AMOUNT_TOLERANCE = Decimal("0.30")

# The nameless (description-stem) pass is fuzzier than the named one — a description like "DIRECT
# DEBIT" can pool distinct bills — so it demands MORE evidence before a bill auto-spreads real money
# (WHIT-569): one extra occurrence and half the amount wobble. Named merchants keep the looser floor.
NAMELESS_MIN_OCCURRENCES = 4
NAMELESS_AMOUNT_TOLERANCE = Decimal("0.15")

# Median day-gap → cadence label. Each window is a band around the nominal gap wide enough for the
# calendar's own wobble (short months, weekends nudging a debit). A median gap in no band → the
# beat is real but not a cadence we name → not emitted.
_CADENCE_WINDOWS = (
    ("weekly", 6, 8),
    ("fortnightly", 12, 16),
    ("monthly", 27, 33),
    ("quarterly", 85, 95),
)


def _text(value) -> str:
    return str(value or "")


def _parse_date(value):
    """The charge's ISO date as a date, or None when it is missing or unparseable — skipped, never
    a crash (same tolerance is_number gives a bad amount)."""
    if not value:
        return None
    try:
        return date_type.fromisoformat(str(value))
    except ValueError:
        return None


def _median(values):
    """Median of a non-empty list. Even count → the mean of the two middle values, so an even
    number of amounts can yield a half-cent (quantised away by the caller) and an even number of
    gaps a half-day."""
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def _is_bill_charge(transaction: dict) -> bool:
    """A charge we can build a bill from: money OUT (amount < 0, so a recurring salary credit is
    never a bill), a finite amount, and a parseable date. is_number short-circuits before the
    comparison so a Decimal('NaN') is never compared with 0."""
    amount = transaction.get("amount")
    return (
        is_number(amount)
        and amount < 0
        and _parse_date(transaction.get("date")) is not None
    )


def _gaps_regular(gaps: list, median_gap) -> bool:
    """Does every gap sit within INTERVAL_TOLERANCE of the median gap? A doubled gap (a missed
    cycle) falls outside and fails the whole bill."""
    if median_gap <= 0:
        return False
    return all(abs(gap - median_gap) <= INTERVAL_TOLERANCE * median_gap for gap in gaps)


def _cadence_for_gap(median_gap):
    """The cadence label whose window holds the median gap, or None when none does."""
    for label, low, high in _CADENCE_WINDOWS:
        if low <= median_gap <= high:
            return label
    return None


def _amount_steady(magnitudes: list, tolerance: Decimal) -> bool:
    """Do all charge magnitudes sit within `tolerance` of their median? A fixed-ish bill passes;
    genuinely variable spend at one merchant does not. The nameless pass passes a tighter tolerance
    than the named one (WHIT-569)."""
    median_amount = _median(magnitudes)
    if median_amount <= 0:
        return False
    return all(abs(magnitude - median_amount) <= tolerance * median_amount
               for magnitude in magnitudes)


def _to_cents(amount: Decimal) -> Decimal:
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _bill_from_bucket(bucket: list[dict], identity: str | None = None,
                      min_occurrences: int = MIN_OCCURRENCES,
                      amount_tolerance: Decimal = AMOUNT_TOLERANCE):
    """The recurring bill a bucket's charges describe, or None when they are too few, too
    irregular, on no cadence we name, or too variable in amount.

    `identity` is the bill's "merchant" label. The named pass leaves it None → the merchant name
    of the first bill-charge (as first seen). The nameless pass (WHIT-569) passes the description
    stem, and tightens `min_occurrences` / `amount_tolerance` for its fuzzier match."""
    bill_charges = [transaction for transaction in bucket if _is_bill_charge(transaction)]
    charge_days = sorted({_parse_date(transaction.get("date")) for transaction in bill_charges})
    if len(charge_days) < min_occurrences:
        return None

    gaps = [(charge_days[index] - charge_days[index - 1]).days
            for index in range(1, len(charge_days))]
    median_gap = _median(gaps)
    if not _gaps_regular(gaps, median_gap):
        return None
    cadence = _cadence_for_gap(median_gap)
    if cadence is None:
        return None

    # Every charge counts toward steadiness — NOT collapsed per day the way the cadence gaps are.
    # So a merchant with an erratic same-day one-off (a fee, a top-up) fails the steadiness check
    # and is skipped, even when its cadence is clean. That is deliberate: a spread seed needs a
    # clean, predictable series, and skipping an erratic merchant is the safe failure. Teasing "the
    # bill" apart from one-offs at one merchant is a bigger job, left to a later refinement.
    # Decimal(str(...)) coerces int/float/Decimal amounts to a precise Decimal (amounts are Decimal
    # in this system; the coercion keeps a stray int/float exact rather than binary-float fuzzy).
    magnitudes = [abs(Decimal(str(transaction["amount"]))) for transaction in bill_charges]
    if not _amount_steady(magnitudes, amount_tolerance):
        return None

    if identity is None:
        identity = _text(bill_charges[0].get("merchant_name")).strip()
    return {
        "merchant": identity,
        "typicalAmount": _to_cents(_median(magnitudes)),
        "cadence": cadence,
        # Reported as a whole number of days for a stable int type (an even gap-count median is a
        # half-day); the cadence match above uses the raw median, so rounding here changes nothing.
        "medianGapDays": round(median_gap),
        "occurrences": len(charge_days),
    }


def _named_bills(transactions: list[dict]) -> list[dict]:
    """The recurring bills among charges that carry a merchant name, keyed by that name."""
    bills = []
    for bucket in bucket_by_merchant(transactions).values():
        bill = _bill_from_bucket(bucket)
        if bill is not None:
            bills.append(bill)
    return bills


def _nameless_bills(transactions: list[dict]) -> list[dict]:
    """The recurring bills among NAMELESS charges (bank direct debits), keyed by description stem
    (WHIT-569). Only blank-merchant rows are considered — bucket_by_merchant already owns the named
    ones — so the two passes partition the charges and never double-count. The stricter
    occurrence/amount floors fight the stem's fuzzier match, and the stem stands in for the merchant.
    """
    nameless = [transaction for transaction in transactions
                if not _text(transaction.get("merchant_name")).strip()]
    bills = []
    for bucket in _bucket_nameless_by_stem(nameless).values():
        identity = _rule_value_for_stem_bucket(bucket)
        if identity is None:
            continue
        bill = _bill_from_bucket(bucket, identity=identity,
                                 min_occurrences=NAMELESS_MIN_OCCURRENCES,
                                 amount_tolerance=NAMELESS_AMOUNT_TOLERANCE)
        if bill is not None:
            bills.append(bill)
    return bills


def detect_recurring_bills(transactions: list[dict]) -> dict:
    """The recurring bills in a user's charges, strongest first.

    Two passes: named merchants (bucket_by_merchant) and nameless bank direct debits keyed by
    description stem (WHIT-569). A bill is one identity billed on >= its pass's occurrence floor
    distinct days at a regular, nameable cadence with a steady-ish amount. Each carries the identity
    (merchant name as first seen, or the stem), the typical amount (median magnitude, positive,
    quantised to cents so the WHIT-559 consumer can seed a spread plan with no re-rounding), the
    cadence label, the median day-gap, and the occurrence count. Sorted most-occurrences-first, ties
    broken on the identity, so the order is stable and a test can assert it.
    """
    bills = _named_bills(transactions) + _nameless_bills(transactions)
    bills.sort(key=lambda bill: (-bill["occurrences"], bill["merchant"]))
    return {"bills": bills}
