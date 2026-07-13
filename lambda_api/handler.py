from constants import (
    ACCOUNT_BALANCES_PATH,
    ACCOUNT_ID_MAP,
    BREAKDOWN_MAX_LOOKBACK,
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
    GOALS_PATH,
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
    SAVINGS_BUCKET,
    SPEND_BUCKETS,
    TRANSACTION_BATCH_MAX,
    TRANSACTION_PATH,
    TRANSACTIONS_RANGE_PATH,
    UNCATEGORIZED_KEY,
)
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from repository import (
    AccountBalanceRepository,
    BudgetRepository,
    CategoryNotFoundError,
    CategoryRepository,
    DatabaseError,
    DeviceRepository,
    DuplicateCategoryError,
    GoalsRepository,
    HomeLoanBalanceRepository,
    InsightRepository,
    InvalidCategoryParentError,
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
    build_category_children,
    current_cycle_window,
    nth_prior_cycle_window,
    subtree_ids,
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

        # WHIT-34: the date-range query. An EXACT path (not a startswith), so it can't be
        # swallowed by the "/transactions/" item PATCH route below, and "/transactions/range"
        # != "/transactions" so the feed branch above never matches it. It returns its own
        # response shape ({transactions, nextCursor}), so it can't share the feed branch.
        if path == TRANSACTIONS_RANGE_PATH and method == "GET":
            return get_transactions_by_range(event, TransactionRepository())

        # Collection route (batch) BEFORE the item route. "/transactions" does not
        # start with "/transactions/", so the two are disjoint regardless of order.
        if path == TRANSACTION_PATH and method == "PATCH":
            return patch_transactions_batch(event, TransactionRepository())

        if path.startswith(f"{TRANSACTION_PATH}/") and method == "PATCH":
            return patch_transaction(event, TransactionRepository())

        if path == CATEGORY_PATH and method == "GET":
            return _json_response(200, list_categories(CategoryRepository()))

        if path == CATEGORY_PATH and method == "POST":
            return create_category(event, CategoryRepository(), BudgetRepository())

        if path.startswith(f"{CATEGORY_PATH}/") and method == "PATCH":
            return update_category(event, CategoryRepository(), BudgetRepository())

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
            return set_budget(event, BudgetRepository(), CategoryRepository())

        if path == BREAKDOWN_PATH and method == "GET":
            # Spend by category (window derived server-side from the stored pay cycle,
            # like /budgets). Optional ?cycle= looks back: 0 = current (default), n =
            # the nth prior cycle (WHIT-68), bounded by BREAKDOWN_MAX_LOOKBACK.
            cycle, cycle_error = _parse_breakdown_cycle(event)
            if cycle_error is not None:
                return cycle_error
            return _json_response(
                200,
                list_category_breakdown(
                    CategoryRepository(), TransactionRepository(), PayCycleRepository(),
                    cycle=cycle))

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

        if path == ACCOUNT_BALANCES_PATH and method == "GET":
            return _json_response(200, get_account_balances(AccountBalanceRepository()))

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

        # Goals (savings/paydown balance targets, WHIT-231). CRUD over the goals
        # config item; collection route first, then the item routes ("/goals" does
        # not startswith "/goals/", so the two are disjoint). Inside this try, so a
        # repo VersionConflictError becomes the shared 409 below.
        if path == GOALS_PATH and method == "GET":
            return _json_response(200, list_goals(GoalsRepository()))

        if path.startswith(f"{GOALS_PATH}/") and method == "PUT":
            return upsert_goal(event, GoalsRepository(), AccountBalanceRepository())

        if path.startswith(f"{GOALS_PATH}/") and method == "DELETE":
            return delete_goal(event, GoalsRepository())

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


class _BadCursor(ValueError):
    """A client-supplied pagination cursor that isn't a valid date-index page token
    (WHIT-34). The handler maps it to a 400 rather than letting a forged token 500."""


# The exact key set a date-index query's LastEvaluatedKey carries: the index key
# (account_id, date) + the table's primary key (pk, sk). A decoded cursor must match this
# shape — a well-formed JSON object with any other keys would be rejected by DynamoDB as an
# ExclusiveStartKey (a ValidationException → 500), so we reject it as a 400 first.
_CURSOR_KEY_SHAPE = frozenset({"account_id", "date", "pk", "sk"})


def _encode_cursor(key: dict | None) -> str | None:
    """Serialise a DynamoDB LastEvaluatedKey into an opaque, URL-safe cursor string.

    The date-index LastEvaluatedKey is a dict of string key attrs ({account_id, date,
    pk, sk}) — all strings, so plain json.dumps is safe (no Decimals to encode). Returns
    None when there is no next page, so the response carries a literal null nextCursor.
    """
    if key is None:
        return None
    return base64.urlsafe_b64encode(json.dumps(key).encode("utf-8")).decode("ascii")


def _decode_cursor(raw: str | None) -> dict | None:
    """Reverse _encode_cursor. None/empty → None (a first page). Raises _BadCursor on
    anything that isn't valid base64 of a JSON object with the date-index key shape.
    b64decode raises binascii.Error and .decode/.encode raise Unicode*Error, all ValueError
    subclasses, so a garbage token becomes a clean 400; and a well-formed JSON object with
    the wrong keys is rejected here too, rather than reaching DynamoDB as a bad
    ExclusiveStartKey (a ValidationException → 500). Either way a forged token is a 400."""
    if not raw:
        return None
    try:
        decoded = base64.urlsafe_b64decode(raw.encode("ascii")).decode("utf-8")
        cursor = json.loads(decoded)
    except (json.JSONDecodeError, ValueError):
        raise _BadCursor("malformed cursor")
    if not isinstance(cursor, dict) or set(cursor) != _CURSOR_KEY_SHAPE:
        raise _BadCursor("cursor has an unexpected shape")
    return cursor


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


# Free-text note/tag caps (WHIT-275). Kept as literals HERE, not in constants.py:
# a shared constant imported by a repository_* module at load must be mirrored in
# lambda_api/constants.py or the deployed API 500s on import (the constants-shadow
# landmine). These are used only by this handler, so literals sidestep it entirely.
NOTE_MAX_LEN = 500
TAG_MAX_COUNT = 20
TAG_MAX_LEN = 50


def _clean_tags(raw) -> tuple[list[str], dict | None]:
    """Validate + normalise a tags list: trim each, drop empties, cap per-tag
    length, dedupe keeping the FIRST-seen casing, cap the count. Returns
    (tags, error); [] (or an all-empty list) means clear. A non-list, a non-string
    element, an over-long tag, or too many tags is a 400."""
    if not isinstance(raw, list):
        return [], _json_response(400, {"error": "tags must be a list"})
    cleaned: list[str] = []
    seen: set[str] = set()
    for tag in raw:
        if not isinstance(tag, str):
            return [], _json_response(400, {"error": "each tag must be a string"})
        trimmed = tag.strip()
        if not trimmed:
            continue
        if len(trimmed) > TAG_MAX_LEN:
            return [], _json_response(400, {"error": f"tag too long (max {TAG_MAX_LEN})"})
        lowered = trimmed.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        cleaned.append(trimmed)
    if len(cleaned) > TAG_MAX_COUNT:
        return [], _json_response(400, {"error": f"too many tags (max {TAG_MAX_COUNT})"})
    return cleaned, None


def _validate_transaction_patch(body: dict) -> tuple[dict, dict | None]:
    """Validate a PATCH /transactions/{id} body. Returns (fields, error): `fields`
    is the subset of {category, notes, tags} actually present in the body (so the
    repo touches only those), `error` is a 400 response or None. `category` is
    set-only (clearing it is still a 400); `notes`/`tags` MAY clear (notes null/""
    and tags [] delete the stored field). At least one field is required."""
    fields: dict = {}

    if "category" in body:
        category = body["category"]
        if not isinstance(category, str) or not category.strip():
            return {}, _json_response(400, {"error": "category is required"})
        fields["category"] = category

    if "notes" in body:
        notes = body["notes"]
        if notes is None:
            notes = ""
        if not isinstance(notes, str):
            return {}, _json_response(400, {"error": "notes must be a string"})
        notes = notes.strip()
        if len(notes) > NOTE_MAX_LEN:
            return {}, _json_response(400, {"error": f"notes too long (max {NOTE_MAX_LEN})"})
        fields["notes"] = notes

    if "tags" in body:
        tags, error = _clean_tags(body["tags"])
        if error:
            return {}, error
        fields["tags"] = tags

    if not fields:
        return {}, _json_response(400, {"error": "category, notes, or tags is required"})

    return fields, None


def patch_transaction(event: dict, repo: TransactionRepository) -> dict:
    """PATCH /transactions/{id} — set/clear a transaction's category, note, and/or tags.

    Takes the repository as a parameter so it can be unit-tested with a fake repo,
    no patching required. Body is a JSON object carrying any of `category`,
    `notes`, `tags`; at least one is required. `category` is set-only (clearing it
    stays a 400). `notes`/`tags` may be cleared. Unknown id -> 404;
    malformed/oversized body -> 400. Echoes back the fields it applied.
    """
    transaction_id = (event.get("pathParameters") or {}).get("id")
    if not transaction_id:
        return _json_response(404, {"error": "transaction not found"})

    body, error = _parse_json_body(event)
    if error:
        return error

    fields, error = _validate_transaction_patch(body)
    if error:
        return error

    keys = repo.get_transaction_keys_by_id(transaction_id)
    if keys is None:
        return _json_response(404, {"error": "transaction not found"})

    if not repo.update_transaction_fields(keys["pk"], keys["sk"], **fields):
        return _json_response(404, {"error": "transaction not found"})

    return _json_response(200, {"transaction_id": transaction_id, **fields})


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


def get_transactions_by_range(event: dict, repo: TransactionRepository) -> dict:
    """GET /transactions/range — a date-range transactions query (WHIT-34).

    Unlike the /transactions feed (a fixed rolling window, merged across accounts,
    returning a bare array), this reads client-supplied query params and returns a
    pageable slice of ONE account:

        account_id  (required) — the account to query
        from        (required) — inclusive start date, ISO YYYY-MM-DD
        to          (optional) — inclusive end date, ISO YYYY-MM-DD
        limit       (optional) — page size, clamped to [1, MAX_PAGE_SIZE]
        cursor      (optional) — an opaque nextCursor from a previous page

    Returns {"transactions": [...], "nextCursor": <opaque string|null>}. A wide window
    can exceed one page, so — unlike the feed, which drops it — the DynamoDB cursor is
    serialised out as nextCursor and echoed back to fetch the next page. Bad input → 400.
    """
    params = event.get("queryStringParameters") or {}

    account_id = params.get("account_id")
    if not account_id:
        return _json_response(400, {"error": "account_id is required"})

    # `from` is required; `to` is optional. The repo supports start-only (gte) and
    # start+end (between) but NOT end-only — an `end` with no `start` is silently ignored
    # (whole partition), so reject end-only with a 400 rather than return everything.
    raw_from = params.get("from")
    raw_to = params.get("to")
    if not raw_from:
        return _json_response(400, {"error": "from is required (ISO YYYY-MM-DD)"})

    # Validate as real ISO dates but pass STRINGS to the repo: the date-index `date`
    # attribute is a bare YYYY-MM-DD string, and every other caller passes .isoformat().
    # Re-normalising via .isoformat() also canonicalises basic-format input (e.g.
    # "20260701" → "2026-07-01") so it lexically matches the stored dates.
    try:
        start_date = date.fromisoformat(raw_from).isoformat()
    except ValueError:
        return _json_response(400, {"error": "invalid from; expected ISO YYYY-MM-DD"})
    end_date = None
    if raw_to:
        try:
            end_date = date.fromisoformat(raw_to).isoformat()
        except ValueError:
            return _json_response(400, {"error": "invalid to; expected ISO YYYY-MM-DD"})

    # A reversed window (to before from) is nonsensical input, and the repo's
    # Key("date").between(from, to) would hit DynamoDB with lower > upper — a
    # ValidationException → an uncaught 500. Reject it at the boundary as a 400 instead.
    # Canonical ISO strings compare lexically == chronologically, so this is exact.
    if end_date is not None and end_date < start_date:
        return _json_response(400, {"error": "to must not be before from"})

    # `limit` is optional. Parse to int (non-numeric → 400) and clamp to [1, MAX_PAGE_SIZE]:
    # a 0/negative Limit is a DynamoDB ValidationException, and the repo already caps the
    # upper end, so clamping keeps every request a valid query without a 400 for a bound.
    raw_limit = params.get("limit")
    limit = MAX_PAGE_SIZE
    if raw_limit is not None:
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError):
            return _json_response(400, {"error": "invalid limit; expected an integer"})
        limit = max(1, min(limit, MAX_PAGE_SIZE))

    # `cursor` is an optional opaque page token from a previous response.
    try:
        cursor = _decode_cursor(params.get("cursor"))
    except _BadCursor:
        return _json_response(400, {"error": "invalid cursor"})

    # A cursor is bound to the account it was minted for: its account_id IS the
    # ExclusiveStartKey's partition value, and DynamoDB rejects a start key whose partition
    # contradicts the query's account_id.eq(...) (ValidationException → an uncaught 500).
    # Reject a cross-account cursor as a 400. No data-leak risk either way — the query stays
    # pinned to account_id — this just turns an abnormal 500 into a clean 400.
    if cursor is not None and cursor.get("account_id") != account_id:
        return _json_response(400, {"error": "cursor does not match account_id"})

    transactions, next_key = repo.get_transactions_by_date_range(
        account_id, start_date, end_date, limit, cursor
    )

    # Mirror the feed's row shaping: drop the DynamoDB keys, default sparse fields.
    for txn in transactions:
        txn.pop("pk", None)
        txn.pop("sk", None)
        txn.setdefault("category", None)

    return _json_response(200, {
        "transactions": transactions,
        "nextCursor": _encode_cursor(next_key),
    })


def _slugify(name: str) -> str:
    """Reduce a display name to a lowercase alphanumeric slug id. May return ""
    (e.g. a purely non-ASCII/punctuation name), which the caller rejects as 400."""
    return re.sub(r"[^a-z0-9]+", "", name.strip().lower())


def _parse_parent(raw):
    """Normalise a request body's `parent` value. Returns (parent, error): None
    parent for a null/absent value (top-level), the trimmed id for a non-empty
    string, or a 400 response for any other shape. The parent id's existence,
    bucket, and cycle-safety are validated in the repository against the live tree.
    """
    if raw is None:
        return None, None
    if not isinstance(raw, str) or not raw.strip():
        return None, _json_response(400, {"error": "invalid parent"})
    return raw.strip(), None


def list_categories(repo: CategoryRepository) -> list[dict]:
    # `recent` is client-derived (not stored); default it so the client Cat shape holds.
    return [{**cat, "recent": 0} for cat in repo.list_categories()]


def create_category(
    event: dict, repo: CategoryRepository, budget_repo: BudgetRepository
) -> dict:
    """POST /categories — create a category from name/bucket/icon.

    The id is a slug of the name (the shared BankSync/category vocabulary), color
    is server-assigned, and icon is optional (defaults when omitted).

    WHIT-202: creating a Savings category ONTO an existing orphan budget target (a
    back-door PUT /budgets/<slug> before the category exists) is rejected — otherwise
    it resurrects the same un-renderable phantom the set_budget/update_category guards
    block. This is the third and final write-path guard for a Savings-bucket target.
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

    if bucket == SAVINGS_BUCKET and cat_id in budget_repo.list_budgets():
        return _json_response(
            400, {"error": "cannot create a Savings category over an existing budget target"}
        )

    parent, parent_error = _parse_parent(body.get("parent"))
    if parent_error:
        return parent_error

    try:
        created = repo.create_category(cat_id, name.strip(), bucket, icon, parent=parent)
    except DuplicateCategoryError:
        return _json_response(409, {"error": "category already exists"})
    except InvalidCategoryParentError as e:
        return _json_response(400, {"error": str(e)})

    return _json_response(201, {**created, "recent": 0})


def update_category(
    event: dict, repo: CategoryRepository, budget_repo: BudgetRepository
) -> dict:
    """PATCH /categories/{id} — update a category's name, bucket, and icon.

    The id/slug (e.g. "groceries") is immutable and color is server-owned, so
    neither is editable — renaming "Groceries" to "Supermarket" keeps the id
    "groceries". Validation mirrors create; icon is optional (defaults when
    omitted).

    WHIT-202: moving a still-budgeted category into Savings is rejected — Savings
    categories can't carry a target, so allowing it would strand the existing budget
    as an invisible phantom (and it would silently resurrect on a move back). This is
    the re-bucket counterpart to the set_budget Savings guard; a reject (not a cascade
    delete) so a reclassify never silently destroys a stored budget.
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

    if bucket == SAVINGS_BUCKET and cat_id in budget_repo.list_budgets():
        return _json_response(
            400, {"error": "remove this category's budget before moving it to Savings"}
        )

    icon = body.get("icon")
    icon = icon.strip() if isinstance(icon, str) and icon.strip() else DEFAULT_CATEGORY_ICON

    # `parent` is optional in the body: omit it to leave the stored link untouched
    # (so a plain rename never wipes it), or send it (an id, or null to detach).
    update_parent = {}
    if "parent" in body:
        parent, parent_error = _parse_parent(body["parent"])
        if parent_error:
            return parent_error
        update_parent["parent"] = parent

    try:
        updated = repo.update_category(cat_id, name.strip(), bucket, icon, **update_parent)
    except CategoryNotFoundError:
        return _json_response(404, {"error": "category not found"})
    except InvalidCategoryParentError as e:
        return _json_response(400, {"error": str(e)})

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

    Sub-categories (WHIT-220, WHIT-228): a budgeted PARENT's posted/pending is the sum
    over its WHOLE SUBTREE for the window — the parent itself plus every descendant at
    any depth, including subs that carry no target of their own. Summing the parent id
    too counts a transaction tagged directly onto the parent (the picker allows it),
    so the bar agrees with the /breakdown screen. The wire shape is unchanged: every
    budgeted id (parent or leaf) still returns {target, posted, pending}. A leaf target
    with no children rolls up only itself, byte-identical to the pre-rollup behaviour.
    """
    targets = budget_repo.list_budgets()  # {id: {"target": Decimal}}
    if not targets:
        return {}
    cycle = paycycle_repo.get_paycycle()
    start, end = current_cycle_window(cycle["last_pay_date"], cycle["length"])
    transactions = _fetch_windowed_transactions(transaction_repo, start, end)

    categories = category_repo.list_categories()
    bucket_by_id = {c["id"]: c.get("bucket") for c in categories}
    children = build_category_children(categories)

    # Each target maps to its whole subtree — the target itself plus every descendant
    # at any depth — so a transaction tagged directly onto a parent counts toward its
    # budget too (WHIT-228). A leaf/orphan target maps to just itself, byte-identical
    # to the pre-rollup behaviour.
    ids_by_target = {cat_id: subtree_ids(cat_id, children, bucket_by_id) for cat_id in targets}
    needed_ids = set().union(*ids_by_target.values()) if ids_by_target else set()

    # Split by each id's own bucket (the same-bucket rule keeps a subtree single-
    # bucket, so a parent and its descendants all land on one side). Sum every needed
    # id once, then fold per target.
    income_ids = {cid for cid in needed_ids if bucket_by_id.get(cid) == INCOME_BUCKET}
    spend_ids = needed_ids - income_ids

    per_id = summarise_transactions(transactions, spend_ids)
    per_id.update(summarise_income(transactions, income_ids))

    result = {}
    for cat_id, entry in targets.items():
        posted = Decimal(0)
        pending = Decimal(0)
        for cid in ids_by_target[cat_id]:
            id_rollup = per_id.get(cid)
            if id_rollup:
                posted += id_rollup["posted"]
                pending += id_rollup["pending"]
        result[cat_id] = {"target": entry["target"], "posted": posted, "pending": pending}
    return result


def _parse_breakdown_cycle(event: dict) -> tuple[int, dict | None]:
    """Parse & validate the optional ?cycle= look-back on /breakdown (WHIT-68).

    Returns (cycle, None) on success, or (0, <400 response>) when the value isn't a
    non-negative integer within [0, BREAKDOWN_MAX_LOOKBACK]. Absent/empty -> 0 (the
    current cycle), so a client that sends nothing gets the pre-WHIT-68 behaviour.
    """
    params = event.get("queryStringParameters") or {}
    raw = params.get("cycle")
    if raw is None or raw == "":
        return 0, None
    try:
        cycle = int(raw)
    except (TypeError, ValueError):
        return 0, _json_response(400, {"error": f"cycle must be an integer, got {raw!r}"})
    if cycle < 0 or cycle > BREAKDOWN_MAX_LOOKBACK:
        return 0, _json_response(
            400, {"error": f"cycle must be in [0, {BREAKDOWN_MAX_LOOKBACK}], got {cycle}"})
    return cycle, None


def list_category_breakdown(
    category_repo: CategoryRepository,
    transaction_repo: TransactionRepository,
    paycycle_repo: PayCycleRepository,
    cycle: int = 0,
) -> dict:
    """GET /breakdown — spend (posted + pending) per category for a pay cycle, plus an
    "Uncategorized" bucket. The visual companion to /budgets: where the money actually
    went, not just budgeted categories.

    `cycle` selects the window (WHIT-68): 0 = the current cycle (default — byte-identical
    to the pre-WHIT-68 behaviour), n >= 1 = the nth FULL cycle before this one, for the
    historical look-back. The current window is [cycle_start, today]; a prior window is a
    full length-day span from `nth_prior_cycle_window`. The window is the only thing
    `cycle` changes — same summariser, same response shape — so the client renderer and
    the `categoryBreakdown` selector need no per-cycle branching.

    Same window + summariser as list_budgets, but over ALL spend-bucket categories
    rather than only budgeted ones. Income/Savings categories are excluded
    (SPEND_BUCKETS): they carry positive amounts that would clamp to $0 rows in a
    spend view. A category with no spend this cycle is omitted (summarise_transactions
    only returns contributors). The Uncategorized bucket (spend that counts to
    budget but isn't in the taxonomy — a raw enum, a deleted category, or null) is
    added only when it has spend, so a fully-categorised cycle shows no phantom row.

    Response: {"<category_id>": {"posted": Decimal, "pending": Decimal}, ...,
    optionally "__uncategorized__": {...}}. Empty {} when nothing had spend (e.g. a past
    window that predates first sync).
    """
    categories = category_repo.list_categories()
    pay_cycle = paycycle_repo.get_paycycle()
    cycle_start, cycle_end = current_cycle_window(pay_cycle["last_pay_date"], pay_cycle["length"])
    if cycle >= 1:
        start, end = nth_prior_cycle_window(cycle_start, pay_cycle["length"], cycle)
    else:
        start, end = cycle_start, cycle_end
    transactions = _fetch_windowed_transactions(transaction_repo, start, end)

    all_ids = {c["id"] for c in categories}
    spend_ids = {c["id"] for c in categories if c.get("bucket") in SPEND_BUCKETS}

    result = summarise_transactions(transactions, spend_ids)

    uncategorized = summarise_uncategorized(transactions, all_ids)
    if uncategorized["posted"] > 0 or uncategorized["pending"] > 0:
        result[UNCATEGORIZED_KEY] = uncategorized
    return result


def _window_category_spend(transactions: list[dict], categories: list[dict],
                           targets: dict | None = None,
                           exclude_ids: set[str] | None = None) -> list[dict]:
    """Spend-bucket categories with spend in `transactions`, as float rows the model
    can read: [{"name", "posted", "pending"}, ...]. Reuses summarise_transactions,
    so the contribution rule (counts_to_budget, real category, NEGATIVE amount) is
    identical to /breakdown. `targets` ({id: {"target": Decimal}}) is joined BY ID
    here (while the id is in hand) so the correct budget lands on each row — category
    display NAMES are not unique, so a name join would mis-attribute a budget.

    `exclude_ids` drops those category ids from the flat list — used to keep a budgeted
    PARENT out of it (it's represented once, as its rolled-up block row), so a parent
    with its own direct spend isn't listed twice (WHIT-228). Empty/None is a no-op, so
    a user with no budgeted parents gets a byte-identical list."""
    spend_ids = {c["id"] for c in categories if c.get("bucket") in SPEND_BUCKETS}
    if exclude_ids:
        spend_ids -= exclude_ids
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


def _budgeted_parent_rollup(transactions: list[dict], parents: list[str],
                            ids_by_parent: dict, names: dict,
                            targets: dict | None = None) -> list[dict]:
    """Rolled-up spend rows for budgeted PARENT categories (WHIT-225): each parent's
    posted/pending summed over its whole subtree, as float rows the model reads:
    [{"name", "posted", "pending", "budget"?}, ...].

    Kept SEPARATE from the flat per-leaf `categories` list so a leaf's spend is never
    listed twice (the parent's total is here; the leaves' detail stays in `categories`).
    The subtree includes the parent itself, so a transaction tagged directly onto the
    parent counts too (WHIT-228). Every budgeted parent is emitted even at zero spend —
    the point is to show its budget vs its rolled-up spend. `targets` is joined by id
    for the current cycle; prior cycles omit `budget` (it's constant across cycles),
    matching the per-leaf convention. Sorted by (name, id) so the hash is deterministic."""
    needed_ids = set().union(*ids_by_parent.values()) if ids_by_parent else set()
    rollup = summarise_transactions(transactions, needed_ids)
    rows = []
    for cid in parents:
        posted = sum((rollup[sid]["posted"] for sid in ids_by_parent[cid] if sid in rollup), Decimal(0))
        pending = sum((rollup[sid]["pending"] for sid in ids_by_parent[cid] if sid in rollup), Decimal(0))
        row = {"name": names.get(cid, cid), "posted": float(posted), "pending": float(pending)}
        if targets and cid in targets:
            row["budget"] = float(targets[cid]["target"])
        rows.append((row["name"], cid, row))
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
    parrot. The payoff cases carry a projected date; the 'shortfall' case (WHIT-126)
    carries a target date + the required repayment instead; 'unready' never reaches here.
    """
    if not isinstance(raw, dict):
        return None
    mode = raw.get("payoff_mode")
    # Shortfall (WHIT-126) has its own shape (a target date + required-repayment
    # numbers, no projected payoff date), so validate it before the payoff-mode gate.
    if mode == "shortfall":
        when = raw.get("goal_date")
        if not isinstance(when, str) or not _GOAL_DATE_RE.match(when):
            return None
        required_repayment = raw.get("required_repayment")
        required_extra = raw.get("required_extra")
        extra = raw.get("current_extra_monthly")
        if not (_finite_number(required_repayment, high=1_000_000)
                and _finite_number(required_extra, high=1_000_000)
                and _finite_number(extra, high=1_000_000)):
            return None
        return {
            "payoff_mode": "shortfall",
            "goal_date": when,
            "required_repayment": float(required_repayment),
            "required_extra": float(required_extra),
            "current_extra_monthly": float(extra),
        }
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

    # Rolled-up spend for budgeted PARENT categories (internal spend-bucket nodes). The
    # model otherwise sees a budgeted parent as $0 spent, since its spend is spread across
    # its subtree, not stored on the parent row (WHIT-225). The rollup sums the parent's
    # WHOLE subtree — every descendant PLUS the parent itself — so spend tagged directly
    # onto the parent counts too (WHIT-228). Only true parents (ids that HAVE children)
    # get the block; SPEND_BUCKETS excludes income earn-target parents, and the same-bucket
    # rule keeps a spend parent's subtree all spend. When there are no budgeted parents the
    # block is OMITTED entirely, so a user without them has a byte-identical model_input
    # (same hash, no needless paid re-run).
    children = build_category_children(categories)
    bucket_by_id = {c["id"]: c.get("bucket") for c in categories}
    names = {c["id"]: c["name"] for c in categories}
    budgeted_parents = [cid for cid in targets
                        if cid in children and bucket_by_id.get(cid) in SPEND_BUCKETS]
    ids_by_parent = {cid: subtree_ids(cid, children, bucket_by_id) for cid in budgeted_parents}
    parent_block_ids = set(budgeted_parents)

    # Flat per-category rows. A budgeted parent is represented ONCE — as its rolled-up
    # block row above — so it's excluded here even when it carries its own direct spend;
    # otherwise the model would see the same parent twice (its direct portion as a flat
    # row AND its subtree total in the block, both with the same budget). WHIT-228. A flat
    # leaf/orphan target stays in the list as today. Budgets join BY ID (names aren't unique).
    category_rows = _window_category_spend(current, categories, targets, exclude_ids=parent_block_ids)

    uncategorized = summarise_uncategorized(current, all_ids)
    unc = None
    if uncategorized["posted"] > 0 or uncategorized["pending"] > 0:
        unc = {"posted": float(uncategorized["posted"]), "pending": float(uncategorized["pending"])}

    # Prior full cycle(s): the window(s) immediately before cycle_start — the same
    # stepping /breakdown uses, via the shared nth_prior_cycle_window helper (WHIT-68),
    # so the trend and the historical breakdown can never disagree on cycle boundaries.
    prior = []
    for n in range(1, INSIGHTS_PRIOR_CYCLES + 1):
        prev_start, prev_end = nth_prior_cycle_window(start, length, n)
        prev_txns = _fetch_windowed_transactions(transaction_repo, prev_start, prev_end)
        prev_entry = {
            "start": prev_start,
            "end": prev_end,
            "categories": _window_category_spend(prev_txns, categories, exclude_ids=parent_block_ids),
        }
        # Mirror the parent rollup onto prior cycles (no budget — it's constant) so the
        # model can compare a parent's current vs prior spend at the same aggregation.
        if budgeted_parents:
            prev_entry["budgeted_parents"] = _budgeted_parent_rollup(
                prev_txns, budgeted_parents, ids_by_parent, names)
        prior.append(prev_entry)

    model_input = {
        "cycle": {"length": length, "start": start, "end": end},
        "currency": "AUD",
        "categories": category_rows,
        "uncategorized": unc,
        "prior_cycles": prior,
    }
    if budgeted_parents:
        model_input["budgeted_parents"] = _budgeted_parent_rollup(
            current, budgeted_parents, ids_by_parent, names, targets)
    if goal is not None:
        model_input["goal"] = goal
    return model_input, start


def _insight_has_content(summary, suggestions) -> bool:
    """True if an insight carries real advice: a non-blank summary OR ≥1 suggestion.

    Single source of the "not empty" rule for both sides of generate_ai_insights — the
    cache-read short-circuit and the post-generate soft-fail guard (WHIT-138). A
    whitespace-only summary counts as blank: the parse layer nulls these for fresh
    results, and applying the same strip here means a legacy row stored with a blank
    summary before that fix also self-heals on the next tap instead of being served.
    """
    return bool((isinstance(summary, str) and summary.strip()) or suggestions)


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

    A fully-empty result (no summary AND no suggestions) is treated as a soft failure
    (WHIT-138): it is NOT cached and returns the same 502 error body, so the user sees
    the "try again" state and a re-tap actually regenerates instead of hitting a cached
    empty row. An empty row already stored (from before this fix) is likewise treated
    as a cache miss below, so it self-heals on the next tap.
    """
    goal = _extract_goal(event)
    model_input, cycle_start = assemble_insight_input(
        category_repo, budget_repo, transaction_repo, paycycle_repo, goal)
    input_hash = hashlib.sha256(
        json.dumps(model_input, sort_keys=True, default=str).encode()).hexdigest()

    cached = insight_repo.get_insight(cycle_start)
    if (cached is not None
            and cached.get("input_hash") == input_hash
            and _insight_has_content(cached.get("summary"), cached.get("suggestions"))):
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

    if not _insight_has_content(result.get("summary"), result.get("suggestions")):
        logger.warning("AI insight generation returned an empty result; not caching")
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


def get_account_balances(repo: AccountBalanceRepository) -> list:
    """GET /accounts/balances — the latest live balance for each linked account (WHIT-212).

    Returns a list of {account_id, amount, available_balance, currency, as_of,
    account_type} for the app's known accounts (ACCOUNT_ID_MAP's internal ids) that have a
    stored balance. `amount` is SIGNED (spending positive; loan/credit-card negative) and
    DecimalEncoder renders it — and `available_balance` — as JSON numbers. Accounts not yet
    polled are simply absent (the app shows a placeholder), and before ANY poll this is an
    empty list — a 200, never a 404, so the client needs no special-casing.
    """
    return repo.list_balances(sorted(set(ACCOUNT_ID_MAP.values())))


_REPAYMENT_NULL = {"amount": None, "date": None, "principal": None, "interest": None}


def get_repayment(repo: TransactionRepository) -> dict:
    """GET /repayment — the most recent home-loan repayment (WHIT-115).

    Reads the FULL up-homeloan history newest-first (not the 7-day feed — repayments
    are ~monthly), finds the latest incoming-transfer credit (the repayment leg,
    anchored on the account + TRANSFER_INCOMING, never the description), and sums
    the interest (BANK_FEES debits) that fall in the same calendar month, so
    principal = amount - |summed interest| (WHIT-120: a month can post more than one
    interest leg). When no interest pairs, principal/interest are null (total only —
    never a fabricated split). Null sentinel when there is no repayment on record.
    DecimalEncoder renders the Decimals as numbers.
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

    # Sum the interest legs from the SAME calendar month (dates are YYYY-MM-DD), so
    # this month's repayment can't mis-pair with an adjacent month's interest. Only real
    # interest DEBITs (negative BANK_FEES) count — a positive fee reversal is not.
    # WHIT-120: a month can post more than one interest leg; sum them all (don't stop at
    # the newest), or the split understates interest and overstates principal. This assumes
    # every same-month BANK_FEES debit on the homeloan account IS interest (confirmed for
    # up-homeloan) — a mis-categorised non-interest fee here would inflate interest and
    # deflate principal.
    month = str(when)[:7]
    interest = None
    for r in rows:
        if r.get("category") == INTEREST_CATEGORY and str(r.get("date", ""))[:7] == month:
            amt = _num(r.get("amount"))
            if amt is not None and amt < 0:
                interest = (interest or 0) + abs(amt)   # stored negative; accumulate magnitudes

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

# The optional target payoff date (WHIT-126), stored as an ISO "YYYY-MM-DD" string.
# Kept here (not in shared/constants.py) so it can't drift from the lambda_api
# constants shadow. Shape-checked here; the real-calendar-date check is date.fromisoformat.
_GOAL_DATE_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def get_loanfacts(repo: LoanFactsRepository) -> dict:
    """GET /loanfacts — the user's saved home-loan facts (Loan facts card).

    Returns the six fields as numbers once saved, or an all-null sentinel while
    unset (still 200) so the client can show a friendly "set this up" state and
    the app never displays a value the user didn't enter. DecimalEncoder renders
    the stored Decimals as JSON numbers.
    """
    stored = repo.get_loanfacts()
    if stored is None:
        return {**{field: None for field in _LOANFACTS_FIELDS}, "payoffGoalDate": None}
    return stored


def set_loanfacts(event: dict, repo: LoanFactsRepository) -> dict:
    """PUT /loanfacts — save (replace) the user's home-loan facts.

    Body: all six of {original, homeValue, lvr, ratePct, baseRepay, extra}, plus an
    optional payoffGoalDate (WHIT-126). The six-field object is required and replaced
    together (like /paycycle) — there is no partial save, so the app is never left
    with a half-set object. Each field is validated like a budget target (reject bool,
    require a finite number); amounts must be > 0 (extra >= 0, an optional top-up), lvr
    is a fraction in (0, 1], and ratePct a percent in (0, 100]. payoffGoalDate, when
    present, must be a real ISO YYYY-MM-DD date. Stored via Decimal(str(...)) to avoid
    float drift.
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

    # Optional target payoff date (WHIT-126): absent/None is fine (unset or cleared);
    # when present it must be a real ISO YYYY-MM-DD calendar date.
    goal_date = body.get("payoffGoalDate")
    if goal_date is not None:
        if not isinstance(goal_date, str) or not _GOAL_DATE_ISO_RE.match(goal_date):
            return _json_response(400, {"error": "payoffGoalDate must be an ISO YYYY-MM-DD date"})
        try:
            date.fromisoformat(goal_date)
        except ValueError:
            return _json_response(400, {"error": "payoffGoalDate must be a real calendar date"})

    saved = repo.set_loanfacts(
        **{k: Decimal(str(v)) for k, v in values.items()}, payoffGoalDate=goal_date)
    return _json_response(200, saved)


def set_budget(
    event: dict, repo: BudgetRepository, category_repo: CategoryRepository
) -> dict:
    """PUT /budgets/{category} — set (upsert) a category's budget target.

    Body: {"target": <number >= 0>} — the user-set pay-cycle amount (spent/pending
    are derived elsewhere, not here). The target is stored as a Decimal via
    Decimal(str(...)) so a JSON float never introduces binary-float drift.

    An UNKNOWN category id is still accepted (stored as an orphan the client ignores).
    A KNOWN Savings-bucket category is rejected (WHIT-202): the client can't render a
    target on it, so a stored one is an invisible phantom — this is the server backstop
    for the deep-link/back-door write the picker already blocks. The bucket read runs
    only after the cheap numeric checks pass.
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

    # WHIT-202: reject a Savings-bucket target (an unknown id stays accepted — .get is
    # None → not Savings). Same bucket-by-id idiom list_budgets uses.
    bucket_by_id = {c["id"]: c.get("bucket") for c in category_repo.list_categories()}
    if bucket_by_id.get(cat_id) == SAVINGS_BUCKET:
        return _json_response(400, {"error": "cannot budget a Savings category"})

    saved = repo.set_budget(cat_id, Decimal(str(target)))
    return _json_response(200, saved)


# --- Goals (WHIT-231) ------------------------------------------------------
# NOTE: distinct from the WHIT-134 home-loan insight-signal helpers above
# (_GOAL_PAYOFF_MODES / _sanitise_goal / _extract_goal) — those narrow an AI-prompt
# signal and are unrelated to the goals store. Kept apart on purpose.
_GOAL_DIRECTIONS = {"grow", "paydown"}
# Absurd for a personal goal; also keeps a giant value from blowing past DynamoDB's
# number limit and 500ing at write instead of a clean 400 (matches set_budget).
_GOAL_AMOUNT_MAX = 1_000_000_000
# A goal's balance source, when synced, must name one of the real synced accounts —
# the client picker only offers these three, so a phantom id is a bug caught here.
_SYNCED_ACCOUNT_IDS = frozenset(ACCOUNT_ID_MAP.values())


def _valid_iso_date(value) -> bool:
    """True when `value` is a real ISO YYYY-MM-DD calendar date string. The regex
    checks shape (it would pass 2026-02-30); date.fromisoformat checks the calendar."""
    if not isinstance(value, str) or not _GOAL_DATE_ISO_RE.match(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _validate_goal_body(event: dict):
    """Validate a PUT /goals/{id} body into a stored goal dict.

    Returns (goal, None) on success or (None, error_response) with a 400. A goal has:
    name, icon (defaults like a category), direction (grow|paydown), target_amount
    (> 0 to save toward; a paydown may target 0 = pay it off), target_date (real ISO
    date), and EXACTLY ONE balance source — a synced account_id OR a manual pair
    (manual_balance + manual_as_of) — plus an optional baseline ("count from £X").
    Every numeric is stored as Decimal(str(...)) so no float reaches boto3.
    """
    body, error = _parse_json_body(event)
    if error:
        return None, error

    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, _json_response(400, {"error": "name is required"})

    direction = body.get("direction")
    if direction not in _GOAL_DIRECTIONS:
        return None, _json_response(400, {"error": "direction must be 'grow' or 'paydown'"})

    icon = body.get("icon")
    icon = icon.strip() if isinstance(icon, str) and icon.strip() else DEFAULT_CATEGORY_ICON

    target_amount = body.get("target_amount")
    if not _finite_number(target_amount, high=_GOAL_AMOUNT_MAX):
        return None, _json_response(
            400, {"error": "target_amount must be a number between 0 and 1000000000"})
    # A savings target of 0 is meaningless; a debt target of 0 ("pay it off") is the point.
    if direction == "grow" and target_amount <= 0:
        return None, _json_response(400, {"error": "target_amount must be > 0 for a savings goal"})

    target_date = body.get("target_date")
    if not _valid_iso_date(target_date):
        return None, _json_response(400, {"error": "target_date must be a real ISO YYYY-MM-DD date"})

    goal = {
        "name": name.strip(),
        "icon": icon,
        "direction": direction,
        "target_amount": Decimal(str(target_amount)),
        "target_date": target_date,
    }

    # Exactly one balance source: a synced account_id XOR a manual (balance + as_of) pair.
    # `has_manual` is true if EITHER manual field was sent, so a partial manual can't slip
    # past as "no manual source" — it enters the manual branch and fails the field checks.
    account_id = body.get("account_id")
    manual_balance = body.get("manual_balance")
    manual_as_of = body.get("manual_as_of")
    has_account = isinstance(account_id, str) and bool(account_id.strip())
    has_manual = manual_balance is not None or manual_as_of is not None
    if has_account == has_manual:
        return None, _json_response(
            400,
            {"error": "provide exactly one balance source: account_id, or manual_balance + manual_as_of"})

    if has_account:
        if account_id not in _SYNCED_ACCOUNT_IDS:
            return None, _json_response(400, {"error": "account_id is not a known synced account"})
        goal["account_id"] = account_id
    else:
        # Manual needs BOTH fields valid. manual_balance may be negative (a debt snapshot),
        # so it's bounded by magnitude, not sign.
        if not _finite_number(manual_balance, low=-_GOAL_AMOUNT_MAX, high=_GOAL_AMOUNT_MAX):
            return None, _json_response(400, {"error": "manual_balance must be a finite number"})
        if not _valid_iso_date(manual_as_of):
            return None, _json_response(400, {"error": "manual_as_of must be a real ISO YYYY-MM-DD date"})
        goal["manual_balance"] = Decimal(str(manual_balance))
        goal["manual_as_of"] = manual_as_of

    baseline = body.get("baseline")
    if baseline is not None:
        if not _finite_number(baseline, high=_GOAL_AMOUNT_MAX):
            return None, _json_response(400, {"error": "baseline must be a number >= 0"})
        goal["baseline"] = Decimal(str(baseline))

    return goal, None


def list_goals(repo: GoalsRepository) -> list:
    """GET /goals — the user's goals as a list of objects, each carrying its `id`
    (the stored map is flattened; the client keys by id)."""
    return [{"id": goal_id, **goal} for goal_id, goal in repo.list_goals().items()]


def _goal_start_candidate(goal: dict, balance_repo: AccountBalanceRepository) -> dict:
    """The immutable start (start_date + start_balance) to stamp IF this upsert is the
    goal's first — WHIT-252. Captured as a PAIR so both always describe the SAME moment.

    - Manual goal: the entered balance is on the body, so the pair is available now.
    - Synced goal: the live balance, but only if the account has been polled. If it
      hasn't, return {} — no start yet; the first later upsert that finds a balance
      stamps the pair, then repository_goals freezes it.

    start_date is the SERVER stamp date (create day, or the day the synced balance first
    became available), NOT necessarily the day the balance was measured — the deferred
    status card should treat it as the stamp date. start_balance carries the same
    source-aware SIGN split the current balance uses: SIGNED for a synced goal (a debt
    account is negative), and as-entered for a manual one (which MAY be negative — a debt
    snapshot). The status card must normalise the two the same way balanceGoalView does,
    never compare a signed synced start to an as-entered manual current.
    """
    if "manual_balance" in goal:
        return {"start_date": _melbourne_today().isoformat(), "start_balance": goal["manual_balance"]}
    rows = balance_repo.list_balances([goal["account_id"]])
    if rows:
        return {"start_date": _melbourne_today().isoformat(), "start_balance": rows[0]["amount"]}
    return {}


def upsert_goal(event: dict, repo: GoalsRepository, balance_repo: AccountBalanceRepository) -> dict:
    """PUT /goals/{id} — create or replace a goal (idempotent upsert). 404 on a
    missing/blank id (an empty map key would 500 at DynamoDB), 400 on a bad body.

    On the FIRST write for an id, an immutable start (date + balance) is stamped; every
    later replace carries the existing start forward (WHIT-252) — see repository_goals.
    """
    goal_id = (event.get("pathParameters") or {}).get("id")
    if not goal_id:
        return _json_response(404, {"error": "goal not found"})
    goal, error = _validate_goal_body(event)
    if error:
        return error
    start_candidate = _goal_start_candidate(goal, balance_repo)
    return _json_response(200, repo.upsert_goal(goal_id, goal, start_candidate))


def delete_goal(event: dict, repo: GoalsRepository) -> dict:
    """DELETE /goals/{id} — remove a goal. Idempotent: an unknown/already-gone id
    still returns 200 (mirrors delete_enrichment / delete_budget)."""
    goal_id = (event.get("pathParameters") or {}).get("id")
    if not goal_id:
        return _json_response(404, {"error": "goal not found"})
    repo.delete_goal(goal_id)
    return _json_response(200, {"id": goal_id})


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
