"""Age-out sweep for stale pending transactions that never settle (WHIT-79).

WHIT-77 pending->posted reconciliation is go-forward only: it deletes a pending the
moment its matching posted arrives. But some pendings NEVER get a matching posted — a
reversed/cancelled pre-authorisation, or an unbalanced count (two pendings authorised,
only one settles). Nothing reaps those, so they linger forever as ghost rows: a charge
in the feed that never actually happened.

This sweep deletes any pending whose bank `date` is older than PENDING_AGE_OUT_DAYS
(10) with no settlement possible. That threshold is deliberately past FEED_WINDOW_DAYS
(7) — BankSync stops re-sending a transaction after 7 days, so a 10-day-old pending can
no longer receive a settlement re-push and is safe to reap. Age is measured from the
bank `date` (a required "YYYY-MM-DD" string; lexicographic compare is chronological),
NOT `authorized_date` (nullable -> "") and NOT an ingest time (none is stored).

It's window-only by design: a pending still in the store IS unreconciled (a matching
posted would already have deleted it via insert_or_reconcile), so "older than the
window" is sufficient — no separate "confirm no posted twin exists" scan needed.

Dry-run by DEFAULT: an empty/manual invoke only reports what it would reap. The daily
EventBridge schedule passes {"dry_run": false} to run live. A distinct LIVE summary log
line is emitted every real run so a schedule that silently reverted to dry-run (lost
input) is detectable — the sweep is unattended.

Trigger: the age-out Lambda on a daily EventBridge schedule (terraform/scheduler.tf).
"""

import json
import logging
from datetime import date, timedelta

from constants import ACCOUNT_ID_MAP, PENDING_AGE_OUT_DAYS
from repository import TransactionRepository
from repository_errors import DatabaseError
from spend import _melbourne_today

logger = logging.getLogger(__name__)


def _cutoff_date(today: date) -> str:
    """The inclusive lower bound: a pending dated strictly BEFORE this is stale. Returned
    as a "YYYY-MM-DD" string to compare directly against the stored `date` string."""
    return (today - timedelta(days=PENDING_AGE_OUT_DAYS)).isoformat()


def age_out_account(repo, account_id: str, cutoff: str, dry_run: bool) -> dict:
    """Reap one account's pendings older than `cutoff`. Returns {"stale", "reaped", "failed"}.

    `stale` counts pendings past the window; `reaped` counts the ones actually deleted
    (equals `stale` unless dry_run, when it stays 0); `failed` counts pendings whose delete
    raised DatabaseError and were skipped (best-effort — retried on the next daily sweep).
    """
    summary = {"stale": 0, "reaped": 0, "failed": 0}
    for pending in repo.get_pending_transactions_for_account(account_id):
        pending_date = pending.get("date")
        # No age signal, or still inside the window -> never reap. `date == cutoff` is
        # NOT stale (only strictly-older is), so a pending exactly at the boundary lives.
        if not pending_date or pending_date >= cutoff:
            continue
        summary["stale"] += 1
        logger.info(
            "stale pending account=%s txn=%s date=%s (cutoff=%s)%s",
            account_id, pending.get("transaction_id"), pending_date, cutoff,
            " [dry-run]" if dry_run else "",
        )
        if dry_run:
            continue
        try:
            repo._delete_pending_if_present(pending["pk"], pending["sk"])
        except DatabaseError as exc:
            # Best-effort: a throttled/failed DeleteItem on ONE ghost must not strand the
            # remaining ghosts (or every later account) in this unattended run. Log it,
            # count it, carry on — the next daily sweep retries it (a still-present pending
            # re-qualifies, and the delete is idempotent).
            summary["failed"] += 1
            logger.warning(
                "age_out delete FAILED account=%s txn=%s: %s",
                account_id, pending.get("transaction_id"), exc,
            )
            continue
        summary["reaped"] += 1
    return summary


def age_out_stale_pendings(repo, today: date | None = None, dry_run: bool = True) -> dict:
    """Sweep every account for stale pendings. Returns a summary dict.

    `today` is injectable for deterministic tests; defaults to the app's Melbourne
    "today" (shared spend._melbourne_today) — the one clock the rest of the app uses,
    matching the schedule's own Australia/Melbourne timezone."""
    today = today or _melbourne_today()
    cutoff = _cutoff_date(today)
    total = {"accounts": 0, "stale": 0, "reaped": 0, "failed": 0, "dry_run": dry_run, "cutoff": cutoff}
    for account_id in sorted(set(ACCOUNT_ID_MAP.values())):
        account_summary = age_out_account(repo, account_id, cutoff, dry_run)
        total["accounts"] += 1
        total["stale"] += account_summary["stale"]
        total["reaped"] += account_summary["reaped"]
        total["failed"] += account_summary["failed"]
    # A LIVE run gets its own log line (even when it reaps 0), so an unattended schedule
    # that silently reverted to dry-run — reaping nothing forever — is detectable.
    if dry_run:
        logger.info("age_out DRY-RUN summary: %s", total)
    else:
        logger.info(
            "age_out LIVE summary: reaped=%d stale=%d failed=%d accounts=%d cutoff=%s",
            total["reaped"], total["stale"], total["failed"], total["accounts"], cutoff,
        )
        # A live run that found stale ghosts but reaped NONE (every delete failed) is a
        # systemic failure — escalate to ERROR as a high-signal, human-readable summary
        # instead of hiding behind a 200. (The delete-failures alarm itself keys on the
        # per-row "delete FAILED" WARN lines, which are always present when failed > 0.)
        if total["failed"] > 0 and total["reaped"] == 0:
            logger.error(
                "age_out LIVE run reaped 0 of %d stale pendings — ALL deletes failed "
                "(failed=%d). Investigate DynamoDB throttling / IAM.",
                total["stale"], total["failed"],
            )
    return total


def lambda_handler(event, context):
    """Scheduled entrypoint. Dry-run UNLESS the event explicitly says {"dry_run": false},
    so an accidental/empty invoke never mutates; the daily schedule passes that input."""
    dry_run = not (isinstance(event, dict) and event.get("dry_run") is False)
    summary = age_out_stale_pendings(TransactionRepository(), dry_run=dry_run)
    return {"statusCode": 200, "body": json.dumps(summary, default=str)}
