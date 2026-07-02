from constants import (
    ACCOUNT_ID_MAP,
    CATEGORY_BUCKETS,
    CATEGORY_PATH,
    DEFAULT_CATEGORY_ICON,
    TRANSACTION_PATH,
)
from datetime import datetime, timedelta, timezone
from repository import (
    CategoryNotFoundError,
    CategoryRepository,
    DuplicateCategoryError,
    TransactionRepository,
)
from encoders import DecimalEncoder
import base64
import json
import re


def lambda_handler(event, context):
    path = event.get("rawPath", "")
    method = event.get("requestContext", {}).get("http", {}).get("method", "")

    if path == TRANSACTION_PATH and method == "GET":
        repo = TransactionRepository()
        return _json_response(200, get_recent_transactions(repo))

    if path.startswith(f"{TRANSACTION_PATH}/") and method == "PATCH":
        return patch_transaction_category(event, TransactionRepository())

    if path == CATEGORY_PATH and method == "GET":
        return _json_response(200, list_categories(CategoryRepository()))

    if path == CATEGORY_PATH and method == "POST":
        return create_category(event, CategoryRepository())

    if path.startswith(f"{CATEGORY_PATH}/") and method == "PATCH":
        return rename_category(event, CategoryRepository())

    if path.startswith(f"{CATEGORY_PATH}/") and method == "DELETE":
        return delete_category(event, CategoryRepository())

    return _json_response(404, {"error": "Not found"})


def _json_response(status_code: int, body: dict | list) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, cls=DecimalEncoder),
    }


def _parse_json_body(event: dict):
    """Decode a possibly-base64 JSON *object* body.

    Returns (body, None) on success, or (None, error_response) with a 400 when the
    body isn't valid JSON or isn't a JSON object. Shared by the PATCH and POST
    handlers so the base64/UTF-8 handling never diverges.
    """
    raw_body = event.get("body") or ""
    try:
        if event.get("isBase64Encoded"):
            # b64decode raises binascii.Error and .decode raises UnicodeDecodeError —
            # both ValueError subclasses, so a malformed/binary body yields a clean 400.
            raw_body = base64.b64decode(raw_body).decode("utf-8")
        body = json.loads(raw_body)
    except (json.JSONDecodeError, ValueError):
        return None, _json_response(400, {"error": "invalid JSON body"})
    if not isinstance(body, dict):
        return None, _json_response(400, {"error": "invalid JSON body"})
    return body, None


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

    body, error = _parse_json_body(event)
    if error:
        return error

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


def _slugify(name: str) -> str:
    """Reduce a display name to a lowercase alphanumeric slug id. May return ""
    (e.g. a purely non-ASCII/punctuation name), which the caller rejects as 400."""
    return re.sub(r"[^a-z0-9]+", "", name.strip().lower())


def list_categories(repo: CategoryRepository) -> list[dict]:
    # `recent` is client-derived (not stored); default it so the client Cat shape holds.
    return [{**cat, "recent": 0} for cat in repo.list_categories()]


def create_category(event: dict, repo: CategoryRepository) -> dict:
    """POST /categories — create a category from name/bucket/icon.

    The id is a slug of the name (the shared BankSync/category vocabulary), color
    is server-assigned, and icon is optional (defaults when omitted).
    """
    body, error = _parse_json_body(event)
    if error:
        return error

    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        return _json_response(400, {"error": "name is required"})

    bucket = body.get("bucket")
    if bucket not in CATEGORY_BUCKETS:
        return _json_response(400, {"error": "invalid bucket"})

    icon = body.get("icon")
    icon = icon.strip() if isinstance(icon, str) and icon.strip() else DEFAULT_CATEGORY_ICON

    cat_id = _slugify(name)
    if not cat_id:
        return _json_response(400, {"error": "name has no slug-safe characters"})

    try:
        created = repo.create_category(cat_id, name.strip(), bucket, icon)
    except DuplicateCategoryError:
        return _json_response(409, {"error": "category already exists"})

    return _json_response(201, {**created, "recent": 0})


def rename_category(event: dict, repo: CategoryRepository) -> dict:
    """PATCH /categories/{id} — rename a category (display name only; id immutable)."""
    cat_id = (event.get("pathParameters") or {}).get("id")
    if not cat_id:
        return _json_response(404, {"error": "category not found"})

    body, error = _parse_json_body(event)
    if error:
        return error

    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        return _json_response(400, {"error": "name is required"})

    try:
        updated = repo.rename_category(cat_id, name.strip())
    except CategoryNotFoundError:
        return _json_response(404, {"error": "category not found"})

    return _json_response(200, {**updated, "recent": 0})


def delete_category(event: dict, repo: CategoryRepository) -> dict:
    """DELETE /categories/{id} — hard-delete a category. No server-side cascade;
    transactions still referencing the id render as Uncategorized client-side.
    """
    cat_id = (event.get("pathParameters") or {}).get("id")
    if not cat_id:
        return _json_response(404, {"error": "category not found"})

    try:
        repo.delete_category(cat_id)
    except CategoryNotFoundError:
        return _json_response(404, {"error": "category not found"})

    return _json_response(200, {"id": cat_id})
