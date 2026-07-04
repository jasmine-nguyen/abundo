"""AWS Lambda entry point for syncing BankSync transactions into DynamoDB."""

import base64
import logging

from banksync import BankSyncClient, UnknownAccountError
from models import Transaction
from repository import TransactionRepository
from ssm import get_param
from standardwebhooks.webhooks import Webhook

logger = logging.getLogger(__name__)

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
    # Let any error propagate to lambda_handler, which returns 500 and leaves the
    # event unmarked, so BankSync's retry re-processes it. The old `except ClientError`
    # swallowed the error into an ignored return dict, so the handler reported 200 "ok"
    # with nothing written; it was also dead — handle_database_error converts every
    # ClientError to a DatabaseError before it could reach here (WHIT-83, WHIT-127).
    repo.insert_or_reconcile(normalised_transactions)
