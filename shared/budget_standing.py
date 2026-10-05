"""Each budget's standing this pay cycle, worked out once (WHIT-622).

Pure: budget targets + pay cycle + categories + charges in → one row per budget
(target, posted, pending, carryover, spread, available) plus the settlements to save.
/budgets, the budget alerts and the chat all call it, so they can't disagree.

Two steps, because the caller has to read transactions in between:
1. `standing_window` — the date maths: the current cycle and how far back to read so
   every rollover budget can fold its completed cycles.
2. `budget_standing` — the maths over the charges read for that window.

`budget_spend` is the posted/pending fold alone, over any window (the cycle export's
past cycles, WHIT-703).

Row rules:
- posted/pending are the CURRENT cycle only [cycle_start, today].
- A budget on an Income-bucket category is an earn-target: posted/pending are positive
  earnings (WHIT-69). Any other (or unknown) bucket is spend.
- A parent budget sums its whole subtree, netting every id before the floor at zero
  (WHIT-228, WHIT-343).
- Rollover and bill spread apply to spend categories only: a flag left on a category
  later moved to Income/Savings is ignored. Only a rollover row carries
  `rollover`/`carryover`; only a spread row carries `spread`. Rollover wins if a corrupt
  row has both, so `available` never sums two cushions.
- A rollover row also lists the cycles behind its carryover (`carryover_cycles`, newest
  first, still-settling ones flagged) and `carryover_earlier`, the part from before
  history was kept, so the cycles plus the remainder add up to `carryover` (WHIT-742).
"""

from decimal import Decimal
from typing import NamedTuple

from constants import INCOME_BUCKET, SAVINGS_BUCKET
from spend import (
    build_category_children,
    current_cycle_window,
    fold_subtree,
    rollover_history_view,
    rollover_windows,
    seal_rollover,
    spread_state,
    subtree_ids,
    summarise_income,
    summarise_transactions,
    transactions_in_window,
    unified_available,
)


class StandingWindow(NamedTuple):
    cycle_start: str
    today: str
    length: int
    last_pay_date: str
    fetch_start: str
    windows_by_id: dict
    reanchor_by_id: dict


def standing_window(targets: dict, pay_cycle: dict, today=None) -> StandingWindow:
    """The current cycle, plus how far back to read transactions.

    Rollover windows are worked out for every rollover-flagged target, whatever its
    bucket, so this needs no categories (the alerts call it before a write). A stale flag
    on a re-bucketed category can only widen the read; it never changes a number.
    """
    length = pay_cycle["length"]
    last_pay_date = pay_cycle["last_pay_date"]
    cycle_start, today_iso = current_cycle_window(last_pay_date, length, today)
    windows_by_id = {}
    reanchor_by_id = {}
    fetch_start = cycle_start
    for cat_id, entry in targets.items():
        if not entry.get("rollover"):
            continue
        windows, reanchor = rollover_windows(entry, cycle_start, length, last_pay_date)
        windows_by_id[cat_id] = windows
        if reanchor is not None:
            reanchor_by_id[cat_id] = reanchor
        if windows:
            fetch_start = min(fetch_start, windows[0][0])
    return StandingWindow(cycle_start, today_iso, length, last_pay_date, fetch_start,
                          windows_by_id, reanchor_by_id)


def _subtrees(targets: dict, categories: list) -> tuple[dict, dict]:
    """(bucket_by_id, ids_by_target): each category's bucket, and each target's subtree ids."""
    bucket_by_id = {c["id"]: c.get("bucket") for c in categories}
    children = build_category_children(categories)
    ids_by_target = {cat_id: subtree_ids(cat_id, children, bucket_by_id) for cat_id in targets}
    return bucket_by_id, ids_by_target


def _fold_spend(ids_by_target: dict, bucket_by_id: dict, transactions: list) -> dict:
    """{cat_id: {"posted", "pending"}} for each target over `transactions`.

    Sum every needed id once (unclamped), fold per target, then clamp the target total
    once, so a net-negative sibling nets against the rest before the floor (WHIT-343).
    """
    needed_ids = set().union(*ids_by_target.values()) if ids_by_target else set()
    income_ids = {cid for cid in needed_ids if bucket_by_id.get(cid) == INCOME_BUCKET}
    spend_ids = needed_ids - income_ids

    per_id = summarise_transactions(transactions, spend_ids, clamp=False)
    per_id.update(summarise_income(transactions, income_ids, clamp=False))
    return {cat_id: fold_subtree(per_id, ids) for cat_id, ids in ids_by_target.items()}


def budget_spend(targets: dict, categories: list, transactions: list) -> dict:
    """Each budget's {"posted", "pending"} over `transactions`, whatever window they cover.

    The same subtree fold and Income earn-target rule as `budget_standing`, with no
    rollover or spread.
    """
    bucket_by_id, ids_by_target = _subtrees(targets, categories)
    return _fold_spend(ids_by_target, bucket_by_id, transactions)


def budget_standing(targets: dict, window: StandingWindow, categories: list,
                    transactions: list) -> tuple[dict, dict]:
    """Each budget's row this cycle, plus the settlements to save.

    `transactions` must be exactly the rows dated `window.fetch_start..window.today`: when
    no rollover widened the read, they ARE the current cycle and are summed as-is. Returns
    (rows, settlements) where settlements is
    {"rollover": {cat_id: {carryover, carryover_from[, carryover_history]}}, "spread_finished": [cat_id],
     "spread_reanchored": {cat_id: plan}}.
    """
    cycle_start = window.cycle_start
    today = window.today
    length = window.length
    bucket_by_id, ids_by_target = _subtrees(targets, categories)

    rollover_ids = {
        cat_id for cat_id, entry in targets.items()
        if entry.get("rollover") and bucket_by_id.get(cat_id) not in (INCOME_BUCKET, SAVINGS_BUCKET)
    }
    spread_ids = {
        cat_id for cat_id, entry in targets.items()
        if "spread_amount" in entry and bucket_by_id.get(cat_id) not in (INCOME_BUCKET, SAVINGS_BUCKET)
    }

    current = transactions
    if window.fetch_start != cycle_start:
        current = transactions_in_window(transactions, cycle_start, today)

    spend_by_id = _fold_spend(ids_by_target, bucket_by_id, current)

    rollover_settlements = {}
    finished_spreads = []
    reanchored_spreads = {}
    rows = {}
    for cat_id, entry in targets.items():
        folded = spend_by_id[cat_id]
        row = {
            "target": entry["target"],
            "posted": folded["posted"],
            "pending": folded["pending"],
        }
        buffer_term = Decimal(0)
        adjustment_term = Decimal(0)
        if cat_id in rollover_ids:
            if cat_id in window.reanchor_by_id:
                carryover = window.reanchor_by_id[cat_id]["carryover"]
                cycles, earlier = rollover_history_view(entry.get("carryover_history", []), carryover)
                rollover_settlements[cat_id] = window.reanchor_by_id[cat_id]
            else:
                carryover, cycles, earlier, persist = seal_rollover(
                    entry, window.windows_by_id[cat_id], ids_by_target[cat_id], transactions, length, today
                )
                if persist is not None:
                    rollover_settlements[cat_id] = persist
            row["rollover"] = True
            row["carryover"] = carryover
            row["carryover_cycles"] = cycles
            row["carryover_earlier"] = earlier
            buffer_term = carryover
        if cat_id in spread_ids:
            spread_row, finished, reanchor = spread_state(entry, cycle_start, length, window.last_pay_date, today)
            if spread_row is not None:
                row["spread"] = spread_row
                if cat_id not in rollover_ids:
                    adjustment_term = spread_row["adjustment"]
            if finished:
                finished_spreads.append(cat_id)
            if reanchor is not None:
                reanchored_spreads[cat_id] = reanchor
        row["available"] = unified_available(entry["target"], buffer_term, adjustment_term)
        rows[cat_id] = row

    settlements = {
        "rollover": rollover_settlements,
        "spread_finished": finished_spreads,
        "spread_reanchored": reanchored_spreads,
    }
    return rows, settlements
