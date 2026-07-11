"""Scheduled Lambda that resolves Expo push RECEIPTS — the delivery-outcome half
of the push pipeline (WHIT-139).

``send_push`` (shared/push.py) records each accepted push's Expo receipt id with the
token it went to (PushReceiptRepository). Delivery itself is async: the true outcome —
delivered, device unregistered, or a hard failure — only shows up later on Expo's
receipts endpoint. This sweep reads every pending ``{receipt_id -> token}``, asks Expo
how each landed, and acts:

    EventBridge Scheduler (terraform/scheduler.tf, every 30 min)
        -> this lambda
        -> POST https://exp.host/--/api/v2/push/getReceipts  {ids:[...]}
        -> per receipt:
             ok                  -> delete the pending row (resolved cleanly)
             DeviceNotRegistered -> prune the dead token + delete the row
             any other error     -> log PUSH_DELIVERY_FAILED (drives the alarm)
                                     + delete the row
             absent (unresolved) -> leave the row for the next sweep (its 24h TTL
                                     reaps it if Expo never resolves it)

The distinct ``PUSH_DELIVERY_FAILED`` log line is what a CloudWatch metric-filter alarm
(terraform/monitoring.tf) watches — it's how a silent "sent but never delivered" failure
becomes visible, which is the point of this card.

Best-effort throughout (mirrors the balance poller): every outcome is isolated in its own
try/except and ``lambda_handler`` never raises, so one bad receipt — or a whole failed
poll — can't break the rest or error the invocation. ``push``, ``repository_push_receipt``,
``repository_device`` (and ``ssm`` beneath them) are provided by the shared layer.

Invoked only by EventBridge Scheduler, never by API Gateway.
"""

import logging

from push import get_access_token, get_receipts
from repository_device import DeviceRepository
from repository_push_receipt import PushReceiptRepository

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def _resolve_one(rid, rec, token, receipt_repo, device_repo) -> str:
    """Act on a single RESOLVED receipt, then drop its pending row.

    Every terminal outcome ends with the row deleted, because Expo has given a final
    answer — only an id Expo has NOT resolved (left untouched by the caller) stays
    pending. Returns the outcome bucket ("ok" / "pruned" / "failed") for the summary.
    A non-dict receipt can't be interpreted, so it falls to the failure branch (logged +
    cleared) rather than lingering.
    """
    status = rec.get("status") if isinstance(rec, dict) else None
    if status == "ok":
        receipt_repo.delete(rid)
        return "ok"

    error = (rec.get("details") or {}).get("error") if isinstance(rec, dict) else None
    if error == "DeviceNotRegistered":
        # The device uninstalled/disabled notifications after we sent — prune it so
        # future sends skip it (a backstop to send_push's own on-send pruning).
        if token:
            device_repo.remove(token)
        receipt_repo.delete(rid)
        return "pruned"

    # Any other terminal error (MessageTooBig, MessageRateExceeded, an expired
    # credential, ...). This DISTINCT token is what the delivery-failure alarm matches —
    # the "accepted but not delivered" signal this card exists to surface.
    logger.error("PUSH_DELIVERY_FAILED receipt=%s error=%s", rid, error)
    receipt_repo.delete(rid)
    return "failed"


def _sweep(access_token) -> dict:
    """Read every pending receipt id, poll Expo, and resolve each. Returns a summary."""
    receipt_repo = PushReceiptRepository()
    pending = receipt_repo.list_pending()
    if not pending:
        return {"pending": 0, "ok": 0, "pruned": 0, "failed": 0}

    id_to_token = dict(pending)
    receipts = get_receipts(list(id_to_token), access_token=access_token)

    device_repo = DeviceRepository()
    counts = {"ok": 0, "pruned": 0, "failed": 0}
    for rid, rec in receipts.items():
        token = id_to_token.get(rid)
        try:
            outcome = _resolve_one(rid, rec, token, receipt_repo, device_repo)
        except Exception:
            # Best-effort per receipt: a delete/prune failure on one id must not abort the
            # rest. The row stays pending and a later sweep retries it (TTL is the backstop).
            logger.exception("could not resolve push receipt %s", rid)
            continue
        counts[outcome] += 1

    # Ids in id_to_token but ABSENT from `receipts` are never touched here — Expo hasn't
    # resolved them yet, so we leave those rows for the next sweep.
    return {"pending": len(pending), **counts}


def lambda_handler(event, context):
    """Poll Expo for pending push receipts and act on each. Best-effort: never raises.

    The Expo access token is fetched once — best-effort: an SSM failure is logged and the
    sweep is skipped (an unauthenticated getReceipts would fail anyway), so the invocation
    still returns cleanly and every pending row survives for the next run. The whole sweep
    is wrapped so a store/transport failure can't error the invocation.
    """
    try:
        access_token = get_access_token()
    except Exception as e:
        logger.error("push-receipt sweep skipped, could not read the Expo token: %s", e)
        return {"pending": 0, "ok": 0, "pruned": 0, "failed": 0}

    try:
        summary = _sweep(access_token)
    except Exception:
        logger.exception("push-receipt sweep failed")
        return {"pending": 0, "ok": 0, "pruned": 0, "failed": 0}

    logger.info(
        "push-receipt sweep: %d pending, %d ok, %d pruned, %d failed",
        summary["pending"], summary["ok"], summary["pruned"], summary["failed"],
    )
    return summary
