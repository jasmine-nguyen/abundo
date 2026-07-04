"""Pay-cycle window + per-category spend summariser — the single source shared by
the /budgets & /breakdown read API (lambda_api) and the budget-alert detection on
the webhook write path (WHIT-22).

Lives in the shared layer so BOTH lambdas compute the cycle window and the
spent/pending contribution rule identically — the alert can never disagree with
the /budgets screen about what a category has spent this cycle. Moved here from
lambda_api/handler.py (WHIT-106 established the single-source contribution rule;
WHIT-22 needed it reachable from the webhook). Imports POSTED_STATUS/PENDING_STATUS
from the shared constants (present in both constants files per the WHIT-136 guard).
"""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from constants import PENDING_STATUS, POSTED_STATUS

_MELBOURNE = None  # ZoneInfo("Australia/Melbourne"), built lazily on first use.


def _melbourne_today() -> date:
    """Today's date in the user's timezone (Australia/Melbourne), so the budget
    window resets at LOCAL midnight on payday, not UTC midnight.

    Built lazily and cached. If the tzdata package is ever missing from the layer,
    ZoneInfo raises here (only the budget path, not at module import). We catch that
    and FAIL SAFE to UTC: /budgets keeps working with a reset that's off by at most
    a day at the UTC/Melbourne seam, rather than 500ing the whole budget path. Melbourne
    observes DST (+10/+11) so a fixed offset isn't a substitute for the tz database
    — UTC is only the degraded fallback, and the WARN makes the packaging gap loud.
    """
    global _MELBOURNE
    if _MELBOURNE is None:
        try:
            _MELBOURNE = ZoneInfo("Australia/Melbourne")
        except ZoneInfoNotFoundError:
            print("WARN: tzdata unavailable in layer; budget window falling back to UTC today")
            return datetime.now(timezone.utc).date()
    return datetime.now(_MELBOURNE).date()


def current_cycle_window(last_pay_date: str, length: int, today: date | None = None) -> tuple[str, str]:
    """Return (start, end) ISO dates for the CURRENT pay cycle: the inclusive
    window [cycle_start, today] that resets on the user's payday.

    `cycle_start` is the most recent payday on or before today — the latest
    `last_pay_date + k*length` days (integer k >= 0) that is <= today. `today` defaults
    to the Melbourne-local date (injectable for deterministic tests). Both bounds are
    inclusive: transaction `date` is stored date-only (YYYY-MM-DD) and the date-range
    query uses DynamoDB `between`, which is inclusive on both ends, so `end = today`
    covers all of today's spend while excluding tomorrow's (WHIT-75 — a `today+1` end
    used to leak a transaction dated tomorrow into the cycle). cycle_start is inclusive,
    so payday spend lands in the fresh cycle.

    A future last_pay_date has no valid k (Slice 1 rejects one at write, but stay safe):
    max(0, ...) plus the cycle_start>today clamp keep the window from inverting (they
    collapse it to the single inclusive day [today, today]).
    """
    if today is None:
        today = _melbourne_today()
    pay_date = date.fromisoformat(last_pay_date)
    elapsed_days = (today - pay_date).days
    cycles_elapsed = max(0, elapsed_days // length)
    cycle_start = pay_date + timedelta(days=cycles_elapsed * length)
    if cycle_start > today:
        cycle_start = today
    end = today
    return cycle_start.isoformat(), end.isoformat()


def _spend_contribution(transaction: dict) -> tuple[str, Decimal] | None:
    """The (bucket, spend) a transaction adds to a budget summary, or None if it
    doesn't count. Shared by summarise_transactions and summarise_uncategorized:
    they differ only in WHICH categories they roll up, not in how a contributing
    transaction maps to a bucket + amount.

    Contributes only if `counts_to_budget` is truthy and `status` is a known
    pending/posted (an unknown status is skipped, never guessed). Spend is stored
    as a NEGATIVE amount, so the returned spend is `-amount` — a refund (positive
    amount) yields a negative contribution that reduces the total; callers clamp
    each bucket at >= 0.
    """
    if not transaction.get("counts_to_budget"):
        return None
    status = transaction.get("status")
    if status == PENDING_STATUS:
        bucket = "pending"
    elif status == POSTED_STATUS:
        bucket = "posted"
    else:
        return None  # unknown status -> don't guess a bucket
    return bucket, -Decimal(str(transaction.get("amount", 0)))


def summarise_transactions(transactions: list[dict], target_ids: set[str]) -> dict[str, dict]:
    """Sum posted vs pending spend per budgeted category over `transactions`.

    A transaction contributes only if it counts toward a budget (see
    `_spend_contribution`) AND its `category` is a real budgeted id (not None, not
    "income", and present in `target_ids`). Each bucket is clamped at >= 0 so a net
    refund can't drive a bar negative. Pending vs posted is decided by the
    transaction's own `status`, so a pending->posted settlement needs no special
    handling: the next call just re-reads the current status.

    Returns {category_id: {"posted": Decimal, "pending": Decimal}} for categories
    that had at least one contributing transaction.
    """
    totals: dict[str, dict] = {}
    for transaction in transactions:
        category = transaction.get("category")
        if category is None or category == "income" or category not in target_ids:
            continue
        contribution = _spend_contribution(transaction)
        if contribution is None:
            continue
        bucket, spend = contribution
        entry = totals.setdefault(category, {"posted": Decimal(0), "pending": Decimal(0)})
        entry[bucket] += spend
    for entry in totals.values():
        entry["posted"] = max(Decimal(0), entry["posted"])
        entry["pending"] = max(Decimal(0), entry["pending"])
    return totals


def summarise_uncategorized(transactions: list[dict], taxonomy_ids: set[str]) -> dict:
    """Sum posted vs pending spend that counts to budget but has no home in the
    taxonomy: a raw BankSync category (e.g. "MEDICAL"), a deleted category's
    dangling id, or a null category. The complement of what summarise_transactions
    rolls up — same contribution rule (counts_to_budget, spend is a NEGATIVE
    amount) and the same >= 0 clamp. The income sentinel ("income") is excluded,
    matching the client's isUncategorized so the two views agree.

    Returns {"posted": Decimal, "pending": Decimal}, both >= 0.
    """
    totals = {"posted": Decimal(0), "pending": Decimal(0)}
    for transaction in transactions:
        category = transaction.get("category")
        if category == "income" or category in taxonomy_ids:
            continue
        contribution = _spend_contribution(transaction)
        if contribution is None:
            continue
        bucket, spend = contribution
        totals[bucket] += spend
    totals["posted"] = max(Decimal(0), totals["posted"])
    totals["pending"] = max(Decimal(0), totals["pending"])
    return totals
