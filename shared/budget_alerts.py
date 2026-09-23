"""Budget-threshold alerts on the webhook write path (WHIT-22).

When a budgeted category's cycle spend is at or past 80% or 100% of its target, send one
Expo push per (category, threshold) per pay cycle.

Level, not crossing (WHIT-577): every delivery checks each budget's CURRENT spend and fires
any threshold it has reached that hasn't fired yet this cycle. Firing only when a delivery's
own charges crossed a line missed every budget pushed over in the app — filing by hand,
"Apply my rules", file-by-shop — none of which runs this check. The next delivery, even an
empty sync, now catches those.

Two entry points straddle the webhook's `insert_or_reconcile`, both best-effort at
the call site (a failure never breaks the transaction write):
  * `capture_pre_write` — BEFORE the write: snapshot tokens, budget targets, the
    cycle window, the pre-write windowed rows, AND the pending pools reconcile will
    consume. Returns None (skip) when there are no tokens or no budgets.
  * `fire_budget_alerts` — AFTER the write succeeds: compute the post-write spend by
    replaying the write in memory over the snapshot (reusing the repo's OWN reconcile
    primitives), NOT by re-reading the date-index GSI (which is eventually consistent
    and would miss the just-written row).

The snapshot reads the date-index GSI, which is eventually consistent. Right after a
settlement webhook, GSI delete-lag can briefly show BOTH the stale pending and its posted
twin, overstating spend and rarely firing a threshold a moment early. Accepted: it needs
overlapping deliveries within seconds.

Spend basis = posted + pending (committed spend). A budget past both thresholds sends only
the higher (100%) but marks both. Two or more budgets due in one delivery get ONE combined
push instead of a burst (e.g. the first delivery after hand-filing several budgets over).

Exactly-once: each push's marker is CLAIMED with a conditional write before sending, so two
overlapping deliveries (several feeds sync on the same tick) can't both send it. If the push
doesn't land (`send_push(...)["ok"] == 0`) the claim is RELEASED, so the next delivery retries
(WHIT-154: never record a push that didn't land). A crash between claim and send loses that
one alert for the cycle — accepted as rare.
"""

import logging
from decimal import Decimal

import rule_engine
from constants import ACCOUNT_ID_MAP, MAX_PAGE_SIZE, PENDING_STATUS
from push import send_push
from spend import (
    _spread_state,
    build_category_children,
    current_cycle_window,
    fold_subtree,
    rollover_windows,
    seal_rollover,
    subtree_ids,
    summarise_transactions,
    transactions_in_window,
)

logger = logging.getLogger(__name__)

# (fraction, pct-label), HIGH → LOW so a write that jumps straight past 100% picks
# the 100% alert; both crossed thresholds still get marked fired.
_THRESHOLDS = ((Decimal("1.0"), 100), (Decimal("0.8"), 80))

# Bounded pagination backstop per account (mirrors _fetch_windowed_transactions).
_MAX_PAGES_PER_ACCOUNT = 1000

# Push copy per threshold pct. {name} = the category's display name.
_COPY = {
    80: ("Heads up \U0001f440", "{name} is at 80% of its budget this cycle."),
    100: ("Budget hit", "You've spent your whole {name} budget for this cycle."),
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
    """Snapshot (BEFORE the write) everything `fire_budget_alerts` needs. Returns a
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

    # Rollover: compute the completed-cycle windows each rollover target needs, and
    # widen the single fetch if any look further back than the current cycle. The wider
    # rows are stored separately as `rollover_txns` — `before_rows` stays current-cycle-
    # only so this cycle's spend is never inflated by prior-cycle transactions.
    rollover_ids = {cat_id for cat_id, e in targets.items() if e.get("rollover")}
    windows_by_id = {}
    reanchor_by_id = {}
    fetch_start = start
    for cat_id in rollover_ids:
        windows, reanchor = rollover_windows(targets[cat_id], start, length, last_pay_date)
        windows_by_id[cat_id] = windows
        if reanchor is not None:
            reanchor_by_id[cat_id] = reanchor
        if windows:
            fetch_start = min(fetch_start, windows[0][0])

    all_rows = _window_rows(window_repo, fetch_start, end)
    before_rows = (all_rows if fetch_start == start
                   else transactions_in_window(all_rows, start, end))

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
        "rollover_txns": all_rows,
        "rollover_ids": rollover_ids,
        "windows_by_id": windows_by_id,
        "reanchor_by_id": reanchor_by_id,
    }


def _simulate_after(ctx, normalised, webhook_repo, is_unfiled=None) -> list[dict]:
    """The windowed row set AFTER `insert_or_reconcile` applies `normalised`, built
    in memory from the pre-write snapshot — never a second (GSI-lagging) read. Mirrors
    the reconcile decisions by driving the repo's own `_reconcile_matches` /
    `_with_carried_category`, so it can't drift from the real write — including the
    WHIT-117 two-pass (exact-before-tip across the batch).

    `is_unfiled` (WHIT-545) is passed only to the first-settlement carry, matching the
    real write: the re-send / pending-resync paths go through `_update_bank_fields`, which
    never gates the stored category or recomputes the flag, so gating them here would drift."""
    by_id = {r["transaction_id"]: r for r in ctx["before_rows"] if r.get("transaction_id") is not None}
    pools = {a: list(rows) for a, rows in ctx["pending_pools"].items()}  # copy: the matcher pops

    # Same tier passes as the real write: resolve twins for the whole batch up front, then
    # replay in `normalised` order so pending-inserts and the resync fallback keep their
    # original interleaving. A posted row already stored under its own id is a RE-SEND and
    # is held out of the twin search, exactly as insert_or_reconcile holds it out — letting
    # it match would consume a pending the real write leaves alone (WHIT-331).
    posted_txns = [t for t in normalised if t.get("status") != PENDING_STATUS]
    posted_matches = iter(webhook_repo._reconcile_matches(
        [t for t in posted_txns if t["transaction_id"] not in by_id], pools))

    # The real write inserts everything, THEN deletes the stale pendings, so a pending
    # re-send that arrives in the same payload as its own settlement does not survive.
    # Popping twins inline would let that re-send re-add itself and double-count.
    consumed_twin_ids: set[str] = set()

    for txn in normalised:
        tid = txn["transaction_id"]
        if txn.get("status") == PENDING_STATUS:
            # Mirror the real write's pending re-sync carry (WHIT-329): keep the user's
            # category/notes/tags/budget_excluded so the preview can't drift from the
            # stored row and fire (or suppress) an alert on the wrong category.
            existing = by_id.get(tid)
            if existing is not None:
                by_id[tid] = dict(webhook_repo._with_carried_category(txn, existing))
            else:
                by_id[tid] = dict(txn)
            continue
        existing = by_id.get(tid)
        if existing is not None:
            # A re-send: carry the user's fields off the stored row, never match a twin.
            merged = webhook_repo._with_carried_category(txn, existing)
            webhook_repo._inherit_swipe_date(merged, txn, existing)  # parity with the real write
            by_id[tid] = dict(merged)
            continue
        _, match = next(posted_matches, (None, None))  # defensive: over-run -> no-match (see repo)
        if match is not None:
            merged = webhook_repo._with_carried_category(txn, match, is_unfiled=is_unfiled)
            webhook_repo._inherit_swipe_date(merged, txn, match)  # parity with the real write
            by_id[merged["transaction_id"]] = dict(merged)
            twin_id = match.get("transaction_id")
            if twin_id is not None and twin_id != merged["transaction_id"]:
                consumed_twin_ids.add(twin_id)
        else:
            by_id[tid] = dict(txn)

    for twin_id in consumed_twin_ids:
        by_id.pop(twin_id, None)

    # A just-inserted row dated outside the cycle window must not inflate the total.
    start, end = ctx["start"], ctx["end"]
    return [r for r in by_id.values() if start <= (r.get("date") or "") <= end]


def _combined_target(spend: dict, ids: set[str]) -> Decimal:
    """A budgeted target's combined spend: the signed net over its whole subtree (the
    target itself plus every descendant), posted and pending summed UNCLAMPED across the
    subtree and each clamped once. `spend` is the per-id summary from a `clamp=False`
    call, so a net-negative sibling nets against the rest before the floor — matching
    /budgets' aggregate-then-clamp so an alert can't disagree with the screen (WHIT-343).
    A leaf or orphan target maps to just itself. Seed Decimal(0) so an empty set (a
    corrupt cycle) yields Decimal, not int; an id absent from `spend` contributes 0."""
    folded = fold_subtree(spend, ids)
    return folded["posted"] + folded["pending"]


def fire_budget_alerts(ctx, normalised, *, webhook_repo, category_repo, notify_repo) -> None:
    """Given the pre-write context and the just-written batch, push for every budgeted
    category whose combined spend has reached a threshold not yet fired this cycle."""
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
    # Sub-categories (WHIT-222, WHIT-228): a budgeted PARENT's spend is the sum over its
    # whole subtree — the parent itself plus every descendant at any depth. Summing the
    # parent id too counts a transaction tagged directly onto the parent (the picker
    # allows it), so a parent alert and the Budgets screen never disagree — both use these
    # same helpers (lambda_api/handler.py). A leaf/orphan target maps to just itself, so an
    # unbudgeted leaf still feeds its budgeted parent and a leaf-only budget is summed
    # exactly as before. The same-bucket rule keeps a spend parent's subtree all spend, so
    # the spend summariser is correct for every needed id.
    children = build_category_children(categories)
    ids_by_target = {cat_id: subtree_ids(cat_id, children, bucket_by_id) for cat_id in target_ids}
    needed_ids = set().union(*ids_by_target.values()) if ids_by_target else set()
    # WHIT-545: mirror the write's settlement carry gate, so the preview buckets a charge
    # under the category that will actually land. Built from the categories already read
    # above; a best-effort second read of the taxonomy, like the write's own.
    taxonomy_ids = {c["id"] for c in categories}

    def is_unfiled(category):
        return rule_engine.is_unfiled_category(category, taxonomy_ids)

    # Unclamped per id (clamp=False) so _combined_target can net a refunded sibling
    # across the subtree before clamping the total — aggregate-then-clamp, WHIT-343.
    after = summarise_transactions(
        _simulate_after(ctx, normalised, webhook_repo, is_unfiled), needed_ids, clamp=False
    )

    # (cat_id, pct_to_send, [every reached pct]) — pct_to_send is the highest.
    due = []
    rollover_ids = ctx.get("rollover_ids", set())
    for cat_id in target_ids:
        entry = targets[cat_id]
        target = Decimal(str(entry["target"]))
        # Fold BOTH smoothing cushions into the threshold basis so the push agrees with the
        # /budgets screen's spendable (WHIT-504 spread, WHIT-555 rollover). Same helpers + same
        # args as list_budgets, so the two can't disagree. The two cushions are mutually exclusive
        # on real data (a category is rollover OR spread); rollover wins if a corrupt row has both,
        # matching set_budget which strips spread when rollover turns on.
        # Read-only: _spread_state's finished/reanchor and seal_rollover's persist are ignored;
        # the /budgets read owns persistence and re-derives the same state on every GET.
        buffer_term = Decimal(0)
        adjustment_term = Decimal(0)
        if cat_id in rollover_ids:
            if cat_id in ctx.get("reanchor_by_id", {}):
                buffer_term = ctx["reanchor_by_id"][cat_id]["carryover"]
            else:
                windows = ctx.get("windows_by_id", {}).get(cat_id, [])
                if windows:
                    buffer_term, _ = seal_rollover(
                        entry, windows, ids_by_target[cat_id],
                        ctx["rollover_txns"], ctx["length"], ctx["end"])
                else:
                    buffer_term = entry.get("carryover", Decimal(0))
        if "spread_amount" in entry and cat_id not in rollover_ids:
            spread_row, _, _ = _spread_state(
                entry, ctx["start"], ctx["length"], ctx["last_pay_date"], ctx["end"])
            if spread_row is not None:
                adjustment_term = spread_row["adjustment"]
        basis = target + buffer_term + adjustment_term
        # basis <= 0 (a payback slice bigger than the whole target) would read every threshold
        # as reached at $0 spend. Such a cycle reads over-budget on screen but sends no push — a
        # push the user couldn't act on — a deliberate, defensible silence.
        if basis <= 0:
            continue
        spend = _combined_target(after, ids_by_target[cat_id])
        reached = [pct for frac, pct in _THRESHOLDS if frac * basis <= spend]
        if reached:
            due.append((cat_id, reached[0], reached))  # _THRESHOLDS is high→low

    if not due:
        return

    # Debounce markers key on the CURRENT cycle's start (ctx["start"], the rolled-forward
    # payday that current_cycle_window computed for the spend read above), NOT the raw stored
    # last_pay_date. Keying on last_pay_date meant the marker pk never changed once the user's
    # saved payday went stale — so a threshold fired once and then stayed suppressed for the
    # whole NOTIFY_TTL (60 days) across every later cycle, instead of re-arming each cycle. The
    # spend window already rolls forward per payday; the marker must roll with it.
    cycle_start, length = ctx["start"], ctx["length"]
    fired = notify_repo.fired_markers(cycle_start, length)

    claimed = []
    for cat_id, pct_to_send, reached in due:
        send_marker = f"{cat_id}#{pct_to_send}"
        if send_marker in fired:
            _mark_lower_thresholds(notify_repo, cycle_start, length, cat_id, pct_to_send, reached, fired)
            continue
        if notify_repo.claim_fired(cycle_start, length, send_marker):
            claimed.append((cat_id, pct_to_send, reached))
    if not claimed:
        return

    title, body, data = _push_copy(claimed, names)
    landed = send_push(title, body, ctx["tokens"], data=data)["ok"] > 0
    for cat_id, pct_to_send, reached in claimed:
        if landed:
            # Mark the lower reached thresholds too, so a lower one can't nag later this cycle.
            _mark_lower_thresholds(notify_repo, cycle_start, length, cat_id, pct_to_send, reached, fired)
        else:
            notify_repo.release_fired(cycle_start, length, f"{cat_id}#{pct_to_send}")


def _mark_lower_thresholds(notify_repo, cycle_start, length, cat_id, pct_to_send, reached, fired) -> None:
    for pct in reached:
        marker = f"{cat_id}#{pct}"
        if pct != pct_to_send and marker not in fired:
            notify_repo.mark_fired(cycle_start, length, marker)


# How many budget names a combined push lists before "+N more".
_COMBINED_NAMES_SHOWN = 3


def _push_copy(claimed, names) -> tuple[str, str, dict]:
    """One budget: its own copy and a deep link to it (WHIT-322). Several: one combined push
    naming them, which opens the app — so a single delivery never buzzes once per budget."""
    if len(claimed) == 1:
        cat_id, pct, _ = claimed[0]
        title, body = _COPY[pct]
        return title, body.format(name=names.get(cat_id, cat_id)), {"type": "budget", "category": cat_id}
    labels = sorted(names.get(cat_id, cat_id) for cat_id, _, _ in claimed)
    shown = ", ".join(labels[:_COMBINED_NAMES_SHOWN])
    hidden = len(labels) - _COMBINED_NAMES_SHOWN
    if hidden > 0:
        shown = f"{shown} +{hidden} more"
    title = f"{len(labels)} budgets need a look"
    body = f"{shown} are at 80% or more of their budget this cycle."
    return title, body, {"type": "budget"}
