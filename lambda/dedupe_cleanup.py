"""One-time cleanup of pre-reconciliation duplicate rows (WHIT-80).

WHIT-77 reconciliation is go-forward only. A charge that settled BEFORE it deployed
has two rows in DynamoDB: a stale (often categorized) pending + an uncategorized
posted carrying a new id. Nothing backfills them, so they show as duplicates in the
feed and the pending's category is orphaned.

This sweep applies the SAME exact-match rule insert_or_reconcile uses live — same
account + authorized_date + EXACT amount — carrying the pending's category onto the
posted (via the repository's own _with_carried_category, so parity is guaranteed)
and deleting the stale pending. Tip-adjusted twins (settled amount grew by a tip)
are deliberately NOT merged here: a batch backfill has more false-merge risk than
the live one-at-a-time path, so those are left for manual review (WHIT-80 decision).

Dry-run by DEFAULT: it only reports what it would do. Pass {"dry_run": false} to
actually write. Safe to re-run — once a pending is deleted, a later pass finds no
twin for it.

Trigger: invoke the dedupe Lambda manually (AWS console Test button, or
`aws lambda invoke`). No event source, schedule, or API integration.
"""

import json
import logging

from constants import ACCOUNT_ID_MAP, PENDING_STATUS
from repository import TransactionRepository

logger = logging.getLogger(__name__)


def dedupe_account(repo, account_id: str, dry_run: bool) -> dict:
    """Dedupe one account's pre-reconciliation twins. Returns {"pairs", "deduped"}.

    `pairs` counts exact pending/posted twins found; `deduped` counts the ones
    actually reconciled (equals `pairs` unless dry_run, when it stays 0).
    """
    rows = repo.get_all_transactions_for_account(account_id)
    pendings = [r for r in rows if r.get("status") == PENDING_STATUS]
    # A TXN row is either pending or posted; anything not pending is the settled side.
    posteds = [r for r in rows if r.get("status") != PENDING_STATUS]

    # Consume-on-match pool: index pendings by (authorized_date, amount); each is
    # claimed at most once, mirroring the live reconcile pool so two identical
    # posteds can't both consume one pending. Skip a pending with no
    # authorized_date — matching on amount alone is too loose (same rule as tier 2).
    pool: dict[tuple, list[dict]] = {}
    for pending in pendings:
        authorized_date = pending.get("authorized_date")
        if authorized_date:
            pool.setdefault((authorized_date, pending.get("amount")), []).append(pending)

    summary = {"pairs": 0, "deduped": 0}
    for posted in posteds:
        authorized_date = posted.get("authorized_date")
        if not authorized_date:
            continue
        bucket = pool.get((authorized_date, posted.get("amount")))
        if not bucket:
            continue
        pending = bucket.pop(0)  # claim exactly one
        summary["pairs"] += 1

        # dedupe_sweep (WHIT-279): the posted here is an EXISTING stored row
        # that may already carry a note/tag the user added AFTER settlement. Fill only
        # notes/tags the posted lacks, so a stale pending twin can't clobber a newer
        # posted note. Category still carries pending->posted (the sweep's core purpose).
        # budget_excluded is posted-authoritative (WHIT-300): never carried, so a charge
        # the user re-included can't be silently re-excluded by a stale pending twin.
        carried = repo._with_carried_category(posted, pending, dedupe_sweep=True)
        # Re-put the posted when ANY carried user field (category, notes, tags,
        # budget_excluded) differs — not category alone, or a note/tag/override on a
        # same-category pending twin would be deleted with the pending and never
        # written to the posted (WHIT-275, WHIT-296).
        changed = any(
            carried.get(field) != posted.get(field)
            for field in ("category", "notes", "tags", "budget_excluded")
        )
        logger.info(
            "twin account=%s posted=%s pending=%s amount=%s category %r -> %r changed=%s%s",
            account_id, posted.get("transaction_id"), pending.get("transaction_id"),
            posted.get("amount"), posted.get("category"), carried.get("category"), changed,
            " [dry-run]" if dry_run else "",
        )
        if dry_run:
            continue

        # Re-put the posted only when a carried field changed; always delete the stale
        # pending (the dedup). Insert BEFORE delete so an interrupted run never loses
        # the carried data (the pending still holds it until the posted has it).
        if changed:
            repo.insert_transactions([carried])
        repo._delete_pending_if_present(pending["pk"], pending["sk"])
        summary["deduped"] += 1

    return summary


def dedupe_pre_reconciliation(repo, dry_run: bool = True) -> dict:
    """Sweep every account for pre-reconciliation twins. Returns a summary dict."""
    total = {"accounts": 0, "pairs": 0, "deduped": 0, "dry_run": dry_run}
    for account_id in sorted(set(ACCOUNT_ID_MAP.values())):
        account_summary = dedupe_account(repo, account_id, dry_run)
        total["accounts"] += 1
        total["pairs"] += account_summary["pairs"]
        total["deduped"] += account_summary["deduped"]
    logger.info("dedupe_pre_reconciliation summary: %s", total)
    return total


def lambda_handler(event, context):
    """Manual-invoke entrypoint (WHIT-80). Dry-run UNLESS the event explicitly says
    {"dry_run": false}, so an accidental/empty invoke never mutates."""
    dry_run = not (isinstance(event, dict) and event.get("dry_run") is False)
    summary = dedupe_pre_reconciliation(TransactionRepository(), dry_run=dry_run)
    return {"statusCode": 200, "body": json.dumps(summary, default=str)}
