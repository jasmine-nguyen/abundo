from constants import (
    ACCOUNT_ID_MAP,
    BUDGET_PATH,
    CATEGORY_BUCKETS,
    CATEGORY_PATH,
    DEFAULT_CATEGORY_ICON,
    DEFAULT_RULE_FIELD,
    DEFAULT_RULE_OPERATOR,
    ENRICHMENTS_PATH,
    MAX_PAGE_SIZE,
    PAYCYCLE_LENGTHS,
    PAYCYCLE_PATH,
    PENDING_STATUS,
    POSTED_STATUS,
    RULE_FIELDS,
    RULE_OPERATORS,
    TRANSACTION_PATH,
)
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from repository import (
    BudgetRepository,
    CategoryNotFoundError,
    CategoryRepository,
    DuplicateCategoryError,
    PayCycleRepository,
    TransactionRepository,
    VersionConflictError,
)
from banksync_enrichments import (
    BankSyncError,
    create_rule,
    delete_rule,
    list_rules,
    update_rule,
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
            # Window is derived server-side from the stored pay cycle; a stale
            # client's ?days= is simply not read (ignored, never a 400).
            return _json_response(
                200,
                list_budgets(
                    BudgetRepository(), TransactionRepository(), PayCycleRepository()))

        if path.startswith(f"{BUDGET_PATH}/") and method == "PUT":
            return set_budget(event, BudgetRepository())

        if path == PAYCYCLE_PATH and method == "GET":
            return _json_response(200, PayCycleRepository().get_paycycle())

        if path == PAYCYCLE_PATH and method == "PUT":
            return set_paycycle(event, PayCycleRepository())

        # Enrichments (BankSync categorisation rules). These sit behind the API
        # Gateway authorizer (unlike the routes above), because they mutate
        # BankSync — our source of truth.
        if path == ENRICHMENTS_PATH and method == "GET":
            return get_enrichments()

        if path == ENRICHMENTS_PATH and method == "POST":
            return create_enrichment(event)

        if path.startswith(f"{ENRICHMENTS_PATH}/") and method == "PUT":
            return update_enrichment(event)

        if path.startswith(f"{ENRICHMENTS_PATH}/") and method == "DELETE":
            return delete_enrichment(event)

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


def _banksync_error_response(error: BankSyncError) -> dict:
    """Translate a BankSync failure into the status WE return to the app.

    A bad rule we sent (400/422) is the client's fault -> 400. Everything else —
    an auth failure on OUR key (401/403), a BankSync 5xx, or an unreachable host
    (upstream_status None) — is an upstream problem, not the caller's -> 502. The
    raw upstream error and the API key are never surfaced.
    """
    if error.upstream_status in (400, 422):
        return _json_response(400, {"error": "invalid enrichment rule"})
    return _json_response(502, {"error": "enrichment service unavailable"})


def get_enrichments() -> dict:
    """GET /enrichments — list the categorisation rules from BankSync."""
    try:
        return _json_response(200, list_rules())
    except BankSyncError as e:
        return _banksync_error_response(e)


def _validate_rule_body(event: dict):
    """Parse + validate a create/update rule body, returning the NORMALISED
    values so create and update trim/default identically.

    Returns ((value, category_id, field, operator), None) on success — value and
    category_id already stripped, field/operator defaulted to the Tier-1
    "description contains" and restricted to the verified vocabulary — or
    (None, error_response) with a 400.
    """
    body, error = _parse_json_body(event)
    if error:
        return None, error

    value = body.get("value")
    if not isinstance(value, str) or not value.strip():
        return None, _json_response(400, {"error": "value is required"})

    category_id = body.get("categoryId")
    if not isinstance(category_id, str) or not category_id.strip():
        return None, _json_response(400, {"error": "categoryId is required"})

    field = body.get("field", DEFAULT_RULE_FIELD)
    if field not in RULE_FIELDS:
        return None, _json_response(400, {"error": f"field must be one of {sorted(RULE_FIELDS)}"})

    operator = body.get("operator", DEFAULT_RULE_OPERATOR)
    if operator not in RULE_OPERATORS:
        return None, _json_response(
            400, {"error": f"operator must be one of {sorted(RULE_OPERATORS)}"})

    return (value.strip(), category_id.strip(), field, operator), None


def create_enrichment(event: dict) -> dict:
    """POST /enrichments — create a categorisation rule in BankSync.

    Body: {"value": <str>, "categoryId": <slug>, "field"?, "operator"?}. `field`
    and `operator` default to a plain "description contains" match (what the
    current in-app UI produces) and are otherwise restricted to the Tier-1
    verified vocabulary — an unverified operator is rejected 400 before it can
    reach BankSync.
    """
    parsed, error = _validate_rule_body(event)
    if error:
        return error
    value, category_id, field, operator = parsed

    try:
        rule = create_rule(field, operator, value, category_id)
    except BankSyncError as e:
        return _banksync_error_response(e)

    return _json_response(201, rule)


def update_enrichment(event: dict) -> dict:
    """PUT /enrichments/{id} — replace a categorisation rule in BankSync.

    Same body + validation as create. Editing a rule that no longer exists is a
    real 404 (not an idempotent no-op like delete), so an upstream 404 is mapped
    to 404 rather than the default 502.
    """
    enrichment_id = (event.get("pathParameters") or {}).get("id")
    if not enrichment_id:
        return _json_response(404, {"error": "enrichment not found"})

    parsed, error = _validate_rule_body(event)
    if error:
        return error
    value, category_id, field, operator = parsed

    try:
        rule = update_rule(enrichment_id, field, operator, value, category_id)
    except BankSyncError as e:
        if e.upstream_status == 404:
            return _json_response(404, {"error": "enrichment not found"})
        return _banksync_error_response(e)

    return _json_response(200, rule)


def delete_enrichment(event: dict) -> dict:
    """DELETE /enrichments/{id} — remove a categorisation rule from BankSync.

    Idempotent: an unknown/already-gone id still returns 200 (the underlying
    client swallows BankSync's 404).
    """
    enrichment_id = (event.get("pathParameters") or {}).get("id")
    if not enrichment_id:
        return _json_response(404, {"error": "enrichment not found"})

    try:
        delete_rule(enrichment_id)
    except BankSyncError as e:
        return _banksync_error_response(e)

    return _json_response(200, {"id": enrichment_id})


_MELBOURNE = None  # ZoneInfo("Australia/Melbourne"), built lazily on first use.


def _melbourne_today() -> date:
    """Today's date in the user's timezone (Australia/Melbourne), so the budget
    window resets at LOCAL midnight on payday, not UTC midnight.

    Built lazily and cached. If the tzdata package is ever missing from the layer,
    ZoneInfo raises here (only the budget path, not at module import). We catch that
    and FAIL SAFE to UTC: /budgets keeps working with a reset that's off by at most
    a day at the UTC/Melbourne seam, rather than 500ing the whole budget path. Melbourne
    observes DST (+10/+11) so a fixed offset isn't a substitute for the tz database
    — UTC is only the degraded fallback, and the WARN makes the packaging gap loud.
    """
    global _MELBOURNE
    if _MELBOURNE is None:
        try:
            _MELBOURNE = ZoneInfo("Australia/Melbourne")
        except ZoneInfoNotFoundError:
            print("WARN: tzdata unavailable in layer; budget window falling back to UTC today")
            return datetime.now(timezone.utc).date()
    return datetime.now(_MELBOURNE).date()


def current_cycle_window(last_pay_date: str, length: int, today: date | None = None) -> tuple[str, str]:
    """Return (start, end) ISO dates for the CURRENT pay cycle: the inclusive
    window [cycle_start, today] that resets on the user's payday.

    `cycle_start` is the most recent payday on or before today — the latest
    `last_pay_date + k*length` days (integer k >= 0) that is <= today. `today` defaults
    to the Melbourne-local date (injectable for deterministic tests). Both bounds are
    inclusive: transaction `date` is stored date-only (YYYY-MM-DD) and the date-range
    query uses DynamoDB `between`, which is inclusive on both ends, so `end = today`
    covers all of today's spend while excluding tomorrow's (WHIT-75 — a `today+1` end
    used to leak a transaction dated tomorrow into the cycle). cycle_start is inclusive,
    so payday spend lands in the fresh cycle.

    A future last_pay_date has no valid k (Slice 1 rejects one at write, but stay safe):
    max(0, ...) plus the cycle_start>today clamp keep the window from inverting (they
    collapse it to the single inclusive day [today, today]).
    """
    if today is None:
        today = _melbourne_today()
    pay_date = date.fromisoformat(last_pay_date)
    elapsed_days = (today - pay_date).days
    cycles_elapsed = max(0, elapsed_days // length)
    cycle_start = pay_date + timedelta(days=cycles_elapsed * length)
    if cycle_start > today:
        cycle_start = today
    end = today
    return cycle_start.isoformat(), end.isoformat()


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


def list_budgets(
    budget_repo: BudgetRepository,
    transaction_repo: TransactionRepository,
    paycycle_repo: PayCycleRepository,
) -> dict:
    """GET /budgets — per budgeted category, the target plus posted/pending spend
    computed on-read (approach C) over the current pay-cycle window.

    The window resets on the user's payday: it reads the stored pay cycle and sums
    transactions over the inclusive [cycle_start, today]. posted/pending are summed from the
    window's transactions (nothing stored), so a pending->posted settlement or an
    amount change is reflected on the next call with no bookkeeping. Every budgeted
    id appears; a category with no spend this window is posted/pending 0.
    DecimalEncoder renders all three as JSON numbers. Empty {} before any target is
    set — and the pay-cycle read AND the transaction scan are both skipped.
    """
    targets = budget_repo.list_budgets()  # {id: {"target": Decimal}}
    if not targets:
        return {}
    cycle = paycycle_repo.get_paycycle()
    start, end = current_cycle_window(cycle["last_pay_date"], cycle["length"])
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

    Body: {"length": <7|14|30>, "last_pay_date": "YYYY-MM-DD"} where last_pay_date is a real
    past payday. Both fields are required and validated here (the repository just
    persists): length must be one the client offers, last_pay_date must be a valid ISO
    date that isn't in the future — a future last_pay_date has no cycle_start <= today,
    which would break the payday-window math in Slice 2.

    The "not in the future" ceiling is today + 1 day, matching the +1-day slack
    the rest of the API uses because AEST dates run up to a day ahead of UTC; the
    precise Australia/Melbourne reset lands with the window math in Slice 2.
    """
    body, error = _parse_json_body(event)
    if error:
        return error

    length = body.get("length")
    # bool is an int subclass, so reject it before the membership check.
    if isinstance(length, bool) or length not in PAYCYCLE_LENGTHS:
        return _json_response(
            400, {"error": f"length must be one of {sorted(PAYCYCLE_LENGTHS)}"})

    last_pay_date = body.get("last_pay_date")
    if not isinstance(last_pay_date, str):
        return _json_response(400, {"error": "last_pay_date must be a YYYY-MM-DD date string"})
    try:
        pay_date = date.fromisoformat(last_pay_date)
    except ValueError:
        return _json_response(400, {"error": "last_pay_date must be a valid YYYY-MM-DD date"})
    if pay_date > datetime.now(timezone.utc).date() + timedelta(days=1):
        return _json_response(400, {"error": "last_pay_date cannot be in the future"})

    saved = repo.set_paycycle(length, last_pay_date)
    return _json_response(200, saved)
