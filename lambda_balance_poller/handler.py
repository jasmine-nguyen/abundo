"""Scheduled Lambda that polls every account's live balance from BankSync and
stores it in DynamoDB (WHIT-8, WHIT-212).

This is an *outbound* half of the BankSync integration (a sibling of
``lambda_sync_trigger/handler.py``), but where the sync trigger POSTs to kick off
a feed sync, this one GETs each account's live balance and persists it:

    EventBridge Scheduler (terraform/scheduler.tf, daily)
        -> this lambda
        -> GET https://api.banksync.io/v1/banks/{bid}/accounts/{aid}/balances (per BALANCE_SOURCES)
        -> upsert one SIGNED row per account (AccountBalanceRepository). The read API serves
           them as GET /accounts/balances, and GET /homeloan as abs(amount) of the home loan's.

The home loan is fetched once, in that loop; its milestone push and repayment-miss checks
run off the same reading (WHIT-792). BankSync's `getLoan` (principalBalance) isn't supported
by the fiskil:au provider yet, so the mortgage's owed amount is abs(getBalance amount).

Invoked only by EventBridge Scheduler, never by API Gateway. ``constants``,
``api_key``, and ``repository`` are provided by the shared Lambda layer.
"""

import calendar
import logging
import time
import urllib.request  # noqa: F401 — load-bearing test seam; see the balance_fetch import below
from decimal import Decimal
from typing import Optional

from constants import (
    ACCOUNT_ID_MAP,
    BALANCE_POLL_TIMEOUT_SECONDS,
    BALANCE_SOURCES,
    BANKSYNC_API_KEY_PATH,
    BANKSYNC_BASE_URL,
    FEED_STALL_ACCOUNT_IDS,
    FEED_STALL_DAYS,
    FEED_STALL_LOOKBACK_DAYS,
    HOMELOAN_ACCOUNT_ID,
    MAX_PAGE_SIZE,
    MIN_REPAYMENT_NOTIFY,
    REPAYMENT_DROP_THRESHOLD,
    REPAYMENT_MISS_LOOKBACK_DAYS,
)
from milestones import notify_homeloan_milestone, owed
from repayment_rules import is_repayment_credit
from goal_checkpoints import check_goal_checkpoints
from repository_balance import AccountBalanceRepository, FeedWatchRepository
from repository_device import DeviceRepository
from repository_goals import GoalsRepository
from repository_loanfacts import LoanFactsRepository
from repository_milestone import MilestoneRepository
from repository_notify import NotifyRepository
from repository_transaction import TransactionRepository, read_date_range_pages
from push import send_push
from api_key import get_api_key as _fetch_api_key
# normalise_account_balance + the raw fetch live in the shared balance_fetch module (reused
# by the on-demand refresh API). `import urllib.request` stays above so the poller tests'
# `handler.urllib.request.urlopen` patch still reaches the shared fetch (same module singleton).
from balance_fetch import normalise_account_balance, fetch_balance as _fetch_balance

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

SECONDS_PER_DAY = 24 * 60 * 60
# The poll is daily, so its start time drifts by seconds-to-minutes. Without this slack a
# stall seen on exactly FEED_STALL_DAYS polls could land a few seconds short and wait a day.
FEED_STALL_SLACK_SECONDS = 60 * 60
# 14 days of one account's transactions fit in a page or two; this only stops a cursor that
# never ends from looping until the Lambda times out.
FEED_STALL_MAX_PAGES = 20


def get_api_key() -> str:
    """The BankSync API key (fetched + cached in shared/api_key.py, keyed by path)."""
    return _fetch_api_key(BANKSYNC_API_KEY_PATH)


def fetch_balance(bid: str, aid: str, api_key: str) -> dict:
    """GET /v1/banks/{bid}/accounts/{aid}/balances -> the parsed JSON payload.

    Thin wrapper over the shared fetch with the poller's own base URL, 30s timeout and
    User-Agent (BankSync sits behind Cloudflare, which 403s the default urllib UA)."""
    return _fetch_balance(
        bid, aid, api_key,
        base_url=BANKSYNC_BASE_URL,
        timeout=BALANCE_POLL_TIMEOUT_SECONDS,
        user_agent="abundo-homeloan-request",
    )


def check_repayment_landed_but_no_push(
    old_balance: Optional[Decimal], new_balance: Decimal, notify_repo
) -> None:
    """Alarm backstop (WHIT-316): if the mortgage balance dropped like a repayment landed
    but no repayment push fired recently, log the line the CloudWatch alarm watches.

    The direct Up webhook (lambda/up_webhook.py) is the sole repayment notifier now, and
    its silent failure modes (re-linked account, deregistered webhook) leave no error. This
    catches them via the balance, which comes from the bank feed — independent of the Up
    webhook — so the drop is still seen when the webhook is broken. A repayment LOWERS the
    outstanding balance; interest raises it and a redraw raises it, so neither false-fires.
    """
    if old_balance is None:
        return
    drop = old_balance - new_balance
    if drop < REPAYMENT_DROP_THRESHOLD:
        return
    last_fired_at = notify_repo.last_repayment_fired_at()
    cutoff = int(time.time()) - REPAYMENT_MISS_LOOKBACK_DAYS * 24 * 60 * 60
    if last_fired_at is not None and last_fired_at >= cutoff:
        return
    logger.error(
        "UP_WEBHOOK_REPAYMENT_MISSED mortgage balance dropped %s but no repayment push "
        "fired in the last %s days (last_fired_at=%s)",
        drop, REPAYMENT_MISS_LOOKBACK_DAYS, last_fired_at,
    )


def check_ingested_repayment_without_push(notify_repo, transaction_repo, now: int) -> None:
    """Precise miss-detector (WHIT-317): alarm if a home-loan repayment was ingested in the
    last REPAYMENT_MISS_LOOKBACK_DAYS but no push alerted it.

    Keys on the actual repayment TRANSACTION, not the net balance drop, so it survives the
    edges that defeat check_repayment_landed_but_no_push: interest posting the same day, two
    repayments in one window, a repayment split across polls, a pre-upsert balance-read
    hiccup. Matches by amount in integer cents (the store keeps dollars, the push keeps cents
    — both normalised here), consuming one push per repayment, so two same-amount repayments
    need two pushes or one alarms. Reads only DynamoDB; best-effort, the caller swallows.

    The store window is by UTC date (whole days), so the push cutoff is aligned to MIDNIGHT
    of the oldest day — not `now - 7d` — making the push window at least as broad as the
    store window. Otherwise a repayment pushed earlier on the boundary day would sit inside
    the store window but outside a mid-day push cutoff and spuriously alarm.
    """
    window_start = now - REPAYMENT_MISS_LOOKBACK_DAYS * 24 * 60 * 60
    start_date = time.strftime("%Y-%m-%d", time.gmtime(window_start))
    end_date = time.strftime("%Y-%m-%d", time.gmtime(now))
    cutoff = calendar.timegm(time.strptime(start_date, "%Y-%m-%d"))  # midnight of start_date

    rows, _cursor = transaction_repo.get_transactions_by_date_range(
        HOMELOAN_ACCOUNT_ID, start_date, end_date, MAX_PAGE_SIZE
    )
    # The shared rule identifies a repayment leg; the $10 alert floor stays here, the
    # poller's own "worth an alert" filter (the read API deliberately has no floor).
    repayment_cents = [
        int(round(row["amount"] * 100))
        for row in rows
        if is_repayment_credit(row) and row["amount"] >= MIN_REPAYMENT_NOTIFY
    ]
    if not repayment_cents:
        return

    unmatched_pushes = notify_repo.repayment_push_amounts_since(cutoff)
    for cents in repayment_cents:
        if cents in unmatched_pushes:
            unmatched_pushes.remove(cents)  # this repayment did alert — consume its push
            continue
        logger.error(
            "UP_WEBHOOK_REPAYMENT_MISSED source=txn a repayment of %s cents was ingested in "
            "the last %s days with no matching push",
            cents, REPAYMENT_MISS_LOOKBACK_DAYS,
        )


def _check_homeloan(deltas: list) -> None:
    """Run the home-loan checks off this poll's single fetch of the mortgage (WHIT-792).

    The up-homeloan delta carries the stored amount before the upsert (`old`, None on the first
    poll) and the fresh one (`new`), both signed. A failed fetch leaves no delta, so the balance
    checks are skipped, but WHIT-317 still runs. Each check is best-effort and isolated."""
    notify_repo = NotifyRepository()
    # WHIT-317: precise repayment-miss detector. Reads only DynamoDB (transaction store + push
    # markers), so a getBalance outage must not blind this backstop.
    try:
        check_ingested_repayment_without_push(notify_repo, TransactionRepository(), int(time.time()))
    except Exception as e:
        logger.error("precise repayment-miss check failed: %s", e)

    delta = next((d for d in deltas if d["account_id"] == HOMELOAN_ACCOUNT_ID), None)
    if delta is None:
        return

    # WHIT-301: celebrate crossing a payoff milestone.
    try:
        notify_homeloan_milestone(
            delta["old"],
            delta["new"],
            loanfacts_repo=LoanFactsRepository(),
            device_repo=DeviceRepository(),
            notify_repo=notify_repo,
            milestone_repo=MilestoneRepository(),
        )
    except Exception as e:
        logger.error("milestone push failed (balance still stored): %s", e)

    # WHIT-316: alarm backstop — a repayment clearly landed (owed amount dropped) but no push fired.
    try:
        check_repayment_landed_but_no_push(owed(delta["old"]), abs(delta["new"]), notify_repo)
    except Exception as e:
        logger.error("repayment-miss check failed (balance still stored): %s", e)


def _poll_account_balances(api_key: str):
    """Poll + upsert a SIGNED live balance for every account (WHIT-212, Accounts tab).

    Best-effort PER account: one account's failure (transport, `success:false`, missing
    fields) is logged and skipped — it leaves that account's last-good row and never blocks
    the others. Each raw BankSync `aid` is mapped to its internal id so the balance lands
    under the same id the account's transactions carry.

    Returns `(stored, deltas)`: `stored` is how many were upserted; `deltas` is one
    `{"account_id", "old", "new"}` per stored account — the SIGNED prior balance (None on the
    account's first-ever poll) and the new one — so a goal-checkpoint crossing can be detected
    without a second poll (WHIT-479). The prior balances are read once, in a single batched
    best-effort read before the loop (WHIT-482, mirroring the read API): a read hiccup leaves
    EVERY account's `old` None (not just one), which the seed guard treats as "no crossing" — a
    missed celebration, never a wrong one. This one read must stay wrapped: `list_balances`
    re-raises a DatabaseError, and lambda_handler doesn't guard this call, so an unswallowed
    failure would abort the whole poll and store nothing.
    """
    repo = AccountBalanceRepository()

    prior_by_id = {}
    try:
        prior_rows = repo.list_balances(sorted(set(ACCOUNT_ID_MAP.values())))
        prior_by_id = {row["account_id"]: row["amount"] for row in prior_rows}
    except Exception as e:
        logger.error("prior balance batch read failed, treating all as first poll: %s", e)

    stored = 0
    deltas = []
    for source in BALANCE_SOURCES:
        aid = source["aid"]
        internal_id = ACCOUNT_ID_MAP.get(aid)
        if internal_id is None:
            # Guarded at import by the BALANCE_SOURCES assert; stay defensive anyway.
            logger.error("balance source aid %s has no internal-id mapping, skipping", aid)
            continue
        try:
            old_amount = prior_by_id.get(internal_id)  # None on the account's first-ever poll
            payload = fetch_balance(source["bid"], aid, api_key)
            n = normalise_account_balance(payload)
            repo.upsert_balance(
                internal_id,
                n["amount"],
                n["available_balance"],
                n["currency"],
                n["as_of"],
                n["account_type"],
            )
        except Exception as e:
            logger.error("account balance poll failed for %s, keeping last-good: %s", internal_id, e)
            continue
        stored += 1
        deltas.append({"account_id": internal_id, "old": old_amount, "new": n["amount"]})
        logger.info(
            "account balance stored: %s %s %s (as of %s)",
            internal_id, n["currency"], n["amount"], n["as_of"],
        )
    return stored, deltas


def _check_goal_checkpoints(deltas: list) -> None:
    """Celebrate any goal-checkpoint crossing on this poll's account deltas (WHIT-479). One push
    per synced goal whose linked account's balance crossed a checkpoint; once ever per checkpoint.
    Manual goals cross when their balance is SAVED, so they're handled at the PUT, not here."""
    if not deltas:
        return
    check_goal_checkpoints(
        deltas, goals_repo=GoalsRepository(), device_repo=DeviceRepository(), notify_repo=NotifyRepository())


def _check_feed_stall(account_id: str, balance: Decimal, *, transaction_repo, watch_repo,
                      device_repo, now: int) -> None:
    """Push once when `account_id`'s balance has moved but no new transaction id has arrived for
    FEED_STALL_DAYS; push again when one finally arrives (WHIT-606).

    Only a NEVER-SEEN id counts as new data. A re-send, a date correction or a deleted row (the
    age-out sweep, a settled pending) changes no id we haven't seen, so none of them can hide a
    stall. The balance baseline lives on the watch row, not the stored balance, because the
    app's on-demand refresh also rewrites that row and would hide the move.
    """
    start_date = time.strftime("%Y-%m-%d", time.gmtime(now - FEED_STALL_LOOKBACK_DAYS * SECONDS_PER_DAY))
    transactions = read_date_range_pages(transaction_repo, account_id, start_date, None, FEED_STALL_MAX_PAGES)
    current_dates = {transaction["transaction_id"]: transaction["date"] for transaction in transactions}
    account_name = next(
        (transaction["account_name"] for transaction in transactions if transaction.get("account_name")),
        account_id,
    )
    watch = watch_repo.get_watch(account_id)

    if watch is None:
        watch_repo.put_watch(account_id, current_dates, now, balance, alerted=False)
        return

    if current_dates.keys() - watch["seen_dates"].keys():
        if watch["alerted"]:
            _send_feed_push(
                device_repo, account_id,
                "\u2705 Transactions are coming in again",
                f"New transactions arrived for {account_name}.",
            )
        # Keep ids already seen (a deleted row BankSync re-sends is not new), minus any that
        # have aged out of the look-back window so the row can't grow forever.
        still_recent = {
            transaction_id: date for transaction_id, date in watch["seen_dates"].items()
            if date >= start_date
        }
        watch_repo.put_watch(account_id, {**still_recent, **current_dates}, now, balance, alerted=False)
        return

    if balance == watch["amount_at_seen"]:
        return
    stalled_seconds = now - watch["seen_at"]
    if stalled_seconds < FEED_STALL_DAYS * SECONDS_PER_DAY - FEED_STALL_SLACK_SECONDS:
        return

    logger.error(
        "TRANSACTION_FEED_STALLED account=%s no new transaction for %.1f days while the balance "
        "moved %s -> %s",
        account_id, stalled_seconds / SECONDS_PER_DAY, watch["amount_at_seen"], balance,
    )
    if watch["alerted"]:
        return
    sent = _send_feed_push(
        device_repo, account_id,
        "\u26a0\ufe0f Bank transactions have stopped",
        f"No new transactions from {account_name} for {round(stalled_seconds / SECONDS_PER_DAY)} days, "
        "but its balance changed. Check the bank connection in BankSync.",
    )
    if sent:
        watch_repo.put_watch(account_id, watch["seen_dates"], watch["seen_at"],
                             watch["amount_at_seen"], alerted=True)


def _send_feed_push(device_repo, account_id: str, title: str, body: str) -> bool:
    """Send a feed-health push. False when it reached no device (none registered, or Expo
    rejected it), so the stall alert is retried on the next poll instead of marked as sent."""
    summary = send_push(title, body, device_repo.list_tokens(),
                        data={"type": "feedstall", "account": account_id})
    return summary["ok"] > 0


def check_feed_stalls(deltas: list, now: int) -> None:
    """Run the feed-stall check for every watched account polled this run (WHIT-606). An
    account whose balance fetch failed isn't in `deltas`, so it's skipped, not judged."""
    transaction_repo = TransactionRepository()
    watch_repo = FeedWatchRepository()
    device_repo = DeviceRepository()
    for delta in deltas:
        account_id = delta["account_id"]
        if account_id not in FEED_STALL_ACCOUNT_IDS:
            continue
        # Per-account isolation: one account's DB hiccup must not skip the others.
        try:
            _check_feed_stall(
                account_id, delta["new"],
                transaction_repo=transaction_repo, watch_repo=watch_repo,
                device_repo=device_repo, now=now,
            )
        except Exception as e:
            logger.error("feed-stall check failed for %s, continuing: %s", account_id, e)


def lambda_handler(event, context):
    """Poll the live balances and upsert them.

    One SIGNED balance per account (the Accounts tab's `/accounts/balances` rows; the Goal
    screen's `/homeloan` reads the home loan's). Each account is isolated — a failure
    (transport, non-200, `success:false`, missing/malformed fields) is logged and swallowed,
    leaves the last-good row untouched (a bad tick can't zero it), and never blocks the
    others. A genuine 0 reading is a success and IS written. The home-loan, goal-checkpoint
    and feed-stall checks then run off the same readings, each best-effort.
    The API key fetch is itself best-effort: an SSM failure (throttle, missing param, IAM) is
    logged and swallowed so the invocation never errors out and every last-good row survives.
    Only a fully clean run logs BALANCE_POLL_ALL_STORED — the heartbeat the WHIT-645
    balance-poll alarm watches; keep it in lockstep with terraform/monitoring.tf.
    """
    try:
        api_key = get_api_key()
    except Exception as e:
        logger.error("balance poll skipped, could not fetch the BankSync API key: %s", e)
        return {"accounts_stored": 0}
    accounts_stored, deltas = _poll_account_balances(api_key)
    _check_homeloan(deltas)
    # WHIT-479: celebrate a goal-checkpoint crossing. Best-effort — a push failure must never flip
    # the stored-balance result, so it's isolated in its own try/except.
    try:
        _check_goal_checkpoints(deltas)
    except Exception as e:
        logger.error("goal checkpoint push failed (balances still stored): %s", e)
    # WHIT-606: alert when a bank feed stops delivering transactions. Best-effort, isolated.
    try:
        check_feed_stalls(deltas, int(time.time()))
    except Exception as e:
        logger.error("feed-stall check failed (balances still stored): %s", e)
    if accounts_stored == len(BALANCE_SOURCES):
        logger.info("BALANCE_POLL_ALL_STORED %s account balances refreshed", accounts_stored)
    return {"accounts_stored": accounts_stored}
