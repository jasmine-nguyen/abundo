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

import rule_engine
from constants import ACCOUNT_ID_MAP, PENDING_AGE_OUT_DAYS
from repository import TransactionRepository, _merchant_matches_pending
from repository_category import CategoryRepository
from repository_errors import DatabaseError
from spend import _melbourne_today

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# WHIT-511: how far apart a filed pending and its settled twin may be dated and still be
# rescued. Deliberately TIGHTER than reconcile's FEED_WINDOW_DAYS (7): the rescue carries a
# user's category, so it must be strict — a symmetric ±3 days is generous for the usual
# swipe→settle lag while keeping a coincidental same-amount charge from being swept in. The
# accepted cost is a twin that settled 4–7 days after the swipe is not rescued (reaped as today).
_CARRY_DATE_SKEW_DAYS = 3


def _cutoff_date(today: date) -> str:
    """The inclusive lower bound: a pending dated strictly BEFORE this is stale. Returned
    as a "YYYY-MM-DD" string to compare directly against the stored `date` string."""
    return (today - timedelta(days=PENDING_AGE_OUT_DAYS)).isoformat()


def _within_days(date_a: str | None, date_b: str | None, days: int) -> bool:
    """Whether two bare "YYYY-MM-DD" dates are at most `days` apart (symmetric). A missing or
    unparseable date is never within — the rescue then finds no twin and reaps as today."""
    if not date_a or not date_b:
        return False
    try:
        parsed_a = date.fromisoformat(date_a[:10])
        parsed_b = date.fromisoformat(date_b[:10])
    except ValueError:
        return False
    return abs((parsed_a - parsed_b).days) <= days


def _load_is_unfiled(category_repo):
    """Build the "is this category unfiled" test from the user's taxonomy, or None when it
    can't be read. None DISABLES the rescue — the sweep then reaps exactly as before, so a
    category-store outage never blocks the ghost cleanup (fail-open, mirroring
    rule_ingest.load_rules). A bank charge carries a raw category that isn't in the taxonomy,
    so only this test — not category-presence — tells a real filing from the bank default."""
    if category_repo is None:
        return None
    try:
        taxonomy_ids = {category["id"] for category in category_repo.list_categories()}
    except Exception:
        logger.exception("age_out: could not read taxonomy; rescue disabled, reaping as usual")
        return None
    return lambda category: rule_engine.is_unfiled_category(category, taxonomy_ids)


def _pending_is_filed(pending: dict, is_unfiled) -> bool:
    """Whether the user actually filed this pending — a real category, OR a note/tag/exclusion
    they set. These are the user-owned fields _with_carried_category carries (plus filed_by_rule,
    which never exists without a category and so is already covered by the category check), so
    losing any of them to the reap is the harm WHIT-511 fixes."""
    if not is_unfiled(pending.get("category")):
        return True
    return bool(pending.get("notes") or pending.get("tags") or pending.get("budget_excluded"))


def _find_carry_twin(pending: dict, unfiled_posted: list[dict]) -> dict | None:
    """The settled twin to carry a filed pending's fields onto, or None. STRICT: same exact
    amount, same shop (the reconcile merchant gate), and dated within _CARRY_DATE_SKEW_DAYS.
    Exactly one match carries; zero OR an ambiguous tie (≥2) carries nothing — a wrong carry
    is worse than a missed one (WHIT-511, Jasmine's locked choice)."""
    matches = [posted for posted in unfiled_posted if _is_carry_twin(pending, posted)]
    if len(matches) == 1:
        return matches[0]
    return None


def _is_carry_twin(pending: dict, posted: dict) -> bool:
    """Whether `posted` is strictly the settled twin of `pending` — exact amount, same shop,
    dates within the window.

    Amount must match EXACTLY. The reconciler pairs a tip-adjusted settlement via its own tip
    tier (repository._is_tip_adjusted), but the rescue deliberately does NOT — carrying a
    user's category is kept strict, so the amount gate is not widened to a tip range. The
    accepted cost: a tipped charge (dining/rideshare) that missed ALL six reconcile tiers is
    not rescued at reap time. This is a narrow miss (it already had to miss the tip tier), and
    the strict gate is the safety Jasmine chose over widening the match (WHIT-511)."""
    if pending.get("amount") != posted.get("amount"):
        return False
    if not _merchant_matches_pending(
        posted.get("merchant_name") or "",
        pending.get("merchant_name") or "",
        pending.get("description") or "",
    ):
        return False
    return _within_days(pending.get("date"), posted.get("date"), _CARRY_DATE_SKEW_DAYS)


def age_out_account(repo, account_id: str, cutoff: str, dry_run: bool, is_unfiled=None) -> dict:
    """Reap one account's pendings older than `cutoff`. Returns {"stale", "reaped", "failed",
    "rescued"}.

    `stale` counts pendings past the window; `reaped` counts the ones actually deleted (equals
    `stale` unless dry_run, when it stays 0); `failed` counts pendings whose write/delete raised
    DatabaseError and were skipped (best-effort — retried on the next daily sweep); `rescued`
    counts pendings whose filing was carried onto a settled twin before the reap (a subset of
    `reaped`).

    WHIT-511: when `is_unfiled` is provided, a pending the USER filed is not reaped blind — its
    settled twin is found and the user's fields are carried onto it first, so the filing survives
    and the charge is not counted twice. `is_unfiled=None` (taxonomy unavailable) reaps exactly
    as before.
    """
    summary = {"stale": 0, "reaped": 0, "failed": 0, "rescued": 0}
    # The account's unfiled settled rows — the twin candidates. Loaded once, lazily, only if a
    # filed pending actually needs a rescue (most accounts have none), then trimmed as twins are used.
    unfiled_posted = None
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

        # WHIT-511: rescue a filed pending's category/notes/tags/exclusion onto its settled twin.
        twin = None
        if is_unfiled is not None and _pending_is_filed(pending, is_unfiled):
            if unfiled_posted is None:
                # Fail-open like the taxonomy read: a posted-scan fault on ONE account must not
                # abort the unattended sweep for every later account. Skip the rescue here (no
                # candidates -> reap as today); the next daily sweep retries the still-filed pending.
                try:
                    posted_rows = repo.get_posted_transactions_for_account(account_id)
                except DatabaseError as exc:
                    logger.warning(
                        "age_out rescue: could not read posted rows account=%s: %s; reaping as usual",
                        account_id, exc,
                    )
                    posted_rows = []
                unfiled_posted = [posted for posted in posted_rows if is_unfiled(posted.get("category"))]
            twin = _find_carry_twin(pending, unfiled_posted)
            if twin is None:
                logger.info(
                    "age_out rescue: filed pending has no confident twin account=%s txn=%s%s",
                    account_id, pending.get("transaction_id"), " [dry-run]" if dry_run else "",
                )

        if dry_run:
            if twin is not None:
                logger.info(
                    "age_out rescue: WOULD carry account=%s pending=%s -> posted=%s [dry-run]",
                    account_id, pending.get("transaction_id"), twin.get("transaction_id"),
                )
            continue

        if twin is not None:
            # WHIT-545: the carry now recomputes counts_to_budget for the carried category
            # itself (given is_unfiled), so no separate recompute here. The rescue only runs
            # on a filed pending, so the is_unfiled category gate never skips this carry.
            carried = repo._with_carried_category(twin, pending, is_unfiled=is_unfiled)
            try:
                repo.insert_transactions([carried])
            except DatabaseError as exc:
                # Never delete the filing before it is safely copied. Skip the reap; the next
                # sweep retries (the pending still qualifies, still filed).
                summary["failed"] += 1
                logger.warning(
                    "age_out rescue carry FAILED account=%s pending=%s -> posted=%s: %s",
                    account_id, pending.get("transaction_id"), twin.get("transaction_id"), exc,
                )
                continue
            summary["rescued"] += 1
            logger.info(
                "age_out rescue: carried category account=%s pending=%s -> posted=%s",
                account_id, pending.get("transaction_id"), twin.get("transaction_id"),
            )
            # A twin can be claimed once — drop it so a second filed pending can't carry onto it.
            unfiled_posted = [posted for posted in unfiled_posted if posted.get("sk") != twin.get("sk")]

        try:
            repo._delete_pending_if_present(pending["pk"], pending["sk"])
        except DatabaseError as exc:
            # Best-effort: a throttled/failed DeleteItem on ONE ghost must not strand the
            # remaining ghosts (or every later account) in this unattended run. Log it,
            # count it, carry on — the next daily sweep retries it (a still-present pending
            # re-qualifies, and the delete is idempotent). A rescued row keeps its carried
            # category — the retry then finds the twin already filed and simply reaps.
            summary["failed"] += 1
            logger.warning(
                "age_out delete FAILED account=%s txn=%s: %s",
                account_id, pending.get("transaction_id"), exc,
            )
            continue
        summary["reaped"] += 1
    return summary


def age_out_stale_pendings(repo, category_repo=None, today: date | None = None, dry_run: bool = True) -> dict:
    """Sweep every account for stale pendings. Returns a summary dict.

    `today` is injectable for deterministic tests; defaults to the app's Melbourne
    "today" (shared spend._melbourne_today) — the one clock the rest of the app uses,
    matching the schedule's own Australia/Melbourne timezone.

    `category_repo` is optional: when given, the taxonomy is read once and a filed pending's
    filing is rescued onto its settled twin before the reap (WHIT-511). Omitted (or an
    unreadable taxonomy) reaps exactly as before — so every existing caller/test is unchanged."""
    today = today or _melbourne_today()
    cutoff = _cutoff_date(today)
    is_unfiled = _load_is_unfiled(category_repo)
    total = {"accounts": 0, "stale": 0, "reaped": 0, "failed": 0, "rescued": 0, "dry_run": dry_run, "cutoff": cutoff}
    for account_id in sorted(set(ACCOUNT_ID_MAP.values())):
        account_summary = age_out_account(repo, account_id, cutoff, dry_run, is_unfiled)
        total["accounts"] += 1
        for key in ("stale", "reaped", "failed", "rescued"):
            total[key] += account_summary[key]
    # A LIVE run gets its own log line (even when it reaps 0), so an unattended schedule
    # that silently reverted to dry-run — reaping nothing forever — is detectable.
    if dry_run:
        logger.info("age_out DRY-RUN summary: %s", total)
    else:
        logger.info(
            "age_out LIVE summary: reaped=%d rescued=%d stale=%d failed=%d accounts=%d cutoff=%s",
            total["reaped"], total["rescued"], total["stale"], total["failed"], total["accounts"], cutoff,
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
    summary = age_out_stale_pendings(TransactionRepository(), CategoryRepository(), dry_run=dry_run)
    return {"statusCode": 200, "body": json.dumps(summary, default=str)}
