"""One-time backfill: re-anchor stored transaction dates to the swipe day.

The webhook now stores a charge's `date` as the swipe day (BankSync's
`authorizedDate`) rather than the bank's booking/settlement date, so a charge no
longer jumps to its settlement day when it posts. Rows written BEFORE that change
still carry the settlement date, so a charge from a week ago that settled
yesterday still reads "yesterday" until it happens to re-sync. This sweep rewrites
each stored row's `date` to its `authorized_date` when the two differ, so history
matches the go-forward behaviour — for both the transaction list and budget totals.

Only rows that carry a real `authorized_date` are touched; a row without one keeps
its booking date (the same fallback normalise uses), so `date` is never emptied —
the invariant the budget window, the date-index GSI and the age-out sweep depend on.
Rewriting `date` re-puts the item under the SAME pk/sk with every other field
preserved, and DynamoDB re-points the date-index GSI automatically.

Dry-run by DEFAULT: it only reports what it would change. Pass {"dry_run": false}
to actually write. Safe to re-run — once a row's `date` already equals its
`authorized_date` it's skipped, so a second pass is a no-op.

Trigger: invoke the backfill lambda manually (AWS console Test button, or
`aws lambda invoke`). No event source, schedule, or API integration — like the
one-time dedupe cleanup (dedupe_cleanup.py), it reuses the webhook zip and the
transaction_exec role (Query / BatchWriteItem already granted), so no IAM change.
"""

import json
import logging

from constants import ACCOUNT_ID_MAP
from repository import TransactionRepository

logger = logging.getLogger(__name__)


def backfill_account(repo, account_id: str, dry_run: bool) -> dict:
    """Re-anchor one account's stored dates to the swipe day. Returns
    {"scanned", "mismatched", "updated"}.

    `scanned` counts every stored row; `mismatched` counts rows whose stored `date`
    differs from a real `authorized_date`; `updated` counts the ones actually
    rewritten (equals `mismatched` unless dry_run, when it stays 0).
    """
    summary = {"scanned": 0, "mismatched": 0, "updated": 0}
    to_update: list[dict] = []
    for row in repo.get_all_transactions_for_account(account_id):
        summary["scanned"] += 1
        authorized_date = row.get("authorized_date")
        # No swipe date -> the booking date IS the correct fallback; leave it.
        # Already anchored (date == authorized_date) -> nothing to do, which keeps
        # the sweep a no-op on re-run.
        if not authorized_date or authorized_date == row.get("date"):
            continue
        summary["mismatched"] += 1
        logger.info(
            "reanchor account=%s txn=%s date %s -> %s%s",
            account_id, row.get("transaction_id"), row.get("date"), authorized_date,
            " [dry-run]" if dry_run else "",
        )
        if dry_run:
            continue
        updated = dict(row)
        updated["date"] = authorized_date
        to_update.append(updated)

    if to_update:
        # Overwrite in place: insert_transactions rebuilds the same pk/sk from the
        # row's account_id / transaction_id, so this replaces the item (every other
        # field preserved) and the date-index GSI re-points. Batched (BatchWriteItem).
        repo.insert_transactions(to_update)
        summary["updated"] = len(to_update)
    return summary


def backfill_swipe_dates(repo, dry_run: bool = True) -> dict:
    """Sweep every account, re-anchoring stored dates to the swipe day. Returns a
    summary dict."""
    total = {"accounts": 0, "scanned": 0, "mismatched": 0, "updated": 0, "dry_run": dry_run}
    for account_id in sorted(set(ACCOUNT_ID_MAP.values())):
        account_summary = backfill_account(repo, account_id, dry_run)
        total["accounts"] += 1
        for key in ("scanned", "mismatched", "updated"):
            total[key] += account_summary[key]
    logger.info("backfill_swipe_dates summary: %s", total)
    return total


def lambda_handler(event, context):
    """Manual-invoke entrypoint. Dry-run UNLESS the event explicitly says
    {"dry_run": false}, so an accidental/empty invoke never mutates."""
    dry_run = not (isinstance(event, dict) and event.get("dry_run") is False)
    summary = backfill_swipe_dates(TransactionRepository(), dry_run=dry_run)
    return {"statusCode": 200, "body": json.dumps(summary, default=str)}
