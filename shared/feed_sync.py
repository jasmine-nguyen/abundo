"""BankSync feed sync calls, shared by the hourly sync trigger and the pull-to-refresh sync
(ABU-106): start an incremental sync for a feed, and read one sync job's status.
"""

import logging
import urllib.error

from api_key import forget_api_key
from balance_fetch import banksync_request
from constants import BANKSYNC_API_KEY_PATH

logger = logging.getLogger(__name__)


def trigger_sync(feed_id: str, api_key: str, *, user_agent: str, timeout: float) -> str | None:
    """POST /v1/feeds/{id}/sync — a normal incremental sync. Returns the new job's id, or None
    when BankSync answers 409 (a sync is already running for this feed).

    We deliberately send an empty body: that means incremental (cursor-based) sync. We never
    pass ``resetCursors`` (backfills only) or ``forceCancelActive`` (never cancel a running job).
    A 401 forgets the cached key so the next call re-reads it from SSM, then propagates;
    other HTTP errors propagate.
    """
    try:
        # empty body -> incremental sync; a body (even empty) makes it a POST
        body = banksync_request(
            f"/v1/feeds/{feed_id}/sync", api_key, user_agent=user_agent, timeout=timeout, data=b"",
        )
    except urllib.error.HTTPError as e:
        if e.code == 409:
            logger.warning("feed %s: sync already in progress, skipping", feed_id)
            return None
        if e.code == 401:
            forget_api_key(BANKSYNC_API_KEY_PATH)
        raise
    job_id = body["data"]["id"]
    logger.info("feed %s: sync job %s created", feed_id, job_id)
    return job_id


def get_job(feed_id: str, job_id: str, api_key: str, *, user_agent: str, timeout: float) -> dict:
    """GET /v1/feeds/{fid}/jobs/{jid} -> the job (its ``status`` and ``deliverySummary``)."""
    body = banksync_request(
        f"/v1/feeds/{feed_id}/jobs/{job_id}", api_key, user_agent=user_agent, timeout=timeout,
    )
    return body["data"]
