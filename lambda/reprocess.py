"""Manual recovery for dead-lettered transactions (WHIT-55).

When the webhook can't process a BankSync row (e.g. its account wasn't yet in
ACCOUNT_ID_MAP), process_transaction dead-letters the RAW row under pk="FAILED".
After the cause is fixed (the map updated, a bug shipped), this sweep re-drives
each failed row through the normal normalise + insert path and deletes it ONLY
after a successful insert. Rows that still can't process are left in place for a
later run. Safe to run repeatedly — insert_or_reconcile same-id-resyncs an
already-stored row, so recovery neither duplicates nor clobbers a user category.

Trigger: invoke the reprocess Lambda manually (AWS console Test button, or
`aws lambda invoke`). It ignores the event payload.
"""

import json
import logging

from banksync import BankSyncClient
from repository import TransactionRepository

logger = logging.getLogger(__name__)


def reprocess_failed(repo) -> dict:
    """Re-drive every dead-lettered row and return a summary of what happened:
    ``{"reprocessed": n, "skipped": n, "errors": n}``.

    Never raises for a single bad row — a poison row is skipped (left in place) so
    it can't halt recovery for the rows behind it. A row is deleted ONLY after its
    insert durably succeeds, so nothing is lost if the sweep is interrupted.
    """
    rows = repo.get_failed_transactions()
    summary = {"reprocessed": 0, "skipped": 0, "errors": 0}

    for row in rows:
        # Decode the stored raw BankSync row. A missing/undecodable `raw` can never
        # be recovered -> skip (leave it in place), never delete blindly.
        try:
            raw_txn = json.loads(row["raw"])
        except (KeyError, ValueError, TypeError):
            logger.warning("FAILED row %s has no decodable raw payload; skipping", row.get("sk"))
            summary["skipped"] += 1
            continue

        # Re-normalise. If it STILL can't (account unmapped, or any other shape
        # problem the original failure hid — e.g. a bad amount raising
        # decimal.InvalidOperation), leave the row for a later run. Catch broadly:
        # no single poison row may abort the whole sweep.
        try:
            txn = BankSyncClient.normalise(raw_txn)
        except Exception:
            logger.warning("FAILED row %s still cannot be normalised; leaving in place", row.get("sk"))
            summary["skipped"] += 1
            continue

        # Insert, THEN delete the dead-letter — the delete only ever follows a durable
        # insert. A DB error here leaves the row untouched to retry next run.
        try:
            repo.insert_or_reconcile([txn])
            repo.delete_failed_transaction(row["sk"])
            summary["reprocessed"] += 1
        except Exception:
            logger.exception("FAILED row %s could not be reinserted; leaving in place", row.get("sk"))
            summary["errors"] += 1

    logger.info("reprocess_failed summary: %s", summary)
    return summary


def lambda_handler(event, context):
    """Manual-invoke entrypoint (WHIT-55). Ignores the event; runs the sweep and
    returns the summary as the response body."""
    summary = reprocess_failed(TransactionRepository())
    return {"statusCode": 200, "body": json.dumps(summary)}
