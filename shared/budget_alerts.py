"""Budget-threshold alert detection on the webhook write path (WHIT-22).

When an ingested transaction pushes a budgeted category's cycle spend across 80%
or 100% of its target, send one Expo push per (category, threshold) per pay cycle.

Two entry points straddle the webhook's `insert_or_reconcile`, both best-effort at
the call site (a failure never breaks the transaction write):
  * `capture_pre_write` — BEFORE the write: snapshot tokens, budget targets, the
    cycle window, the pre-write windowed rows, AND the pending pools reconcile will
    consume. Returns None (skip) when there are no tokens or no budgets.
  * `fire_if_crossed` — AFTER the write succeeds: compute the post-write spend as
    `before + Δ`, where Δ is derived by replaying the write in memory over the
    snapshot (reusing the repo's OWN reconcile primitives), NOT by re-reading the
    date-index GSI (which is eventually consistent and would miss the just-written
    row). Fire on any newly-crossed threshold, debounced via NotifyRepository.

The `before` snapshot still reads the date-index GSI, which is eventually
consistent, so it's biased toward a spurious-extra crossing (deduped by the
marker) rather than a miss. One residual edge remains: right after a settlement
webhook, GSI delete-lag can briefly show BOTH the stale pending and its posted
twin, overstating `before` and rarely SUPPRESSING a true crossing. Accepted as a
best-effort miss (never a lost write); a strongly-consistent `before` is tracked
as follow-up tech debt. For a rolled-up PARENT budget (WHIT-222) this residual
sums across its descendant leaves, so a parent that aggregates several active subs
is marginally more exposed to the miss — still a miss, never a wrong alert.

Spend basis = posted + pending (committed spend). A single write that vaults past
both thresholds sends only the higher (100%) but marks both fired. Mark-on-landing
(WHIT-154): a threshold is marked fired ONLY when its send actually reached Expo
(`send_push(...)["ok"] > 0`) — including the secondary "mark the lower thresholds
too" step, which exists only to suppress a redundant lower nag GIVEN the higher push
went out; if the higher push never landed, suppressing the lower one would silence
the user entirely, so neither is marked.

Unlike the repayment path, this does NOT guarantee a retry. `_simulate_after`
replaces rows by id (not add), and on a re-ingest `before_rows` reads the GSI which
by then already holds the first-ingest write — so the crossing only re-detects while
the GSI still lags (the same brief window the debounce marker guards). For a real
minutes-long Expo outage the GSI has caught up, `before` already sits past the
threshold, `newly` is empty, and nothing re-fires. So the guarantee here is only
"don't falsely record a fired marker", not "retry until delivered"; a persisted
send-failed retry queue would be a separate, larger change.
"""

import logging
from decimal import Decimal

from constants import ACCOUNT_ID_MAP, MAX_PAGE_SIZE, PENDING_STATUS
from push import send_push
from spend import build_category_children, current_cycle_window, descendant_leaves, summarise_transactions

logger = logging.getLogger(__name__)

# (fraction, pct-label), HIGH → LOW so a write that jumps straight past 100% picks
# the 100% alert; both crossed thresholds still get marked fired.
_THRESHOLDS = ((Decimal("1.0"), 100), (Decimal("0.8"), 80))

# Bounded pagination backstop per account (mirrors _fetch_windowed_transactions).
_MAX_PAGES_PER_ACCOUNT = 1000

# Push copy per threshold pct. {name} = the category's display name.
_COPY = {
    80: ("Heads up \U0001f440", "{name} is at 80% of its budget this cycle."),
    100: ("Budget hit \U0001fa93", "You've spent your whole {name} budget for this cycle."),
}


def _window_rows(window_repo, start: str, end: str) -> list[dict]:
    """Every transaction in [start, end] across the mapped accounts, following the
    date-index cursor to completion (bounded)."""
    rows: list[dict] = []
    for account_id in ACCOUNT_ID_MAP.values():
        cursor = None
        pages = 0
        while True:
            page, cursor = window_repo.get_transactions_by_date_range(
                account_id, start, end, limit=MAX_PAGE_SIZE, cursor=cursor
            )
            rows.extend(page)
            pages += 1
            if not cursor:
                break
            if pages >= _MAX_PAGES_PER_ACCOUNT:
                raise RuntimeError(
                    f"budget-alert window read for {account_id} did not terminate "
                    f"after {_MAX_PAGES_PER_ACCOUNT} pages ({start}..{end})"
                )
    return rows


def capture_pre_write(normalised, *, device_repo, budget_repo, paycycle_repo, window_repo, webhook_repo):
    """Snapshot (BEFORE the write) everything `fire_if_crossed` needs. Returns a
    context dict, or None to skip alerting. Short-circuits cheapest-first: no
    registered device tokens → done; no budget targets → done."""
    tokens = device_repo.list_tokens()
    if not tokens:
        return None
    targets = budget_repo.list_budgets()
    if not targets:
        return None

    cycle = paycycle_repo.get_paycycle()
    last_pay_date, length = cycle["last_pay_date"], cycle["length"]
    start, end = current_cycle_window(last_pay_date, length)
    before_rows = _window_rows(window_repo, start, end)

    # Pre-load the pending pools reconcile will consume, so the Δ simulation matches
    # pending twins against the SAME pre-write pool the real write saw (post-write the
    # settled twins are already deleted). Only accounts with a posted row can reconcile.
    accounts = {t["account_id"] for t in normalised if t.get("status") != PENDING_STATUS}
    pending_pools = {a: list(webhook_repo.get_pending_transactions_for_account(a)) for a in accounts}

    return {
        "tokens": tokens, "targets": targets,
        "last_pay_date": last_pay_date, "length": length,
        "start": start, "end": end,
        "before_rows": before_rows, "pending_pools": pending_pools,
    }


def _simulate_after(ctx, normalised, webhook_repo) -> list[dict]:
    """The windowed row set AFTER `insert_or_reconcile` applies `normalised`, built
    in memory from the pre-write snapshot — never a second (GSI-lagging) read. Mirrors
    the reconcile decisions by driving the repo's own `_reconcile_matches` /
    `_with_carried_category`, so it can't drift from the real write — including the
    WHIT-117 two-pass (exact-before-tip across the batch)."""
    by_id = {r["transaction_id"]: r for r in ctx["before_rows"] if r.get("transaction_id") is not None}
    pools = {a: list(rows) for a, rows in ctx["pending_pools"].items()}  # copy: the matcher pops

    # Same two-pass as the real write: resolve twins for the whole batch up front, then
    # replay in `normalised` order so pending-inserts and the resync fallback keep their
    # original interleaving (only the exact-vs-tip decision changed).
    posted_txns = [t for t in normalised if t.get("status") != PENDING_STATUS]
    posted_matches = iter(webhook_repo._reconcile_matches(posted_txns, pools))

    for txn in normalised:
        tid = txn["transaction_id"]
        if txn.get("status") == PENDING_STATUS:
            by_id[tid] = dict(txn)
            continue
        _, match = next(posted_matches, (None, None))  # defensive: over-run -> no-match (see repo)
        if match is not None:
            merged = webhook_repo._with_carried_category(txn, match)
            by_id[merged["transaction_id"]] = dict(merged)
            twin_id = match.get("transaction_id")
            if twin_id is not None and twin_id != merged["transaction_id"]:
                by_id.pop(twin_id, None)
            continue
        existing = by_id.get(tid)
        by_id[tid] = dict(webhook_repo._with_carried_category(txn, existing) if existing is not None else txn)

    # A just-inserted row dated outside the cycle window must not inflate the total.
    start, end = ctx["start"], ctx["end"]
    return [r for r in by_id.values() if start <= (r.get("date") or "") <= end]


def _combined(spend: dict, cat_id: str) -> Decimal:
    entry = spend.get(cat_id)
    return entry["posted"] + entry["pending"] if entry else Decimal(0)


def _combined_target(spend: dict, leaves: set[str]) -> Decimal:
    """A budgeted target's combined spend: the sum over its descendant leaves. A leaf
    or orphan target maps to just itself, so this reduces to `_combined` for a leaf-only
    budget — byte-identical to the pre-rollup behaviour. Seed Decimal(0) so an empty
    leaf set (a corrupt cycle) yields Decimal, not int."""
    return sum((_combined(spend, leaf) for leaf in leaves), Decimal(0))


def fire_if_crossed(ctx, normalised, *, webhook_repo, category_repo, notify_repo) -> None:
    """Given the pre-write context and the just-written batch, send a push for each
    budgeted category whose combined spend newly crossed a threshold this cycle."""
    if ctx is None:
        return
    targets = ctx["targets"]
    categories = category_repo.list_categories()
    names = {c["id"]: c["name"] for c in categories}
    bucket_by_id = {c["id"]: c.get("bucket") for c in categories}
    # Only fire for a target whose category is CURRENTLY live AND a spend ceiling
    # (not an Income or Savings floor). Exclusions, one filter:
    #   * Income buckets are floors (over-is-good), not spend ceilings — the
    #     80/100% "you've spent your budget" push must never fire for them (WHIT-69).
    #   * Savings buckets are floors too — savings is an account balance, not
    #     categorised spend, so a Savings target must never fire either. A discretionary
    #     spend mis-filed into a Savings category would otherwise read as spend against
    #     the target and cross a threshold (WHIT-201).
    #   * A target whose category is GONE (an orphan left by a failed best-effort
    #     delete-cascade, lambda_api/handler.py) can't be classified, so it's dropped
    #     too — otherwise a negative clawback against an orphaned income target would
    #     read as POSITIVE spend (_spend_contribution flips the sign) and fire a false
    #     alert (WHIT-168). A deleted category shouldn't push regardless of its bucket,
    #     and its name would only render as a raw id.
    # A positive membership test (not `set(targets) - income_ids`) is what closes the
    # orphan hole: subtraction kept unknown-category targets in. "Income"/"Savings" are
    # bucket literals — no `constants` import, so no WHIT-136 shared-constant mirror is
    # dragged in. NOTE: list_budgets (the /budgets read) intentionally still sums these
    # as spend; the asymmetry is deliberate — this card is about the false push, and the
    # client hides Savings budget rows (WHIT-201).
    target_ids = {cat_id for cat_id in targets
                  if cat_id in bucket_by_id and bucket_by_id[cat_id] not in ("Income", "Savings")}
    # Sub-categories (WHIT-222): a budgeted PARENT holds no transactions of its own —
    # they land on its leaves — so its spend is the sum over its descendant leaves. This
    # mirrors the /budgets read rollup (lambda_api/handler.py, same helpers) so a parent
    # alert and the Budgets screen never disagree. A leaf/orphan target maps to just
    # itself, so an unbudgeted leaf still feeds its budgeted parent and a leaf-only
    # budget is summed exactly as before. The same-bucket rule keeps a spend parent's
    # subtree all spend, so the spend summariser is correct for every needed leaf.
    children = build_category_children(categories)
    leaves_by_target = {cat_id: descendant_leaves(cat_id, children) for cat_id in target_ids}
    needed_leaves = set().union(*leaves_by_target.values()) if leaves_by_target else set()
    before = summarise_transactions(ctx["before_rows"], needed_leaves)
    after = summarise_transactions(_simulate_after(ctx, normalised, webhook_repo), needed_leaves)

    # (cat_id, pct_to_send, [all newly-crossed pcts]) — pct_to_send is the highest.
    crossings = []
    for cat_id in target_ids:
        target = Decimal(str(targets[cat_id]["target"]))
        if target <= 0:
            continue
        leaves = leaves_by_target[cat_id]
        b, a = _combined_target(before, leaves), _combined_target(after, leaves)
        newly = [pct for frac, pct in _THRESHOLDS if b < frac * target <= a]
        if newly:
            crossings.append((cat_id, newly[0], newly))  # _THRESHOLDS is high→low

    if not crossings:
        return

    last_pay_date, length = ctx["last_pay_date"], ctx["length"]
    fired = notify_repo.fired_markers(last_pay_date, length)

    for cat_id, pct_to_send, newly in crossings:
        send_marker = f"{cat_id}#{pct_to_send}"
        if send_marker in fired:
            landed = True  # already delivered in a prior ingest → repair secondary marks
        else:
            title, body = _COPY[pct_to_send]
            landed = send_push(title, body.format(name=names.get(cat_id, cat_id)), ctx["tokens"])["ok"] > 0
            if landed:
                notify_repo.mark_fired(last_pay_date, length, send_marker)  # mark on landing
        if not landed:
            continue  # send failed → mark nothing → the crossing can re-fire on re-ingest
        # The primary push went out (now or earlier): mark every other newly-crossed
        # threshold too, so a lower one can't alert later this cycle — without sending
        # a second push.
        for pct in newly:
            marker = f"{cat_id}#{pct}"
            if pct != pct_to_send and marker not in fired:
                notify_repo.mark_fired(last_pay_date, length, marker)
