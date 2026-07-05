from constants import (
    ACCOUNT_ID_MAP,
    BREAKDOWN_PATH,
    BUDGET_PATH,
    CATEGORY_BUCKETS,
    CATEGORY_PATH,
    DEFAULT_CATEGORY_ICON,
    DEFAULT_RULE_FIELD,
    DEFAULT_RULE_OPERATOR,
    DEVICES_PATH,
    ENRICHMENTS_PATH,
    EXPO_TOKEN_MAX_LEN,
    FEED_WINDOW_DAYS,
    HOMELOAN_ACCOUNT_ID,
    HOMELOAN_PATH,
    INCOME_BUCKET,
    INSIGHTS_AI_PATH,
    INSIGHTS_PRIOR_CYCLES,
    INTEREST_CATEGORY,
    LOANFACTS_FIELD_MAX,
    LOANFACTS_PATH,
    MAX_PAGE_SIZE,
    PAYCYCLE_LENGTHS,
    PAYCYCLE_PATH,
    REPAYMENT_INCOMING_TYPE,
    REPAYMENT_PATH,
    RULE_FIELDS,
    RULE_OPERATORS,
    SPEND_BUCKETS,
    TRANSACTION_BATCH_MAX,
    TRANSACTION_PATH,
    UNCATEGORIZED_KEY,
)
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from repository import (
    BudgetRepository,
    CategoryNotFoundError,
    CategoryRepository,
    DatabaseError,
    DeviceRepository,
    DuplicateCategoryError,
    HomeLoanBalanceRepository,
    InsightRepository,
    LoanFactsRepository,
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
# The pay-cycle window + spend summariser live in the shared layer (WHIT-22) so the
# webhook's budget-alert detection computes spend identically to this read API.
from spend import (
    _melbourne_today,
    _spend_contribution,
    current_cycle_window,
    summarise_income,
    summarise_transactions,
    summarise_uncategorized,
)
from insights_ai import AnthropicError, generate_suggestions
from encoders import DecimalEncoder
import base64
import hashlib
import json
import logging
import math
import re

logger = logging.getLogger(__name__)


def lambda_handler(event, context):
    path = event.get("rawPath", "")
    method = event.get("requestContext", {}).get("http", {}).get("method", "")

    # A config-item write that loses the optimistic-lock race past its retry budget
    # is a conflict, not a server fault — map it to 409 for every route in one place.
    try:
        if path == TRANSACTION_PATH and method == "GET":
            repo = TransactionRepository()
            return _json_response(200, get_recent_transactions(repo))

        # Collection route (batch) BEFORE the item route. "/transactions" does not
        # start with "/transactions/", so the two are disjoint regardless of order.
        if path == TRANSACTION_PATH and method == "PATCH":
            return patch_transactions_batch(event, TransactionRepository())

        if path.startswith(f"{TRANSACTION_PATH}/") and method == "PATCH":
            return patch_transaction_category(event, TransactionRepository())

        if path == CATEGORY_PATH and method == "GET":
            return _json_response(200, list_categories(CategoryRepository()))

        if path == CATEGORY_PATH and method == "POST":
            return create_category(event, CategoryRepository())

        if path.startswith(f"{CATEGORY_PATH}/") and method == "PATCH":
            return update_category(event, CategoryRepository())

        if path.startswith(f"{CATEGORY_PATH}/") and method == "DELETE":
            return delete_category(event, CategoryRepository(), BudgetRepository())

        if path == BUDGET_PATH and method == "GET":
            # Window is derived server-side from the stored pay cycle; a stale
            # client's ?days= is simply not read (ignored, never a 400).
            return _json_response(
                200,
                list_budgets(
                    BudgetRepository(), TransactionRepository(), PayCycleRepository(),
                    CategoryRepository()))

        if path.startswith(f"{BUDGET_PATH}/") and method == "PUT":
            return set_budget(event, BudgetRepository())

        if path == BREAKDOWN_PATH and method == "GET":
            # Spend by category for the current cycle (window derived server-side
            # from the stored pay cycle, like /budgets).
            return _json_response(
                200,
                list_category_breakdown(
                    CategoryRepository(), TransactionRepository(), PayCycleRepository()))

        # AI spending insights (WHIT-104). GET reads the per-cycle cache (never
        # pays); POST generates (the paid Anthropic call). Both are authorizer-gated
        # at the API Gateway route, like /enrichments.
        if path == INSIGHTS_AI_PATH and method == "GET":
            return _json_response(200, get_ai_insights(
                InsightRepository(), PayCycleRepository()))

        if path == INSIGHTS_AI_PATH and method == "POST":
            return generate_ai_insights(
                CategoryRepository(), BudgetRepository(), TransactionRepository(),
                PayCycleRepository(), InsightRepository(), event)

        if path == HOMELOAN_PATH and method == "GET":
            return _json_response(200, get_homeloan(HomeLoanBalanceRepository()))

        if path == REPAYMENT_PATH and method == "GET":
            return _json_response(200, get_repayment(TransactionRepository()))

        if path == LOANFACTS_PATH and method == "GET":
            return _json_response(200, get_loanfacts(LoanFactsRepository()))

        if path == LOANFACTS_PATH and method == "PUT":
            return set_loanfacts(event, LoanFactsRepository())

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

        # Device push-token registration. Behind the same shared-secret authorizer
        # as /enrichments (it controls who receives the user's notifications).
        if path == DEVICES_PATH and method == "POST":
            return register_device(event, DeviceRepository())

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


def register_device(event: dict, repo: DeviceRepository) -> dict:
    """POST /devices — register an Expo push token so this device gets notified.

    Idempotent by construction: the store is a String Set, so re-registering the
    same token is a no-op. Rejects anything that isn't a plausibly-real Expo token
    (right prefix, bounded length) so junk never accumulates in the token set.
    """
    body, error = _parse_json_body(event)
    if error:
        return error
    token = body.get("token")
    if not isinstance(token, str) or not token.strip():
        return _json_response(400, {"error": "token is required"})
    token = token.strip()
    if len(token) > EXPO_TOKEN_MAX_LEN or not token.startswith(
        ("ExpoPushToken[", "ExponentPushToken[")
    ):
        return _json_response(400, {"error": "invalid Expo push token"})
    repo.register(token)
    return _json_response(200, {"token": token})


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


def patch_transactions_batch(event: dict, repo: TransactionRepository) -> dict:
    """PATCH /transactions — set the category on many transactions in one request.

    Body: {"updates": [{"id": "<txn id>", "category": "<non-empty string>"}, ...]}.
    This exists so the "All from this merchant" sweep persists in ONE round-trip
    instead of N single PATCHes. Each update is applied INDEPENDENTLY (best-effort):
    the response is {"results": [{"id", "status"}, ...]} where status is "updated"
    or "not_found", so one unknown/vanished row doesn't fail the whole batch. Per-
    item validation mirrors the single route (any non-empty category string — the
    taxonomy is not enforced here, matching PATCH /transactions/{id}). A missing/
    non-list/empty `updates`, an oversized batch, or a malformed item is a 400.
    """
    body, error = _parse_json_body(event)
    if error:
        return error

    updates = body.get("updates")
    if not isinstance(updates, list) or not updates:
        return _json_response(400, {"error": "updates is required"})
    if len(updates) > TRANSACTION_BATCH_MAX:
        return _json_response(400, {"error": f"too many updates (max {TRANSACTION_BATCH_MAX})"})
    for item in updates:
        if not isinstance(item, dict):
            return _json_response(400, {"error": "each update must be an object"})
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            return _json_response(400, {"error": "id is required"})
        category = item.get("category")
        if not isinstance(category, str) or not category.strip():
            return _json_response(400, {"error": "category is required"})

    results = repo.update_transaction_categories(updates)
    return _json_response(200, {"results": results})


def get_recent_transactions(repo: TransactionRepository) -> list[dict]:
    # The last FEED_WINDOW_DAYS days, inclusive, on the user's clock. `today` is
    # Melbourne-local — the SAME clock the budget window uses (_melbourne_today) —
    # so the feed and the budget bar agree on where "today" ends: no UTC/Melbourne
    # ±1-day seam near midnight, and no `today + 1` end leaking a tomorrow-dated
    # charge into the list (the leak WHIT-75 removed from the budget window).
    # This is a rolling 7-day view, independent of the pay cycle by design.
    today = _melbourne_today()
    start_date = (today - timedelta(days=FEED_WINDOW_DAYS)).isoformat()
    end_date = today.isoformat()

    # Every row in the window across all accounts, following the date-index cursor
    # to exhaustion — the feed must not silently truncate at one page/account.
    all_recent_transactions = _fetch_windowed_transactions(repo, start_date, end_date)

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


def delete_category(
    event: dict, repo: CategoryRepository, budget_repo: BudgetRepository
) -> dict:
    """DELETE /categories/{id} — hard-delete a category, then cascade-delete its
    budget target so a stale target can't linger (and silently reappear if a
    same-slug category is later re-created). Transactions still referencing the id
    render as Uncategorized client-side (intended — they need re-filing).
    """
    cat_id = (event.get("pathParameters") or {}).get("id")
    if not cat_id:
        return _json_response(404, {"error": "category not found"})

    try:
        repo.delete_category(cat_id)
    except CategoryNotFoundError:
        return _json_response(404, {"error": "category not found"})

    # Cascade AFTER the category is gone. Category-first is the safe failure order:
    # a failed cascade only leaves the orphan target (today's behaviour, recoverable),
    # whereas deleting the budget first then failing the category delete would drop a
    # target for a still-live category — real loss. Per WHIT-73 the cascade must not
    # fail the delete, so it is best-effort: log and return 200 if it can't complete.
    try:
        budget_repo.delete_budget(cat_id)
    except (VersionConflictError, DatabaseError) as e:
        logger.warning("budget cascade failed for deleted category %s: %s", cat_id, e)

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


# Safety ceiling on cursor-follow iterations per account. A bounded date-range
# query terminates on its own (LastEvaluatedKey eventually None), so reaching this
# many pages for a single account means the cursor is not advancing — a repo/
# contract bug. Fail loudly instead of spinning to the Lambda timeout. 1000 pages ×
# MAX_PAGE_SIZE is far beyond any real window, so a legitimate feed never hits it.
_MAX_PAGES_PER_ACCOUNT = 1000


def _fetch_windowed_transactions(repo: TransactionRepository, start: str, end: str) -> list[dict]:
    """Every transaction across all accounts within [start, end], following the
    date-index pagination to completion.

    Both the recent-transactions feed and the budget rollup need the WHOLE window,
    so this loops on the returned cursor until each account is exhausted rather than
    stopping at the first page. The loop is bounded (_MAX_PAGES_PER_ACCOUNT): a
    cursor that never terminates raises rather than hanging both endpoints.
    """
    transactions: list[dict] = []
    for account_id in ACCOUNT_ID_MAP.values():
        cursor = None
        pages = 0
        while True:
            page, cursor = repo.get_transactions_by_date_range(
                account_id, start, end, limit=MAX_PAGE_SIZE, cursor=cursor
            )
            transactions.extend(page)
            pages += 1
            if not cursor:
                break
            if pages >= _MAX_PAGES_PER_ACCOUNT:
                raise RuntimeError(
                    f"pagination for account {account_id} did not terminate after "
                    f"{_MAX_PAGES_PER_ACCOUNT} pages ({start}..{end}); aborting to "
                    f"avoid an unbounded read"
                )
    return transactions


def list_budgets(
    budget_repo: BudgetRepository,
    transaction_repo: TransactionRepository,
    paycycle_repo: PayCycleRepository,
    category_repo: CategoryRepository,
) -> dict:
    """GET /budgets — per budgeted category, the target plus posted/pending computed
    on-read (approach C) over the current pay-cycle window.

    The window resets on the user's payday: it reads the stored pay cycle and sums
    transactions over the inclusive [cycle_start, today]. posted/pending are summed from the
    window's transactions (nothing stored), so a pending->posted settlement or an
    amount change is reflected on the next call with no bookkeeping. Every budgeted
    id appears; a category with no activity this window is posted/pending 0.
    DecimalEncoder renders all three as JSON numbers. Empty {} before any target is
    set — and the pay-cycle read, category read AND the transaction scan are all skipped.

    A budget on an Income-bucket category is an earn-target (floor, over-is-good,
    WHIT-69): its posted/pending are POSITIVE earnings (summarise_income), not spend.
    Direction is inferred from the category's bucket, so the stored shape is unchanged
    and the client flips only the good/bad visuals. An orphan target whose category is
    unknown (or a non-Income bucket) is summed as spend — the existing ceiling default.
    """
    targets = budget_repo.list_budgets()  # {id: {"target": Decimal}}
    if not targets:
        return {}
    cycle = paycycle_repo.get_paycycle()
    start, end = current_cycle_window(cycle["last_pay_date"], cycle["length"])
    transactions = _fetch_windowed_transactions(transaction_repo, start, end)

    bucket_by_id = {c["id"]: c.get("bucket") for c in category_repo.list_categories()}
    income_ids = {cat_id for cat_id in targets if bucket_by_id.get(cat_id) == INCOME_BUCKET}
    spend_ids = set(targets) - income_ids

    rollups = summarise_transactions(transactions, spend_ids)
    rollups.update(summarise_income(transactions, income_ids))
    result = {}
    for cat_id, entry in targets.items():
        rollup = rollups.get(cat_id)
        result[cat_id] = {
            "target": entry["target"],
            "posted": rollup["posted"] if rollup else Decimal(0),
            "pending": rollup["pending"] if rollup else Decimal(0),
        }
    return result


def list_category_breakdown(
    category_repo: CategoryRepository,
    transaction_repo: TransactionRepository,
    paycycle_repo: PayCycleRepository,
) -> dict:
    """GET /breakdown — spend (posted + pending) per category for the current pay
    cycle, plus an "Uncategorized" bucket. The visual companion to /budgets: where
    the money actually went, not just budgeted categories.

    Same window + summariser as list_budgets, but over ALL spend-bucket categories
    rather than only budgeted ones. Income/Savings categories are excluded
    (SPEND_BUCKETS): they carry positive amounts that would clamp to $0 rows in a
    spend view. A category with no spend this cycle is omitted (summarise_transactions
    only returns contributors). The Uncategorized bucket (spend that counts to
    budget but isn't in the taxonomy — a raw enum, a deleted category, or null) is
    added only when it has spend, so a fully-categorised cycle shows no phantom row.

    Response: {"<category_id>": {"posted": Decimal, "pending": Decimal}, ...,
    optionally "__uncategorized__": {...}}. Empty {} when nothing had spend.
    """
    categories = category_repo.list_categories()
    cycle = paycycle_repo.get_paycycle()
    start, end = current_cycle_window(cycle["last_pay_date"], cycle["length"])
    transactions = _fetch_windowed_transactions(transaction_repo, start, end)

    all_ids = {c["id"] for c in categories}
    spend_ids = {c["id"] for c in categories if c.get("bucket") in SPEND_BUCKETS}

    result = summarise_transactions(transactions, spend_ids)

    uncategorized = summarise_uncategorized(transactions, all_ids)
    if uncategorized["posted"] > 0 or uncategorized["pending"] > 0:
        result[UNCATEGORIZED_KEY] = uncategorized
    return result


def _window_category_spend(transactions: list[dict], categories: list[dict],
                           targets: dict | None = None) -> list[dict]:
    """Spend-bucket categories with spend in `transactions`, as float rows the model
    can read: [{"name", "posted", "pending"}, ...]. Reuses summarise_transactions,
    so the contribution rule (counts_to_budget, real category, NEGATIVE amount) is
    identical to /breakdown. `targets` ({id: {"target": Decimal}}) is joined BY ID
    here (while the id is in hand) so the correct budget lands on each row — category
    display NAMES are not unique, so a name join would mis-attribute a budget."""
    spend_ids = {c["id"] for c in categories if c.get("bucket") in SPEND_BUCKETS}
    names = {c["id"]: c["name"] for c in categories}
    rollup = summarise_transactions(transactions, spend_ids)
    rows = []
    for cid, entry in rollup.items():
        row = {"name": names.get(cid, cid),
               "posted": float(entry["posted"]),
               "pending": float(entry["pending"])}
        if targets and cid in targets:
            row["budget"] = float(targets[cid]["target"])
        rows.append((row["name"], cid, row))
    # Sort by (name, id) so the row order is stable regardless of DynamoDB's
    # transaction return order -> the input_hash is deterministic and cache hits are
    # reliable (an unstable order would look like changed input and pay for a needless
    # call). id breaks ties because display names are NOT unique.
    rows.sort(key=lambda t: (t[0], t[1]))
    return [row for _name, _cid, row in rows]


_GOAL_PAYOFF_MODES = {"partial", "flat", "ahead"}
# The projected payoff label the client sends, e.g. "Nov 2042" — the one free-form
# string in an otherwise numbers-only goal, and the one value the prompt echoes. Pin
# its exact shape so a garbage/misleading label ("Soon!", "Never") can't reach the model.
_GOAL_DATE_RE = re.compile(r"^[A-Z][a-z]{2} \d{4}$")


def _finite_number(value, *, low=0.0, high=None) -> bool:
    """True when `value` is a real (non-bool) finite number in [low, high]. bool is an
    int subclass, so it's excluded explicitly; math.isfinite rejects NaN/Infinity,
    which json.loads accepts by default."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if not math.isfinite(value) or value < low:
        return False
    return high is None or value <= high


def _sanitise_goal(raw) -> dict | None:
    """Validate + narrow a client-sent home-loan goal signal (WHIT-134) to a small,
    numbers-only dict, or None when it's absent/malformed.

    The goal is client-COMPUTED (unlike the server-assembled spend), so anything
    off-shape is dropped rather than trusted: a bad goal degrades to spend-only —
    never a 400, and never a junk figure the "use ONLY these numbers" prompt would
    parrot. Only the payoff cases carry a real date; 'none'/'unready' never reach here.
    """
    if not isinstance(raw, dict):
        return None
    mode = raw.get("payoff_mode")
    if mode not in _GOAL_PAYOFF_MODES:
        return None
    when = raw.get("mortgage_free_date")
    if not isinstance(when, str) or not _GOAL_DATE_RE.match(when):
        return None
    extra = raw.get("current_extra_monthly")
    if not _finite_number(extra, high=1_000_000):
        return None
    goal = {
        "payoff_mode": mode,
        "mortgage_free_date": when,
        "current_extra_monthly": float(extra),
    }
    # Optional sensitivity — keep only when finite + positive + plausibly bounded.
    months = raw.get("months_sooner_per_100_extra")
    if _finite_number(months, low=0.0, high=1200) and months > 0:
        goal["months_sooner_per_100_extra"] = float(months)
    return goal


def _extract_goal(event) -> dict | None:
    """Pull + sanitise the optional home-loan goal from a POST body (WHIT-134).

    Never raises, never 400s: an absent/empty/non-JSON body — or one with no valid
    "goal" — yields None (spend-only). This is deliberately NOT _parse_json_body,
    which 400s an empty body; older app versions POST with no body at all and must
    keep working.
    """
    if not event:
        return None
    raw_body = event.get("body") or ""
    if not raw_body:
        return None
    try:
        if event.get("isBase64Encoded"):
            raw_body = base64.b64decode(raw_body).decode("utf-8")
        body = json.loads(raw_body)
    except (ValueError, TypeError):
        return None
    if not isinstance(body, dict):
        return None
    return _sanitise_goal(body.get("goal"))


def assemble_insight_input(
    category_repo: CategoryRepository,
    budget_repo: BudgetRepository,
    transaction_repo: TransactionRepository,
    paycycle_repo: PayCycleRepository,
    goal: dict | None = None,
) -> tuple[dict, str]:
    """Build the numbers-only model input for the AI insight, and the cache key.

    Returns (model_input, cycle_start). model_input carries category spend
    (posted/pending), budget targets, the uncategorized bucket, the pay cycle, and
    INSIGHTS_PRIOR_CYCLES prior cycle(s) of category spend for trend — as plain
    floats. NO transaction descriptions/merchants/account ids. When a sanitised
    `goal` is passed (WHIT-134), a small home-loan goal block is added so advice can
    tie cuts to the mortgage-free date. cycle_start is the stable per-cycle cache key;
    because the goal is part of model_input, it's part of the input_hash too.
    """
    categories = category_repo.list_categories()
    cycle = paycycle_repo.get_paycycle()
    length = cycle["length"]
    start, end = current_cycle_window(cycle["last_pay_date"], length)

    current = _fetch_windowed_transactions(transaction_repo, start, end)
    targets = budget_repo.list_budgets()  # {id: {"target": Decimal}}
    all_ids = {c["id"] for c in categories}

    # Budgets join BY ID inside the helper (names aren't unique).
    category_rows = _window_category_spend(current, categories, targets)

    uncategorized = summarise_uncategorized(current, all_ids)
    unc = None
    if uncategorized["posted"] > 0 or uncategorized["pending"] > 0:
        unc = {"posted": float(uncategorized["posted"]), "pending": float(uncategorized["pending"])}

    # Prior full cycle(s): the window(s) immediately before cycle_start.
    prior = []
    cursor_start = date.fromisoformat(start)
    for _ in range(INSIGHTS_PRIOR_CYCLES):
        prev_end = cursor_start - timedelta(days=1)
        prev_start = cursor_start - timedelta(days=length)
        prev_txns = _fetch_windowed_transactions(
            transaction_repo, prev_start.isoformat(), prev_end.isoformat())
        prior.append({
            "start": prev_start.isoformat(),
            "end": prev_end.isoformat(),
            "categories": _window_category_spend(prev_txns, categories),
        })
        cursor_start = prev_start

    model_input = {
        "cycle": {"length": length, "start": start, "end": end},
        "currency": "AUD",
        "categories": category_rows,
        "uncategorized": unc,
        "prior_cycles": prior,
    }
    if goal is not None:
        model_input["goal"] = goal
    return model_input, start


def get_ai_insights(insight_repo: InsightRepository, paycycle_repo: PayCycleRepository) -> dict:
    """GET /insights/ai — return the cached suggestions for the current cycle, or a
    null sentinel if none has been generated yet. Never calls Anthropic, never
    pays: generation is the POST. The client shows the cached result on load and a
    "generate" button that POSTs."""
    cycle = paycycle_repo.get_paycycle()
    cycle_start, _end = current_cycle_window(cycle["last_pay_date"], cycle["length"])
    cached = insight_repo.get_insight(cycle_start)
    if cached is None:
        return {"summary": None, "suggestions": [], "generated_at": None,
                "cycle_start": cycle_start, "cached": False}
    return {
        "summary": cached["summary"],
        "suggestions": cached["suggestions"],
        "generated_at": cached["generated_at"],
        "cycle_start": cycle_start,
        "cached": True,
    }


def generate_ai_insights(
    category_repo: CategoryRepository,
    budget_repo: BudgetRepository,
    transaction_repo: TransactionRepository,
    paycycle_repo: PayCycleRepository,
    insight_repo: InsightRepository,
    event: dict | None = None,
) -> dict:
    """POST /insights/ai — generate suggestions from the user's real figures via the
    Anthropic API, cache them for the cycle, and return them.

    Skips the paid call when a cached insight exists for this cycle AND the input is
    unchanged (input_hash match) — so re-tapping "Analyse" mid-cycle is free unless
    the numbers moved. The optional home-loan goal from the request body (WHIT-134)
    joins model_input, so a changed goal is a changed hash → regenerate. On an
    Anthropic failure returns a 502 with an error body (no key leaked) so the client
    shows a retry, not a silent success.
    """
    goal = _extract_goal(event)
    model_input, cycle_start = assemble_insight_input(
        category_repo, budget_repo, transaction_repo, paycycle_repo, goal)
    input_hash = hashlib.sha256(
        json.dumps(model_input, sort_keys=True, default=str).encode()).hexdigest()

    cached = insight_repo.get_insight(cycle_start)
    if cached is not None and cached.get("input_hash") == input_hash:
        return _json_response(200, {
            "summary": cached["summary"],
            "suggestions": cached["suggestions"],
            "generated_at": cached["generated_at"],
            "cycle_start": cycle_start,
            "cached": True,
        })

    try:
        result = generate_suggestions(model_input)
    except AnthropicError as e:
        logger.warning("AI insight generation failed: upstream=%s", e.upstream_status)
        return _json_response(502, {"error": "insights unavailable, please try again"})

    generated_at = datetime.now(timezone.utc).isoformat()
    insight_repo.put_insight(
        cycle_start, result["summary"], result["suggestions"], generated_at, input_hash)
    return _json_response(200, {
        "summary": result["summary"],
        "suggestions": result["suggestions"],
        "generated_at": generated_at,
        "cycle_start": cycle_start,
        "cached": False,
    })


def get_homeloan(repo: HomeLoanBalanceRepository) -> dict:
    """GET /homeloan — the latest live mortgage balance (WHIT-8).

    Returns {"balance": <number>, "as_of": <iso>, "currency": <str>} from the row
    the balance poller stores. Before the first poll lands there is no row, so we
    return a null sentinel {"balance": None, ...} (still 200) rather than 404 —
    the client's refreshHomeLoan then simply skips the overwrite and keeps its
    placeholder, no error handling required. DecimalEncoder renders `balance` as a
    JSON number.
    """
    stored = repo.get_balance(HOMELOAN_ACCOUNT_ID)
    if stored is None:
        return {"balance": None, "as_of": None, "currency": None}
    return {
        "balance": stored["balance"],
        "as_of": stored["as_of"],
        "currency": stored["currency"],
    }


_REPAYMENT_NULL = {"amount": None, "date": None, "principal": None, "interest": None}


def get_repayment(repo: TransactionRepository) -> dict:
    """GET /repayment — the most recent home-loan repayment (WHIT-115).

    Reads the FULL up-homeloan history newest-first (not the 7-day feed — repayments
    are ~monthly), finds the latest incoming-transfer credit (the repayment leg,
    anchored on the account + TRANSFER_INCOMING, never the description), and pairs
    the interest (a separate BANK_FEES debit) when one falls in the same calendar
    month, so principal = amount - |interest|. When no interest pairs, principal/
    interest are null (total only — never a fabricated split). Null sentinel when
    there is no repayment on record. DecimalEncoder renders the Decimals as numbers.
    """
    # One page (MAX_PAGE_SIZE) of the sparse mortgage account spans many months.
    rows, _cursor = repo.get_transactions_by_date_range(
        HOMELOAN_ACCOUNT_ID, None, None, MAX_PAGE_SIZE)

    # A single malformed row (null/missing amount or date) must not 500 the card —
    # skip anything we can't read rather than trusting the row shape.
    def _num(value):
        return value if isinstance(value, (int, float, Decimal)) else None

    repayment = when = amount = None
    for r in rows:
        amt = _num(r.get("amount"))
        if r.get("type") == REPAYMENT_INCOMING_TYPE and amt is not None and amt > 0 and r.get("date"):
            repayment, when, amount = r, r["date"], amt
            break
    if repayment is None:
        return dict(_REPAYMENT_NULL)

    # Pair an interest leg only from the SAME calendar month (dates are YYYY-MM-DD),
    # so this month's repayment can't mis-pair with an adjacent month's interest. Only
    # a real interest DEBIT (negative BANK_FEES) counts — a positive fee reversal is not.
    month = str(when)[:7]
    interest = None
    for r in rows:
        if r.get("category") == INTEREST_CATEGORY and str(r.get("date", ""))[:7] == month:
            amt = _num(r.get("amount"))
            if amt is not None and amt < 0:
                interest = abs(amt)   # stored negative; show the magnitude
                break

    # Only show a split when it's sensible: interest present and strictly less than
    # the repayment. Otherwise total-only (never a negative or fabricated principal).
    principal = None
    if interest is not None and interest < amount:
        principal = amount - interest
    else:
        interest = None

    return {"amount": amount, "date": when, "principal": principal, "interest": interest}


# The user-entered loan-facts fields, in the order the form + response use them.
_LOANFACTS_FIELDS = ("original", "homeValue", "lvr", "ratePct", "baseRepay", "extra")


def get_loanfacts(repo: LoanFactsRepository) -> dict:
    """GET /loanfacts — the user's saved home-loan facts (Loan facts card).

    Returns the six fields as numbers once saved, or an all-null sentinel while
    unset (still 200) so the client can show a friendly "set this up" state and
    the app never displays a value the user didn't enter. DecimalEncoder renders
    the stored Decimals as JSON numbers.
    """
    stored = repo.get_loanfacts()
    if stored is None:
        return {field: None for field in _LOANFACTS_FIELDS}
    return stored


def set_loanfacts(event: dict, repo: LoanFactsRepository) -> dict:
    """PUT /loanfacts — save (replace) the user's home-loan facts.

    Body: all six of {original, homeValue, lvr, ratePct, baseRepay, extra}. The
    whole object is required and replaced together (like /paycycle) — there is no
    partial save, so the app is never left with a half-set object. Each field is
    validated like a budget target (reject bool, require a finite number); amounts
    must be > 0 (extra >= 0, an optional top-up), lvr is a fraction in (0, 1], and
    ratePct a percent in (0, 100]. Stored via Decimal(str(...)) to avoid float drift.
    """
    body, error = _parse_json_body(event)
    if error:
        return error

    values = {}
    for field in _LOANFACTS_FIELDS:
        v = body.get(field)
        # bool is an int subclass, so reject it before the numeric check.
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return _json_response(400, {"error": f"{field} must be a number"})
        if not math.isfinite(v):
            return _json_response(400, {"error": f"{field} must be a finite number"})
        values[field] = v

    # extra is an optional top-up (>= 0); every other amount must be positive.
    if values["extra"] < 0:
        return _json_response(400, {"error": "extra must be >= 0"})
    for field in ("original", "homeValue", "baseRepay"):
        if values[field] <= 0:
            return _json_response(400, {"error": f"{field} must be > 0"})
    # Dollar amounts share the budget ceiling; lvr/ratePct have tighter bounds below.
    for field in ("original", "homeValue", "baseRepay", "extra"):
        if values[field] > LOANFACTS_FIELD_MAX:
            return _json_response(400, {"error": f"{field} too large"})
    if not (0 < values["lvr"] <= 1):
        return _json_response(400, {"error": "lvr must be a fraction between 0 and 1"})
    if not (0 < values["ratePct"] <= 100):
        return _json_response(400, {"error": "ratePct must be between 0 and 100"})

    saved = repo.set_loanfacts(**{k: Decimal(str(v)) for k, v in values.items()})
    return _json_response(200, saved)


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
