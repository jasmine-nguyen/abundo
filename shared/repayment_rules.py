"""The shared "stored home-loan repayment leg" rule (WHIT-325).

One source of truth for "is this stored row a home-loan repayment credit?": an
incoming-transfer credit with a positive numeric amount and a date. Called by the
balance poller's miss-detector and the read API's get_repayment, so the rule can't
drift between the two.

Deliberately does NOT apply the $10 MIN_REPAYMENT_NOTIFY alert floor — that is the
poller's "worth an alert" filter, applied at its own call site, so the read API still
returns sub-$10 repayments. A malformed row (missing/non-numeric amount, no date) is
skipped, never a crash.
"""

from decimal import Decimal

from constants import REPAYMENT_INCOMING_TYPE


def is_repayment_credit(row: dict) -> bool:
    """True for a stored home-loan repayment leg: an incoming-transfer credit with a
    positive numeric amount and a date. No alert floor — see module docstring."""
    if row.get("type") != REPAYMENT_INCOMING_TYPE or not row.get("date"):
        return False
    amount = row.get("amount")
    if not isinstance(amount, (int, float, Decimal)):
        return False
    return amount > 0
