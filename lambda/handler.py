"""AWS Lambda entry point for syncing BankSync transactions into DynamoDB."""

import base64
import logging

from banksync import BankSyncClient, UnknownAccountError
from models import Transaction
from repository import TransactionRepository
from ssm import get_param
from standardwebhooks.webhooks import Webhook

# Budget-threshold alerts (WHIT-22). The shared layer provides the detection + the
# repos it reads; the windowed spend read uses the SHARED TransactionRepository
# (`repository_transaction`, a different module from the webhook's local
# `repository`) because only it has get_transactions_by_date_range.
import budget_alerts
# Home-loan repayment pushes (WHIT-15): a second best-effort detector on the same
# write path — when a posted repayment credit lands, send one encouraging push.
import repayment_alerts
from repository_transaction import TransactionRepository as WindowRepo
from repository_budget import BudgetRepository
from repository_category import CategoryRepository
from repository_device import DeviceRepository
from repository_notify import NotifyRepository
from repository_paycycle import PayCycleRepository

logger = logging.getLogger(__name__)
# The Text-format Lambda runtime leaves the root logger at WARNING, so INFO logs are
# dropped unless we opt in — matching sync_trigger / balance_poller / presignup.
logger.setLevel(logging.INFO)

BANKSYNC_WEBHOOK_SECRET_PATH = "/whittle/banksync-webhook-secret"

_webhook_signing_secret = None


def get_webhook_signing_secret() -> str:
    global _webhook_signing_secret
    if _webhook_signing_secret is None:
        _webhook_signing_secret = get_param(BANKSYNC_WEBHOOK_SECRET_PATH)
    return _webhook_signing_secret


def verify_and_parse(event) -> dict:
    raw_body = event.get("body", "")
    if event.get("isBase64Encoded"):
        raw_body = base64.b64decode(raw_body).decode("utf-8")
    wh = Webhook(get_webhook_signing_secret())

    normalized_headers = {k.lower(): v for k, v in event.get("headers", {}).items()}
    return wh.verify(raw_body, normalized_headers)


def lambda_handler(event, context) -> dict:
    """Lambda handler: runs a full sync and returns a 200 response.

    `event` and `context` are supplied by the AWS Lambda runtime and are unused
    because the sync is driven entirely by the hardcoded account list.
    """
    repo = TransactionRepository()
    try:
        payload = verify_and_parse(event)
    except Exception:
        return {"statusCode": 401, "body": "invalid signature"}

    # Observability: the normal path was otherwise silent (CloudWatch showed only the
    # Lambda START/END). Log every verified delivery's event id + row count so the
    # hourly webhook fan-out — and which deliveries are duplicates vs carry rows — is
    # visible in the logs.
    logger.info("webhook %s: %d rows", payload["id"], len(payload.get("data", [])))

    if repo.has_event(payload["id"]):
        return {"statusCode": 200, "body": "duplicate event - skipped"}

    try:
        process_transaction(payload, repo)
    except Exception as e:
        # Save-then-mark (WHIT-83): the event is marked seen only AFTER a successful
        # write (below), so a failed write leaves it UNMARKED and BankSync's retry
        # re-processes it — a transaction can never be dropped by a failed write, and
        # no rollback is needed. (Writes overwrite by id, so a retry is idempotent.)
        return {"statusCode": 500, "body": str(e)}

    repo.mark_event(payload["id"])
    return {"statusCode": 200, "body": "ok"}


def process_transaction(payload: dict, repo: TransactionRepository) -> None:
    normalised_transactions: list[Transaction] = []
    unmapped_transactions: list[dict] = []
    for row in payload["data"]:
        try:
            normalised_transactions.append(BankSyncClient.normalise(row))
        except (UnknownAccountError, KeyError):
            unmapped_transactions.append(row)

    repo.save_failed_transactions(unmapped_transactions)

    # Budget-threshold alerts (WHIT-22): snapshot spend BEFORE the write, so a
    # crossing can be detected against the pre-write state. Best-effort — a failure
    # here must never affect the write; it just skips alerting for this event.
    alert_ctx = None
    try:
        alert_ctx = budget_alerts.capture_pre_write(
            normalised_transactions,
            device_repo=DeviceRepository(),
            budget_repo=BudgetRepository(),
            paycycle_repo=PayCycleRepository(),
            window_repo=WindowRepo(),
            webhook_repo=repo,
        )
    except Exception:
        logger.exception("budget-alert pre-write capture failed (ignored)")

    # Let any error propagate to lambda_handler, which returns 500 and leaves the
    # event unmarked, so BankSync's retry re-processes it. The old `except ClientError`
    # swallowed the error into an ignored return dict, so the handler reported 200 "ok"
    # with nothing written; it was also dead — handle_database_error converts every
    # ClientError to a DatabaseError before it could reach here (WHIT-83, WHIT-127).
    repo.insert_or_reconcile(normalised_transactions)

    # After the write succeeds, fire any budget-threshold crossing (best-effort).
    if alert_ctx is not None:
        try:
            budget_alerts.fire_if_crossed(
                alert_ctx, normalised_transactions,
                webhook_repo=repo,
                category_repo=CategoryRepository(),
                notify_repo=NotifyRepository(),
            )
        except Exception:
            logger.exception("budget-alert fire failed (ignored)")

    # And send a push for any home-loan repayment in the batch (WHIT-15). Independent
    # of the budget-alert block and its own best-effort — a failure here must never
    # affect the write or the budget alert.
    try:
        repayment_alerts.notify_repayments(
            normalised_transactions,
            device_repo=DeviceRepository(),
            notify_repo=NotifyRepository(),
        )
    except Exception:
        logger.exception("repayment notification failed (ignored)")
