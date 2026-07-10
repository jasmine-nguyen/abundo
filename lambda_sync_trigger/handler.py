"""Scheduled Lambda that triggers a BankSync incremental sync for each feed.

This is the *outbound* half of the BankSync integration and the counterpart to
``lambda/handler.py`` (the *inbound* webhook receiver).

Flow:
    EventBridge Scheduler (terraform/scheduler.tf, cron/rate cadence)
        -> this lambda
        -> POST https://api.banksync.io/v1/feeds/{id}/sync   (per feed)
        -> BankSync fetches new transactions and pushes them to our webhook
           receiver (whittle-transaction-ingest), which writes them to DynamoDB.

BankSync's UI scheduler is capped at daily on our tier; calling the REST sync
endpoint ourselves lets us pick our own cadence.

Invoked only by EventBridge Scheduler, never by API Gateway, so there is no
webhook signature to verify here. ``constants`` and ``ssm`` are provided by the
shared lambda layer.
"""

import json
import logging
import urllib.error
import urllib.request

from constants import (
    BANKSYNC_API_KEY_PATH,
    BANKSYNC_BASE_URL,
    SYNC_FEED_IDS,
    SYNC_TIMEOUT_SECONDS,
)
from ssm import get_param

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_api_key = None


def get_api_key() -> str:
    """Fetch and cache the BankSync API key from SSM for the life of the container."""
    global _api_key
    if _api_key is None:
        _api_key = get_param(BANKSYNC_API_KEY_PATH)
    return _api_key


def trigger_sync(feed_id: str, api_key: str) -> None:
    """POST /v1/feeds/{id}/sync — a normal incremental sync.

    We deliberately send no body: an empty request means incremental
    (cursor-based) sync. We never pass ``resetCursors`` here — that is for
    backfills/recovery only, not the scheduled cadence.
    """
    url = f"{BANKSYNC_BASE_URL}/v1/feeds/{feed_id}/sync"
    req = urllib.request.Request(
        url,
        data=b"",  # empty body -> incremental sync; also forces a clean POST
        headers={
            "X-API-Key": api_key,
            # BankSync sits behind Cloudflare, which blocks the default
            # "Python-urllib" User-Agent with a 403 (error 1010). Send our own.
            "User-Agent": "whittle-sync-trigger",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=SYNC_TIMEOUT_SECONDS) as resp:
            body = json.loads(resp.read())
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
            failed.append(feed_id)

    if failed:
        raise RuntimeError(f"sync trigger failed for feeds: {failed}")

    return {"triggered": list(SYNC_FEED_IDS)}
