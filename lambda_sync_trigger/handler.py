"""Scheduled Lambda that triggers a BankSync incremental sync for each feed.

This is the *outbound* half of the BankSync integration and the counterpart to
``lambda/handler.py`` (the *inbound* webhook receiver).

Flow:
    EventBridge Scheduler (terraform/scheduler.tf, cron/rate cadence)
        -> this lambda
        -> POST https://api.banksync.io/v1/feeds/{id}/sync   (per feed)
        -> BankSync fetches new transactions and pushes them to our webhook
           receiver (abundo-transaction-ingest), which writes them to DynamoDB.
        -> then the pending mirror (pending_mirror.py, WHIT-662): per in-scope
           account, GET BankSync's full transaction list and delete our stored
           pendings the bank no longer lists. It never fails the run.

BankSync's UI scheduler is capped at daily on our tier; calling the REST sync
endpoint ourselves lets us pick our own cadence.

Invoked only by EventBridge Scheduler, never by API Gateway, so there is no
webhook signature to verify here. ``constants`` and ``api_key`` are provided by the
shared lambda layer.
"""

import logging
import urllib.error
import urllib.request  # noqa: F401 — test seam: tests patch `urllib.request.urlopen` here

from constants import (
    BANKSYNC_API_KEY_PATH,
    SYNC_FEED_IDS,
    SYNC_TIMEOUT_SECONDS,
)
from api_key import forget_api_key, get_api_key as _fetch_api_key
from balance_fetch import banksync_request
import pending_mirror

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def get_api_key() -> str:
    """The BankSync API key (fetched + cached in shared/api_key.py, keyed by path)."""
    return _fetch_api_key(BANKSYNC_API_KEY_PATH)


def trigger_sync(feed_id: str, api_key: str) -> None:
    """POST /v1/feeds/{id}/sync — a normal incremental sync.

    We deliberately send no body: an empty request means incremental
    (cursor-based) sync. We never pass ``resetCursors`` here — that is for
    backfills/recovery only, not the scheduled cadence.
    """
    try:
        # empty body -> incremental sync; a body (even empty) makes it a POST
        body = banksync_request(
            f"/v1/feeds/{feed_id}/sync",
            api_key,
            user_agent="abundo-transaction-trigger",
            timeout=SYNC_TIMEOUT_SECONDS,
            data=b"",
        )
        logger.info("feed %s: sync job %s created", feed_id, body["data"]["id"])
    except urllib.error.HTTPError as e:
        # 409 = a sync is already running for this feed. Harmless on a schedule;
        # skip this tick rather than force-cancelling the in-flight job.
        if e.code == 409:
            logger.warning("feed %s: sync already in progress, skipping", feed_id)
            return
        raise


def lambda_handler(event, context):
    """Trigger a sync for each feed, isolating per-feed failures.

    One feed failing does not prevent the others from being triggered, but if
    any feed fails we raise at the end so the invocation is marked failed and
    shows up in CloudWatch metrics/alarms.
    """
    api_key = get_api_key()
    failed = []
    for feed_id, label in SYNC_FEED_IDS.items():
        try:
            trigger_sync(feed_id, api_key)
        except Exception as e:
            logger.error("feed %s (%s): sync trigger failed: %s", feed_id, label, e)
            if isinstance(e, urllib.error.HTTPError) and e.code == 401:
                forget_api_key(BANKSYNC_API_KEY_PATH)
            failed.append(feed_id)

    # Guarded so a mirror fault never fails the run: `failed` feeds the WHIT-644 alarm.
    try:
        pending_mirror.mirror_pendings(api_key)
    except Exception:
        logger.exception("pending mirror failed")

    if failed:
        raise RuntimeError(f"sync trigger failed for feeds: {failed}")

    return {"triggered": list(SYNC_FEED_IDS)}
