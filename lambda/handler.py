"""AWS Lambda entry point for syncing BankSync transactions into DynamoDB."""

import logging

from banksync import UnknownAccountError, normalise
from models import Transaction
from webhook_repository import TransactionRepository
from api_key import get_api_key
from event_body import raw_body
from standardwebhooks.webhooks import Webhook

import budget_alerts
import rule_ingest
from repository_budget import BudgetRepository
from repository_category import CategoryRepository
from repository_device import DeviceRepository
from repository_notify import NotifyRepository
from repository_paycycle import PayCycleRepository
from repository_rule import RuleRepository

logger = logging.getLogger(__name__)
# The Text-format Lambda runtime leaves the root logger at WARNING, so INFO logs are
# dropped unless we opt in — matching sync_trigger / balance_poller / presignup.
logger.setLevel(logging.INFO)

BANKSYNC_WEBHOOK_SECRET_PATH = "/abundo/banksync-webhook-secret"

# Plain fields of a summary delivery that are safe and useful to log (WHIT-606).
SUMMARY_LOG_FIELDS = ("type", "status", "error", "message", "timestamp")
SUMMARY_FIELD_MAX_CHARS = 200


def get_webhook_signing_secret() -> str:
    return get_api_key(BANKSYNC_WEBHOOK_SECRET_PATH)


def verify_and_parse(event) -> dict:
    body_text = raw_body(event).decode("utf-8")
    wh = Webhook(get_webhook_signing_secret())

    normalized_headers = {k.lower(): v for k, v in event.get("headers", {}).items()}
    return wh.verify(body_text, normalized_headers)


def _drop(rows: list, keep, why: str) -> list:
    """The rows `keep` accepts, logging how many were dropped and why."""
    kept = [row for row in rows if keep(row)]
    if len(kept) < len(rows):
        logger.info("skipped %d %s", len(rows) - len(kept), why)
    return kept


def lambda_handler(event, context) -> dict:
    """Lambda handler: verifies a BankSync webhook delivery and stores its rows.

    `event` is the API Gateway request: its signed body holds the transaction rows.
    Returns 401 when the signature doesn't verify, else a 200 response.
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
    if not payload.get("data"):
        log_summary_delivery(payload)

    if repo.has_event(payload["id"]):
        return {"statusCode": 200, "body": "duplicate event - skipped"}

    try:
        process_transaction(payload, repo)
    except Exception as e:
        # Save-then-mark (WHIT-83): the event is marked seen only AFTER a successful
        # write (below), so a failed write leaves it UNMARKED and BankSync's retry
        # re-processes it — a transaction can never be dropped by a failed write, and
        # no rollback is needed. (Writes overwrite by id, so a retry is idempotent.)
        logger.exception("webhook %s: processing failed", payload["id"])
        return {"statusCode": 500, "body": str(e)}

    repo.mark_event(payload["id"])
    return {"statusCode": 200, "body": "ok"}


def log_summary_delivery(payload: dict) -> None:
    """Log what a row-less (summary) delivery says, so a stalled feed can be diagnosed from the
    logs (WHIT-606). BankSync's summary shape isn't documented in this repo, so this logs the
    keys (and the keys of any nested object), plus only the allow-listed plain values, never
    the whole payload."""
    nested_keys = {
        key: sorted(value.keys()) for key, value in payload.items() if isinstance(value, dict)
    }
    fields = {
        key: str(payload[key])[:SUMMARY_FIELD_MAX_CHARS]
        for key in SUMMARY_LOG_FIELDS
        if isinstance(payload.get(key), (str, int, float))
    }
    logger.info(
        "webhook %s summary: keys=%s nested_keys=%s fields=%s",
        payload["id"], sorted(payload.keys()), nested_keys, fields,
    )


def process_transaction(payload: dict, repo: TransactionRepository) -> None:
    normalised_transactions: list[Transaction] = []
    unmapped_transactions: list[dict] = []
    # Summary events (e.g. sync.completed) carry no `data` key — treat as zero rows,
    # not a KeyError. Matches the defensive `.get` in the row-count log above; without
    # this a data-less delivery 500s and BankSync retries it forever (WHIT-302 cutover).
    for row in payload.get("data", []):
        try:
            normalised_transactions.append(normalise(row))
        except (UnknownAccountError, KeyError):
            unmapped_transactions.append(row)

    repo.save_failed_transactions(unmapped_transactions)

    # A charge the user deleted must not come back through a BankSync re-send (WHIT-654): drop it
    # before rules, alerts or the write ever see it.
    normalised_transactions = _drop(
        normalised_transactions,
        lambda transaction: not repo.is_deleted(transaction["account_id"], transaction["transaction_id"]),
        "re-sent transaction(s) the user deleted",
    )

    # A $0.00 row is information only (WHIT-705): e.g. Westpac's "FOREIGN FEE" rows, whose real fee
    # is already folded into the purchase. Drop it before rules, alerts or the write see it.
    normalised_transactions = _drop(
        normalised_transactions, lambda transaction: transaction["amount"] != 0, "$0.00 transaction(s)",
    )

    # Apply the user's rules as each charge lands (WHIT-530): BankSync no longer labels charges
    # for us, so our server files each unfiled one by our own rules here, BEFORE the budget
    # snapshot and the write see the category. Best-effort inside `apply` — a rules-read failure
    # leaves the charge unfiled and still writes it.
    # `is_unfiled` (the taxonomy check) is threaded into the write below so a stored raw
    # category can't clobber a rule-fill on settlement, and counts_to_budget is recomputed
    # for the carried category (WHIT-545). None on a rules-read failure -> carry unchanged.
    is_unfiled = rule_ingest.apply(
        normalised_transactions,
        rule_repo=RuleRepository(),
        category_repo=CategoryRepository(),
        # WHIT-559: a spread rule filing a matching charge auto-creates the category's spread plan.
        budget_repo=BudgetRepository(),
        paycycle_repo=PayCycleRepository(),
    )

    # Budget-threshold alerts (WHIT-22): snapshot BEFORE the write, so the post-write
    # spend can be replayed in memory. Best-effort — a failure here must never affect
    # the write; it just skips alerting for this event.
    alert_ctx = None
    try:
        alert_ctx = budget_alerts.capture_pre_write(
            normalised_transactions,
            device_repo=DeviceRepository(),
            budget_repo=BudgetRepository(),
            paycycle_repo=PayCycleRepository(),
            webhook_repo=repo,
        )
    except Exception:
        logger.exception("budget-alert pre-write capture failed (ignored)")

    # Let any error propagate to lambda_handler, which returns 500 and leaves the
    # event unmarked, so BankSync's retry re-processes it. The old `except ClientError`
    # swallowed the error into an ignored return dict, so the handler reported 200 "ok"
    # with nothing written; it was also dead — handle_database_error converts every
    # ClientError to a DatabaseError before it could reach here (WHIT-83, WHIT-127).
    repo.insert_or_reconcile(normalised_transactions, is_unfiled=is_unfiled)

    # After the write succeeds, fire any budget threshold reached this cycle (best-effort).
    if alert_ctx is not None:
        try:
            budget_alerts.fire_budget_alerts(
                alert_ctx, normalised_transactions,
                category_repo=CategoryRepository(),
                notify_repo=NotifyRepository(),
            )
        except Exception:
            logger.exception("budget-alert fire failed (ignored)")
