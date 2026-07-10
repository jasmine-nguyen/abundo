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

from collections.abc import Callable
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


def nth_prior_cycle_window(cycle_start: str, length: int, n: int) -> tuple[str, str]:
    """Return (start, end) ISO dates for the Nth full pay cycle BEFORE the one that
    begins at `cycle_start` (n >= 1).

    Each prior window is a full `length`-day span that abuts the next with no overlap
    or gap: the 1st prior is [cycle_start - length, cycle_start - 1], the 2nd steps back
    another `length`, and so on — the same stepping the AI-insight trend already walks
    (WHIT-104), extracted here so /breakdown and the insight share one implementation
    (WHIT-68). Both bounds are inclusive, matching the DynamoDB `between` date query.

    `cycle_start` is the CURRENT cycle's start, already derived from the pay cycle (e.g.
    by `current_cycle_window`). It's passed in — not recomputed from last_pay_date — so
    the caller's single clock read is authoritative and this stays a pure date function
    (deterministic in tests). The current window comes from `current_cycle_window`, not
    here, so n < 1 is a caller bug and raises rather than returning an inverted window.
    """
    if n < 1:
        raise ValueError(f"nth_prior_cycle_window needs n >= 1, got {n}")
    start = date.fromisoformat(cycle_start)
    prior_start = start - timedelta(days=n * length)
    prior_end = start - timedelta(days=(n - 1) * length + 1)
    return prior_start.isoformat(), prior_end.isoformat()


def _spend_contribution(transaction: dict, sign: int = -1) -> tuple[str, Decimal] | None:
    """The (bucket, amount) a transaction adds to a budget summary, or None if it
    doesn't count. Shared by summarise_transactions, summarise_uncategorized and
    summarise_income: they differ only in WHICH categories they roll up and the
    direction of the amount, not in how a contributing transaction maps to a bucket.

    Contributes only if `counts_to_budget` is truthy and `status` is a known
    pending/posted (an unknown status is skipped, never guessed).

    `sign` flips the stored amount into a positive contribution:
      * spend (default `sign=-1`): stored NEGATIVE, so `-amount` is positive spend —
        a refund (positive amount) yields a negative contribution that reduces it.
      * income (`sign=+1`): stored POSITIVE, so `+amount` is positive earnings —
        a reversal/clawback (negative amount) reduces it.
    Callers clamp each bucket at >= 0.
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
    return bucket, sign * Decimal(str(transaction.get("amount", 0)))


def _summarise(
    transactions: list[dict],
    *,
    keep: Callable[[str | None], bool],
    key: Callable[[str | None], str],
    sign: int = -1,
) -> dict[str, dict]:
    """The one summing loop shared by the three public summarisers (WHIT-167).

    For each transaction: gate on `keep(category)`, map it to a result bucket via
    `key(category)`, turn it into a posted/pending contribution via
    `_spend_contribution(transaction, sign=sign)`, accumulate, then clamp every
    bucket at >= 0 (a net refund/reversal can't drive a bar negative). The three
    public functions differ ONLY in `keep` (which categories count), `key` (per-id
    vs a single aggregate bucket), and `sign` (spend is -amount, income is +amount);
    the clamp + accumulation rule lives here so a change to it can't drift between them.

    Returns {key(category): {"posted": Decimal, "pending": Decimal}} for keys that had
    at least one contributing transaction. Insertion order follows first contribution.
    """
    totals: dict[str, dict] = {}
    for transaction in transactions:
        category = transaction.get("category")
        if not keep(category):
            continue
        contribution = _spend_contribution(transaction, sign=sign)
        if contribution is None:
            continue
        bucket, amount = contribution
        entry = totals.setdefault(key(category), {"posted": Decimal(0), "pending": Decimal(0)})
        entry[bucket] += amount
    for entry in totals.values():
        entry["posted"] = max(Decimal(0), entry["posted"])
        entry["pending"] = max(Decimal(0), entry["pending"])
    return totals


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
    return _summarise(
        transactions,
        keep=lambda category: category is not None and category != "income" and category in target_ids,
        key=lambda category: category,
    )


def summarise_uncategorized(transactions: list[dict], taxonomy_ids: set[str]) -> dict:
    """Sum posted vs pending spend that counts to budget but has no home in the
    taxonomy: a raw BankSync category (e.g. "MEDICAL"), a deleted category's
    dangling id, or a null category. The complement of what summarise_transactions
    rolls up — same contribution rule (counts_to_budget, spend is a NEGATIVE
    amount) and the same >= 0 clamp. The income sentinel ("income") is excluded,
    matching the client's isUncategorized so the two views agree.

    Returns {"posted": Decimal, "pending": Decimal}, both >= 0 — a single aggregate
    (every contributor folds into one bucket), not a per-category dict.
    """
    totals = _summarise(
        transactions,
        keep=lambda category: category != "income" and category not in taxonomy_ids,
        key=lambda category: "__all__",
    )
    return totals.get("__all__", {"posted": Decimal(0), "pending": Decimal(0)})


def summarise_income(transactions: list[dict], income_ids: set[str]) -> dict[str, dict]:
    """Sum posted vs pending EARNINGS per income-target category over `transactions`
    — the earn-target counterpart of summarise_transactions (WHIT-69).

    Income earn-targets are floors (over-is-good), so this rolls up the POSITIVE
    amount (`sign=+1`) rather than spend. A transaction contributes only if it counts
    to budget (see `_spend_contribution`) AND its `category` is in `income_ids` — the
    ids of the user's Income-bucket categories that carry a target. Unlike the spend
    summariser it does NOT special-case the raw "income" sentinel: income *categories*
    have their own ids (never the sentinel), and gating purely on `income_ids`
    membership is the correct filter (a user category that happens to slug to "income"
    is a real target and must count). Each bucket is clamped at >= 0 so a reversal
    can't drive an earnings bar negative.

    Returns {category_id: {"posted": Decimal, "pending": Decimal}} for categories
    that had at least one contributing transaction — the same shape as
    summarise_transactions, so a caller can merge the two uniformly.
    """
    return _summarise(
        transactions,
        keep=lambda category: category in income_ids,
        key=lambda category: category,
        sign=1,
    )


def build_category_children(categories: list[dict]) -> dict[str, list[str]]:
    """A parent-id -> [child ids] map from the taxonomy (each category carries a
    `parent`, None for top-level). The inverse of the stored `parent` link, built
    once so a rollup can walk down the tree without rescanning the list per node.
    Categories with no children simply never appear as a key.
    """
    children: dict[str, list[str]] = {}
    for category in categories:
        parent = category.get("parent")
        if parent is not None:
            children.setdefault(parent, []).append(category["id"])
    return children


def subtree_ids(root_id: str, children: dict[str, list[str]],
                bucket_by_id: dict[str, str] | None = None) -> set[str]:
    """Every category id whose spend rolls into a budget on `root_id`: the root
    itself PLUS every descendant at any depth — intermediate sub-categories and
    leaves alike — given a prebuilt `children` map (from build_category_children).

    A budgeted parent's spend is the sum over this whole set, because a
    transaction can be tagged onto ANY node: a leaf, an intermediate sub, or the
    parent itself (the categorize picker offers all of them). Counting the entire
    subtree — not just the leaves — is what keeps /budgets, the over-budget alerts
    and the AI roll-up in agreement with the /breakdown screen (WHIT-228): each of
    them sums a parent's spend over this set.

    When `bucket_by_id` is given, the result is restricted to ids in the SAME bucket
    as `root_id` (the root is always kept). This matches the client's roll-up, which
    only folds a category into a budget when their buckets agree (WHIT-229): a sub
    corruptly filed under a parent of a different bucket must not count toward it —
    and, in particular, an Income sub can never inflate a spend parent. The walk still
    descends through a cross-bucket node so a SAME-bucket descendant beneath it is
    kept (the filter is on membership, not on descent) — matching the client, which
    still rolls such a descendant up under a same-bucket ancestor rather than dropping
    it. This is a per-target set: as with every roll-up here, each budgeted target sums
    its OWN same-bucket subtree independently, so if two same-bucket ancestors are both
    budgeted a shared descendant counts toward each bar (the hero de-dup across
    overlapping budgets is a client concern, WHIT-221). On clean data (every descendant
    shares the root's bucket) nothing is dropped, so the set — and every downstream
    /budgets, alert and AI total — is byte-identical.

    A leaf, or an orphan id absent from the taxonomy, rolls up as just `{root_id}`
    — byte-identical to summing that id on its own, so a flat leaf budget (and a
    budgeted parent with no direct spend) is unchanged. Cycle-safe via `visited`:
    single-parent data can't form a legitimate diamond, so `visited` only guards a
    corrupt stored cycle, which yields the nodes on the cycle once each rather than
    an infinite walk.
    """
    visited: set[str] = set()
    stack = [root_id]
    while stack:
        node = stack.pop()
        if node in visited:
            continue
        visited.add(node)
        kids = children.get(node)
        if kids:
            stack.extend(kids)
    if bucket_by_id is None:
        return visited
    # Filter the full subtree to the root's bucket (root always kept). Filtering the
    # RESULT, not the descent, keeps a same-bucket descendant that sits UNDER a
    # cross-bucket intermediate — matching the client's nearest-same-bucket-ancestor rule.
    root_bucket = bucket_by_id.get(root_id)
    return {node for node in visited
            if node == root_id or bucket_by_id.get(node) == root_bucket}
