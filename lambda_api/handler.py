from constants import ACCOUNT_ID_MAP, TRANSACTION_PATH
from datetime import datetime, timedelta, timezone
from repository import TransactionRepository
from encoders import DecimalEncoder
import base64
import json


def lambda_handler(event, context):
    path = event.get("rawPath", "")
    method = event.get("requestContext", {}).get("http", {}).get("method", "")

    if path == TRANSACTION_PATH and method == "GET":
        repo = TransactionRepository()
        return _json_response(200, get_recent_transactions(repo))

    if path.startswith(f"{TRANSACTION_PATH}/") and method == "PATCH":
        return patch_transaction_category(event, TransactionRepository())

    return _json_response(404, {"error": "Not found"})


def _json_response(status_code: int, body: dict | list) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, cls=DecimalEncoder),
    }


def patch_transaction_category(event: dict, repo: TransactionRepository) -> dict:
    """PATCH /transactions/{id} — set a transaction's category and persist it.

    Takes the repository as a parameter so it can be unit-tested with a fake
    repo, no patching required. Expects a JSON object body
    {"category": "<non-empty string>"}. Clearing a category (null/empty) is
    intentionally not supported yet; it returns 400.
    """
    transaction_id = (event.get("pathParameters") or {}).get("id")
    if not transaction_id:
        return _json_response(404, {"error": "transaction not found"})

    raw_body = event.get("body") or ""
    try:
        if event.get("isBase64Encoded"):
            # b64decode raises binascii.Error and .decode raises UnicodeDecodeError —
            # both ValueError subclasses, so a malformed/binary body yields a clean 400.
            raw_body = base64.b64decode(raw_body).decode("utf-8")
        body = json.loads(raw_body)
    except (json.JSONDecodeError, ValueError):
        return _json_response(400, {"error": "invalid JSON body"})

    if not isinstance(body, dict):
        return _json_response(400, {"error": "invalid JSON body"})

    category = body.get("category")
    if not isinstance(category, str) or not category.strip():
        return _json_response(400, {"error": "category is required"})

    keys = repo.get_transaction_keys_by_id(transaction_id)
    if keys is None:
        return _json_response(404, {"error": "transaction not found"})

    if not repo.update_transaction_category(keys["pk"], keys["sk"], category):
        return _json_response(404, {"error": "transaction not found"})

    return _json_response(200, {"transaction_id": transaction_id, "category": category})


def get_recent_transactions(repo: TransactionRepository) -> list[dict]:
    # calculate date range
    today = datetime.now(timezone.utc).date()
    start_date = (today - timedelta(days=7)).isoformat()
    end_date = (
        today + timedelta(days=1)
    ).isoformat()  # +1 day covers AEST dates ahead of UTC

    all_recent_transactions = []
    # query each account
    for account_id in ACCOUNT_ID_MAP.values():
        recent_transactions, _ = repo.get_transactions_by_date_range(
            account_id, start_date, end_date=end_date
        )
        all_recent_transactions.extend(recent_transactions)

    # remove pk and sk before returning to api, and ensure sparse fields default to None
    for txn in all_recent_transactions:
        txn.pop("pk", None)
        txn.pop("sk", None)
        txn.setdefault("category", None)

    # sort all transactions by date, newest first
    sorted_all_recent_transactions = sorted(
        all_recent_transactions, key=lambda txn: txn["date"], reverse=True
    )

    return sorted_all_recent_transactions
