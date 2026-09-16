"""Detect recurring bills from transaction history — amount + cadence (prereq for WHIT-559).

WHIT-559 ("a rule auto-smooths a recurring bill") needs two things a rule cannot supply on its
own: how much the bill is, and how often it lands. Neither exists anywhere today — a rule holds
matching text + a category, and a smoothing plan is seeded by user-typed numbers. This module is
that missing signal: given a user's charges, it returns each recurring bill it can find as
`{merchant, typicalAmount, cadence, ...}`, ready for the WHIT-559 consumer to turn into a category
smoothing plan.

Sibling of filing_habits (WHIT-542): pure logic, no I/O, on-demand scan, no new stored state — the
handler owns the scan. It reuses `bucket_by_merchant` (WHIT-515) so a merchant is folded here
exactly as the merchant screen and the habit miner fold it, and `is_number` (WHIT-327) so a
malformed amount is skipped, never crashed on.

Named merchants only (WHIT-559 spike, decision A). A recurring charge with no merchant name — an
OSKO / direct-debit transfer — is not bucketed here (`bucket_by_merchant` skips it), so a nameless
direct debit is a known miss. Catching those needs the fuzzier description-stem pass merchant_groups
uses for the unfiled screen, and lands as its own follow-up so its false-positive risk is reviewed
on its own.

Cadence stops at a label + the median gap. The map from a cadence to a "how many pay cycles"
count belongs with the WHIT-559 consumer, which knows the user's pay-cycle length
(`get_paycycle()["length"]`); keeping it out here leaves the detector pure and pay-cycle-agnostic.
"""

from datetime import date as date_type
from decimal import ROUND_HALF_UP, Decimal

from merchant_groups import bucket_by_merchant
from repayment_rules import is_number

# How many times a merchant must be billed before it counts as recurring. Three occurrences is the
# floor: it gives two gaps, the minimum needed to judge whether the beat is regular. Local, not a
# constants.py value — filing_habits keeps its own floor the same way, and it sidesteps the
# lambda_api/constants.py-shadows-the-shared-layer landmine (WHIT-136).
MIN_OCCURRENCES = 3

# How far each gap between charges may sit from the median gap before the beat reads as irregular.
# 0.25 = ±25%: month-length wobble (28 vs 31 days ≈ 10%) passes; a skipped cycle (a ~doubled gap)
# fails, so a bill with a missed month is rejected rather than mis-timed — conservative on purpose
# for a smoothing seed.
INTERVAL_TOLERANCE = 0.25

# How far each charge amount may sit from the median amount before the bill reads as too variable
# to smooth. Decimal (not float) so it multiplies the Decimal amounts without a type clash. 0.30 =
# ±30%: a utility that drifts month to month still counts; genuinely variable spend does not.
AMOUNT_TOLERANCE = Decimal("0.30")

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


def _amount_steady(magnitudes: list) -> bool:
    """Do all charge magnitudes sit within AMOUNT_TOLERANCE of their median? A fixed-ish bill
    passes; genuinely variable spend at one merchant does not."""
    median_amount = _median(magnitudes)
    if median_amount <= 0:
        return False
    return all(abs(magnitude - median_amount) <= AMOUNT_TOLERANCE * median_amount
               for magnitude in magnitudes)


def _to_cents(amount: Decimal) -> Decimal:
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _bill_from_bucket(bucket: list[dict]):
    """The recurring bill a merchant's charges describe, or None when they are too few, too
    irregular, on no cadence we name, or too variable in amount."""
    bill_charges = [transaction for transaction in bucket if _is_bill_charge(transaction)]
    charge_days = sorted({_parse_date(transaction.get("date")) for transaction in bill_charges})
    if len(charge_days) < MIN_OCCURRENCES:
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
    # and is skipped, even when its cadence is clean. That is deliberate: a smoothing seed needs a
    # clean, predictable series, and skipping an erratic merchant is the safe failure. Teasing "the
    # bill" apart from one-offs at one merchant is a bigger job, left to a later refinement.
    # Decimal(str(...)) coerces int/float/Decimal amounts to a precise Decimal (amounts are Decimal
    # in this system; the coercion keeps a stray int/float exact rather than binary-float fuzzy).
    magnitudes = [abs(Decimal(str(transaction["amount"]))) for transaction in bill_charges]
    if not _amount_steady(magnitudes):
        return None

    return {
        "merchant": _text(bill_charges[0].get("merchant_name")).strip(),
        "typicalAmount": _to_cents(_median(magnitudes)),
        "cadence": cadence,
        # Reported as a whole number of days for a stable int type (an even gap-count median is a
        # half-day); the cadence match above uses the raw median, so rounding here changes nothing.
        "medianGapDays": round(median_gap),
        "occurrences": len(charge_days),
    }


def detect_recurring_bills(transactions: list[dict]) -> dict:
    """The recurring bills in a user's charges, strongest first.

    One bill per named merchant billed on >= MIN_OCCURRENCES distinct days at a regular, nameable
    cadence with a steady-ish amount. Each carries the merchant name (as first seen), the typical
    amount (median magnitude, positive, quantised to cents so the WHIT-559 consumer can seed a
    spread plan with no re-rounding), the cadence label, the median day-gap, and the occurrence
    count. Sorted most-occurrences-first, ties broken on merchant, so the order is stable and a
    test can assert it.
    """
    bills = [bill for bill in (_bill_from_bucket(bucket)
                               for bucket in bucket_by_merchant(transactions).values())
             if bill is not None]
    bills.sort(key=lambda bill: (-bill["occurrences"], bill["merchant"]))
    return {"bills": bills}
