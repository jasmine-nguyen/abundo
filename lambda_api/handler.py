from constants import (
    ACCOUNT_ID_MAP,
    BUDGET_PATH,
    CATEGORY_BUCKETS,
    CATEGORY_PATH,
    CYCLE_WINDOW_DAYS,
    DEFAULT_CATEGORY_ICON,
    MAX_PAGE_SIZE,
    PAYCYCLE_LENGTHS,
    PAYCYCLE_PATH,
    PENDING_STATUS,
    POSTED_STATUS,
    TRANSACTION_PATH,
)
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from repository import (
    BudgetRepository,
    CategoryNotFoundError,
    CategoryRepository,
    DuplicateCategoryError,
    PayCycleRepository,
    TransactionRepository,
    VersionConflictError,
)
from encoders import DecimalEncoder
import base64
import json
import math
import re


def lambda_handler(event, context):
    path = event.get("rawPath", "")
    method = event.get("requestContext", {}).get("http", {}).get("method", "")

    # A config-item write that loses the optimistic-lock race past its retry budget
    # is a conflict, not a server fault — map it to 409 for every route in one place.
    try:
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
            return update_category(event, CategoryRepository())

        if path.startswith(f"{CATEGORY_PATH}/") and method == "DELETE":
            return delete_category(event, CategoryRepository())

        if path == BUDGET_PATH and method == "GET":
            length_days = _budget_window_days(event)
            return _json_response(
                200, list_budgets(BudgetRepository(), TransactionRepository(), length_days))

        if path.startswith(f"{BUDGET_PATH}/") and method == "PUT":
            return set_budget(event, BudgetRepository())

        if path == PAYCYCLE_PATH and method == "GET":
            return _json_response(200, PayCycleRepository().get_paycycle())

        if path == PAYCYCLE_PATH and method == "PUT":
            return set_paycycle(event, PayCycleRepository())

        return _json_response(404, {"error": "Not found"})
    except VersionConflictError:
        return _json_response(409, {"error": "write conflict, please retry"})


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


def update_category(event: dict, repo: CategoryRepository) -> dict:
    """PATCH /categories/{id} — update a category's name, bucket, and icon.

    The id/slug (e.g. "groceries") is immutable and color is server-owned, so
    neither is editable — renaming "Groceries" to "Supermarket" keeps the id
    "groceries". Validation mirrors create; icon is optional (defaults when
    omitted).
    """
    cat_id = (event.get("pathParameters") or {}).get("id")
    if not cat_id:
        return _json_response(404, {"error": "category not found"})

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

    try:
        updated = repo.update_category(cat_id, name.strip(), bucket, icon)
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


def current_cycle_window(length_days: int = CYCLE_WINDOW_DAYS) -> tuple[str, str]:
    """Return (start, end) ISO dates for the current budget window: the last
    `length_days` days through today.

    INTERIM: a rolling window, NOT yet aligned to a pay-cycle anchor (real
    payday-reset is P14). Isolated here on purpose — when P14 lands, only this
    function changes; the sum logic, the API shape, and the client stay put. The
    +1-day end mirrors get_recent_transactions (AEST dates can run a day ahead of
    UTC), so today's transactions are always included.
    """
    today = datetime.now(timezone.utc).date()
    start = (today - timedelta(days=length_days)).isoformat()
    end = (today + timedelta(days=1)).isoformat()
    return start, end


def summarise_transactions(transactions: list[dict], target_ids: set[str]) -> dict[str, dict]:
    """Sum posted vs pending spend per budgeted category over `transactions`.

    A transaction contributes only if it counts toward a budget: `counts_to_budget`
    is truthy AND its `category` is a real budgeted id (not None, not "income", and
    present in `target_ids`). Spend is stored as a NEGATIVE amount, so we sum
    `-amount` — a refund (positive amount) reduces the total. Each bucket is clamped
    at >= 0 so a net refund can't drive a bar negative. Pending vs posted is decided
    by the transaction's own `status`, so a pending->posted settlement needs no
    special handling: the next call just re-reads the current status.

    Returns {category_id: {"posted": Decimal, "pending": Decimal}} for categories
    that had at least one contributing transaction.
    """
    totals: dict[str, dict] = {}
    for transaction in transactions:
        if not transaction.get("counts_to_budget"):
            continue
        category = transaction.get("category")
        if category is None or category == "income" or category not in target_ids:
            continue
        status = transaction.get("status")
        if status == PENDING_STATUS:
            bucket = "pending"
        elif status == POSTED_STATUS:
            bucket = "posted"
        else:
            continue  # unknown status -> don't guess a bucket
        entry = totals.setdefault(category, {"posted": Decimal(0), "pending": Decimal(0)})
        entry[bucket] += -Decimal(str(transaction.get("amount", 0)))
    for entry in totals.values():
        entry["posted"] = max(Decimal(0), entry["posted"])
        entry["pending"] = max(Decimal(0), entry["pending"])
    return totals


def _fetch_windowed_transactions(repo: TransactionRepository, start: str, end: str) -> list[dict]:
    """Every transaction across all accounts within [start, end], following the
    date-index pagination to completion.

    A rollup must sum the WHOLE window, so — unlike the recent-transactions feed,
    which reads only the first page — this loops on the returned cursor until the
    account is exhausted.
    """
    transactions: list[dict] = []
    for account_id in ACCOUNT_ID_MAP.values():
        cursor = None
        while True:
            page, cursor = repo.get_transactions_by_date_range(
                account_id, start, end, limit=MAX_PAGE_SIZE, cursor=cursor
            )
            transactions.extend(page)
            if not cursor:
                break
    return transactions


def _budget_window_days(event: dict) -> int:
    """Rolling-window length (days) from the ?days=N query string, else the default.

    The client sends its pay-cycle length so the window matches (7/14/30). A
    missing / non-numeric / out-of-range value falls back to CYCLE_WINDOW_DAYS
    rather than erroring — the param is an optimisation, not required.
    """
    raw = (event.get("queryStringParameters") or {}).get("days")
    try:
        days = int(raw)
    except (TypeError, ValueError):
        return CYCLE_WINDOW_DAYS
    if days < 1 or days > 366:
        return CYCLE_WINDOW_DAYS
    return days


def list_budgets(
    budget_repo: BudgetRepository,
    transaction_repo: TransactionRepository,
    length_days: int = CYCLE_WINDOW_DAYS,
) -> dict:
    """GET /budgets — per budgeted category, the target plus posted/pending spend
    computed on-read (approach C) over the current window.

    posted/pending are summed from the window's transactions (nothing stored), so
    a pending->posted settlement or an amount change is reflected on the next call
    with no bookkeeping. Every budgeted id appears; a category with no spend this
    window is posted/pending 0. DecimalEncoder renders all three as JSON numbers.
    Empty {} before any target is set (and the transaction scan is skipped).
    """
    targets = budget_repo.list_budgets()  # {id: {"target": Decimal}}
    if not targets:
        return {}
    start, end = current_cycle_window(length_days)
    transactions = _fetch_windowed_transactions(transaction_repo, start, end)
    rollups = summarise_transactions(transactions, set(targets))
    result = {}
    for cat_id, entry in targets.items():
        spend = rollups.get(cat_id)
        result[cat_id] = {
            "target": entry["target"],
            "posted": spend["posted"] if spend else Decimal(0),
            "pending": spend["pending"] if spend else Decimal(0),
        }
    return result


def set_budget(event: dict, repo: BudgetRepository) -> dict:
    """PUT /budgets/{category} — set (upsert) a category's budget target.

    Body: {"target": <number >= 0>} — the user-set pay-cycle amount (spent/pending
    are derived elsewhere, not here). The target is stored as a Decimal via
    Decimal(str(...)) so a JSON float never introduces binary-float drift. An
    unknown category id is accepted (stored as an orphan the client ignores),
    rather than coupling this to a category-existence read.
    """
    cat_id = (event.get("pathParameters") or {}).get("category")
    if not cat_id:
        return _json_response(404, {"error": "budget not found"})

    body, error = _parse_json_body(event)
    if error:
        return error

    target = body.get("target")
    # bool is an int subclass, so reject it explicitly before the numeric check.
    if isinstance(target, bool) or not isinstance(target, (int, float)):
        return _json_response(400, {"error": "target must be a number"})
    # json.loads accepts NaN/Infinity by default; DynamoDB rejects them at write.
    if not math.isfinite(target):
        return _json_response(400, {"error": "target must be a finite number"})
    if target < 0:
        return _json_response(400, {"error": "target must be >= 0"})
    # Absurd for a personal budget; also keeps a giant value from blowing past
    # DynamoDB's number limit and 500ing at write instead of a clean 400.
    if target > 1_000_000_000:
        return _json_response(400, {"error": "target too large"})

    saved = repo.set_budget(cat_id, Decimal(str(target)))
    return _json_response(200, saved)


def set_paycycle(event: dict, repo: PayCycleRepository) -> dict:
    """PUT /paycycle — set (replace) the persisted pay cycle.

    Body: {"length": <7|14|30>, "anchor": "YYYY-MM-DD"} where anchor is a real
    past payday. Both fields are required and validated here (the repository just
    persists): length must be one the client offers, anchor must be a valid ISO
    date that isn't in the future — a future anchor has no cycle_start <= today,
    which would break the payday-window math in Slice 2.

    The "not in the future" ceiling is today + 1 day, matching the +1-day slack
    the rest of the API uses because AEST dates run up to a day ahead of UTC; the
    precise Australia/Sydney reset lands with the window math in Slice 2.
    """
    body, error = _parse_json_body(event)
    if error:
        return error

    length = body.get("length")
    # bool is an int subclass, so reject it before the membership check.
    if isinstance(length, bool) or length not in PAYCYCLE_LENGTHS:
        return _json_response(
            400, {"error": f"length must be one of {sorted(PAYCYCLE_LENGTHS)}"})

    anchor = body.get("anchor")
    if not isinstance(anchor, str):
        return _json_response(400, {"error": "anchor must be a YYYY-MM-DD date string"})
    try:
        anchor_date = date.fromisoformat(anchor)
    except ValueError:
        return _json_response(400, {"error": "anchor must be a valid YYYY-MM-DD date"})
    if anchor_date > datetime.now(timezone.utc).date() + timedelta(days=1):
        return _json_response(400, {"error": "anchor cannot be in the future"})

    saved = repo.set_paycycle(length, anchor)
    return _json_response(200, saved)
