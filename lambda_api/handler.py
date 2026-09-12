from constants import (
    APPLY_RULES_MAX_WRITES,
    APPLY_RULES_TIME_BUDGET_SECONDS,
    ACCOUNT_BALANCES_PATH,
    ACCOUNT_BALANCES_REFRESH_PATH,
    ACCOUNT_ID_MAP,
    BALANCE_SOURCES,
    BANKSYNC_BASE_URL,
    BANKSYNC_USER_AGENT,
    REFRESH_FETCH_TIMEOUT_SECONDS,
    REFRESH_THROTTLE_SECONDS,
    BREAKDOWN_MAX_LOOKBACK,
    BREAKDOWN_PATH,
    BUDGET_PATH,
    CATEGORY_BUCKETS,
    CATEGORY_PATH,
    DEFAULT_CATEGORY_ICON,
    DEFAULT_RULE_FIELD,
    DEFAULT_RULE_OPERATOR,
    DEVICES_PATH,
    EARNED_KEY,
    INCOME_KEY,
    ROLLUP_KEY,
    ENRICHMENTS_PATH,
    EXPO_TOKEN_MAX_LEN,
    FEED_PAGE_SIZE,
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
    MILESTONES_PATH,
    PAYCYCLE_LENGTHS,
    PAYCYCLE_PATH,
    REPAYMENT_PATH,
    ROLLOVER_MAX_LOOKBACK_CYCLES,
    ROLLOVER_SETTLE_LAG_DAYS,
    RULE_FIELDS,
    RULE_OPERATORS,
    SAVINGS_BUCKET,
    SPEND_BUCKETS,
    SPREAD_MAX_CYCLES,
    SPREAD_MIN_CYCLES,
    TRANSACTION_BATCH_MAX,
    TRANSACTION_PATH,
    TRANSACTIONS_FEED_PATH,
    UNCATEGORIZED_APPLY_RULES_PATH,
    UNCATEGORIZED_COUNT_PATH,
    UNCATEGORIZED_FEED_PATH,
    UNCATEGORIZED_KEY,
    UNCATEGORIZED_MERCHANTS_PATH,
)
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
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
    MilestoneRepository,
    PayCycleRepository,
    TransactionRepository,
    VersionConflictError,
)
from repayment_rules import is_repayment_credit, is_number
from banksync_enrichments import (
    BankSyncError,
    create_rule,
    delete_rule,
    get_api_key,
    list_rules,
    rule_overlaps_text,
    update_rule,
)
from balance_fetch import BalanceError, fetch_balance, normalise_account_balance
# The pay-cycle window + spend summariser live in the shared layer (WHIT-22) so the
# webhook's budget-alert detection computes spend identically to this read API.
from spend import (
    _SPREAD_ENTRY_FIELDS,
    _melbourne_today,
    _spend_contribution,
    _spread_state,
    build_category_children,
    completed_cycle_windows,
    contributes_to_budget,
    current_cycle_window,
    fold_subtree,
    nth_prior_cycle_window,
    spread_adjustment,
    spread_index,
    subtree_ids,
    summarise_earned,
    summarise_income,
    summarise_transactions,
    summarise_uncategorized,
    transactions_in_window,
)
from anthropic_client import AnthropicError
from insights_ai import generate_suggestions
from iso_date import ISO_DATE_RE, valid_iso_date
from merchant_groups import (
    MIN_RULE_VALUE_ALPHANUMERICS,
    group_unfiled_by_merchant,
    rule_value_is_safe,
)
from milestones import mint_migration_markers
from rule_engine import plan_rule_application, is_unfiled_category
from repository_notify import NotifyRepository
from goal_checkpoints import notify_goal_checkpoint_crossing
from encoders import DecimalEncoder
import base64
import hashlib
import json
import logging
import math
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

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

        # The all-accounts feed, paged back through full history (Load More). An EXACT
        # path, disjoint from "/transactions" and the PATCH "/transactions/{id}" item
        # route (a GET, so the startswith-PATCH branch never matches it). Returns
        # {transactions, nextCursor}, so its own branch.
        if path == TRANSACTIONS_FEED_PATH and method == "GET":
            return get_transactions_feed(event, TransactionRepository())

        # Full-history uncategorized count (WHIT-500). An EXACT path — disjoint from
        # "/transactions", "/transactions/feed", and the PATCH "/transactions/{id}" item
        # route (a GET, so the startswith-PATCH branch never matches it).
        if path == UNCATEGORIZED_COUNT_PATH and method == "GET":
            return get_uncategorized_count(TransactionRepository(), CategoryRepository())

        # The uncategorized-only feed, paged back through full history (Load More). An EXACT
        # path — disjoint from "/transactions", "/transactions/feed",
        # "/transactions/uncategorized/count", and the PATCH "/transactions/{id}" item route
        # (a GET, so the startswith-PATCH branch never matches it).
        if path == UNCATEGORIZED_FEED_PATH and method == "GET":
            return get_uncategorized_feed(event, TransactionRepository(), CategoryRepository())

        # The unfiled charges grouped by merchant (WHIT-515). An EXACT path, disjoint from the
        # other two GET uncategorized routes; the PATCH "/transactions/{id}" branch is
        # method-gated and never sees it.
        if path == UNCATEGORIZED_MERCHANTS_PATH and method == "GET":
            return get_uncategorized_merchants(TransactionRepository(), CategoryRepository())

        # Apply the user's BankSync rules to charges ALREADY stored (BankSync only applies them
        # to incoming charges — WHIT-502). POST-only, and it PREVIEWS unless the body says
        # {"dryRun": false}. An EXACT path, so it can't collide with the two GET uncategorized
        # routes; the PATCH "/transactions/{id}" branch is method-gated and never sees a POST.
        if path == UNCATEGORIZED_APPLY_RULES_PATH and method == "POST":
            return apply_rules_to_uncategorized(event, TransactionRepository(), CategoryRepository())

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

        # The transactions behind one /breakdown row (whole cycle, exact category or the
        # uncategorized bucket), so the drill-in list reconciles with the Insights card.
        if (path.startswith(f"{CATEGORY_PATH}/") and path.endswith("/transactions")
                and method == "GET"):
            return get_category_transactions(
                event, TransactionRepository(), PayCycleRepository(),
                CategoryRepository())

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

        # The transactions behind one budget's total (the whole cycle + subtree),
        # so the budget-detail list reconciles with the header. An EXACT "/transactions"
        # suffix on a budget id, so it can't collide with the PUT/DELETE item routes.
        if (path.startswith(f"{BUDGET_PATH}/") and path.endswith("/transactions")
                and method == "GET"):
            return get_budget_transactions(
                event, TransactionRepository(), PayCycleRepository(),
                CategoryRepository())

        # A bill spread on one budget (WHIT-504). MUST sit above the generic item PUT/DELETE
        # below, which would otherwise swallow "/budgets/{id}/spread" as a target write.
        if _is_budget_spread_path(path) and method == "PUT":
            return set_spread(event, BudgetRepository(), CategoryRepository(), PayCycleRepository())

        if _is_budget_spread_path(path) and method == "DELETE":
            return delete_spread(event, BudgetRepository())

        if path.startswith(f"{BUDGET_PATH}/") and method == "PUT":
            return set_budget(event, BudgetRepository(), CategoryRepository(), PayCycleRepository())

        if path.startswith(f"{BUDGET_PATH}/") and method == "DELETE":
            return delete_budget(event, BudgetRepository())

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

        if path == ACCOUNT_BALANCES_REFRESH_PATH and method == "POST":
            return refresh_account_balances(AccountBalanceRepository())

        if path == REPAYMENT_PATH and method == "GET":
            return _json_response(200, get_repayment(TransactionRepository()))

        if path == LOANFACTS_PATH and method == "GET":
            return _json_response(200, get_loanfacts(LoanFactsRepository()))

        if path == LOANFACTS_PATH and method == "PUT":
            return set_loanfacts(event, LoanFactsRepository())

        # Milestones (user-owned mortgage-paydown plan, WHIT-375). GET returns the saved
        # list (empty until saved); PUT replaces the whole list. Inert until the client
        # tickets consume it.
        if path == MILESTONES_PATH and method == "GET":
            return _json_response(200, get_milestones(event, MilestoneRepository()))

        if path == MILESTONES_PATH and method == "PUT":
            return set_milestones(event, MilestoneRepository(), NotifyRepository())

        if path == PAYCYCLE_PATH and method == "GET":
            return _json_response(200, get_paycycle_view(PayCycleRepository()))

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

        # Enrichments (BankSync categorisation rules) — they mutate BankSync, our source of
        # truth for rules. Like every app route, they sit behind the API Gateway JWT authorizer.
        if path == ENRICHMENTS_PATH and method == "GET":
            return get_enrichments()

        if path == ENRICHMENTS_PATH and method == "POST":
            return create_enrichment(event)

        if path.startswith(f"{ENRICHMENTS_PATH}/") and method == "PUT":
            return update_enrichment(event)

        if path.startswith(f"{ENRICHMENTS_PATH}/") and method == "DELETE":
            return delete_enrichment(event)

        # Device push-token registration (it controls who receives the user's notifications).
        if path == DEVICES_PATH and method == "POST":
            return register_device(event, DeviceRepository())

        return _json_response(404, {"error": "Not found"})
    except VersionConflictError:
        return _json_response(409, {"error": "write conflict, please retry"})


def _is_budget_spread_path(path: str) -> bool:
    """Exactly "/budgets/{id}/spread" — three segments — and nothing else. A suffix check
    alone would also match "/budgets/spread", i.e. the item route for a category whose id
    is literally "spread" (a plausible slug), and steal its target PUT/DELETE. The
    /transactions suffix has no such hole only because it is GET-only, with no generic
    GET item route beneath it."""
    return path.startswith(f"{BUDGET_PATH}/") and path.endswith("/spread") and path.count("/") == 3


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
    """A client-supplied pagination cursor that isn't a valid date-index page token.
    The handler maps it to a 400 rather than letting a forged token 500."""


# The exact key set a date-index query's LastEvaluatedKey carries: the index key
# (account_id, date) + the table's primary key (pk, sk). A decoded cursor must match this
# shape — a well-formed JSON object with any other keys would be rejected by DynamoDB as an
# ExclusiveStartKey (a ValidationException → 500), so we reject it as a 400 first.
_CURSOR_KEY_SHAPE = frozenset({"account_id", "date", "pk", "sk"})


# The /transactions/feed cursor is COMPOSITE — it resumes every account at once, so a
# single-key page token won't do. It encodes a per-account resume map:
#   {"v": 1, "a": {<account_id>: <date-index key | null>, ...}}
# A key of null means "resume this account from its newest row" (it fetched rows last page
# but none made the merged cut, so it re-competes from the same position). An account
# ABSENT from the map is exhausted. An empty map encodes to no cursor at all (null).
_FEED_CURSOR_VERSION = 1


def _encode_feed_cursor(resume_keys: dict) -> str | None:
    """Serialise the per-account resume map into an opaque feed cursor. An empty map
    (every account exhausted) → None, so the response carries a literal null nextCursor."""
    if not resume_keys:
        return None
    payload = {"v": _FEED_CURSOR_VERSION, "a": resume_keys}
    return base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


def _decode_feed_cursor(raw: str | None) -> dict:
    """Reverse _encode_feed_cursor. None/empty → {} (a first page: every account from
    newest). Raises _BadCursor on anything that isn't base64 of a {v, a:{account_id: key}}
    payload whose non-null keys have the date-index shape and match their account — so a
    forged token is a clean 400, never a DynamoDB ValidationException 500 on the
    ExclusiveStartKey."""
    if not raw:
        return {}
    try:
        decoded = base64.urlsafe_b64decode(raw.encode("ascii")).decode("utf-8")
        payload = json.loads(decoded)
    except (json.JSONDecodeError, ValueError):
        raise _BadCursor("malformed feed cursor")
    if not isinstance(payload, dict) or payload.get("v") != _FEED_CURSOR_VERSION:
        raise _BadCursor("feed cursor has an unexpected version")
    resume_keys = payload.get("a")
    if not isinstance(resume_keys, dict):
        raise _BadCursor("feed cursor has an unexpected shape")
    for account_id, key in resume_keys.items():
        if key is None:
            continue
        if not isinstance(key, dict) or set(key) != _CURSOR_KEY_SHAPE:
            raise _BadCursor("feed cursor has an unexpected key shape")
        # The date-index key attrs are all strings. A forged key with the right NAMES but
        # non-string values (e.g. date=1) would pass the shape check and reach DynamoDB as
        # a bad ExclusiveStartKey (ValidationException → 500). Require string values so a
        # forged token stays a clean 400, as the docstring promises.
        if not all(isinstance(value, str) for value in key.values()):
            raise _BadCursor("feed cursor has non-string key values")
        # A resume key is bound to its account: the ExclusiveStartKey's partition value
        # must equal the account it resumes, or DynamoDB rejects it (a 500). Reject a
        # cross-account key as a 400 before it reaches DynamoDB.
        if key.get("account_id") != account_id:
            raise _BadCursor("feed cursor key does not match its account")
    return resume_keys


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
    is the subset of {category, notes, tags, budget_excluded} actually present in the
    body (so the repo touches only those), `error` is a 400 response or None.
    `category` is set-only (clearing it is still a 400); `notes`/`tags` MAY clear
    (notes null/"" and tags [] delete the stored field); `budget_excluded` is a bool
    (False clears the override). At least one field is required."""
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

    if "budget_excluded" in body:
        budget_excluded = body["budget_excluded"]
        if not isinstance(budget_excluded, bool):
            return {}, _json_response(400, {"error": "budget_excluded must be a boolean"})
        fields["budget_excluded"] = budget_excluded

    if not fields:
        return {}, _json_response(
            400, {"error": "category, notes, tags, or budget_excluded is required"}
        )

    return fields, None


def patch_transaction(event: dict, repo: TransactionRepository) -> dict:
    """PATCH /transactions/{id} — set/clear a transaction's category, note, tags,
    and/or budget-exclude override.

    Takes the repository as a parameter so it can be unit-tested with a fake repo,
    no patching required. Body is a JSON object carrying any of `category`,
    `notes`, `tags`, `budget_excluded`; at least one is required. `category` is
    set-only (clearing it stays a 400). `notes`/`tags` may be cleared;
    `budget_excluded=False` clears the override. Unknown id -> 404;
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


def _parse_feed_page_params(event: dict) -> tuple[int, dict, dict | None]:
    """Parse the shared feed query params (limit + cursor) both /transactions/feed and
    /transactions/uncategorized/feed accept, so the two routes can't drift on clamping or cursor
    validation. Returns (limit, resume_keys, error): on bad input `error` is a 400 response and the
    caller returns it; otherwise `error` is None.

        limit   (optional) — clamped to [1, MAX_PAGE_SIZE] (default FEED_PAGE_SIZE); a 0/negative
                             Limit is a DynamoDB ValidationException, so clamp rather than 500.
        cursor  (optional) — an opaque nextCursor from a previous page; a forged one → 400, not 500.
    """
    params = event.get("queryStringParameters") or {}
    raw_limit = params.get("limit")
    limit = FEED_PAGE_SIZE
    if raw_limit is not None:
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError):
            return limit, {}, _json_response(400, {"error": "invalid limit; expected an integer"})
        limit = max(1, min(limit, MAX_PAGE_SIZE))
    try:
        resume_keys = _decode_feed_cursor(params.get("cursor"))
    except _BadCursor:
        return limit, {}, _json_response(400, {"error": "invalid cursor"})
    return limit, resume_keys, None


def _shape_feed_rows(page: list[dict]) -> None:
    """Strip the DynamoDB storage keys and default sparse fields on each feed row, in place —
    the shared row shaping both feed routes apply. The resume keys were already built from the raw
    rows inside _fetch_feed_page, so popping pk/sk here does not disturb the cursor."""
    for txn in page:
        txn.pop("pk", None)
        txn.pop("sk", None)
        txn.setdefault("category", None)


def get_transactions_feed(event: dict, repo: TransactionRepository) -> dict:
    """GET /transactions/feed — the all-accounts feed, newest-first, paged back through
    FULL history (Load More).

    Unlike GET /transactions (a fixed 7-day rolling window returning a bare array), this
    merges every account with NO date floor and returns a cursor so the app can walk back
    to the start of history. Returns {"transactions": [...], "nextCursor": <opaque string|null>};
    nextCursor is null once every account is exhausted. Bad input → 400.
    """
    limit, resume_keys, error = _parse_feed_page_params(event)
    if error is not None:
        return error

    page, next_resume_keys = _fetch_feed_page(repo, limit, resume_keys)
    _shape_feed_rows(page)

    return _json_response(200, {
        "transactions": page,
        "nextCursor": _encode_feed_cursor(next_resume_keys),
    })


def _fetch_feed_page(
    repo: TransactionRepository, limit: int, resume_keys: dict
) -> tuple[list[dict], dict]:
    """One page of the merged all-accounts feed: the globally newest `limit` rows at or
    after each account's resume position, plus the resume map for the next page.

    Why it is gap-free and dupe-free:
      - Fetch up to `limit` newest rows from each live account past its resume key. A
        globally top-`limit` row has < limit rows newer than it globally, hence < limit
        newer within its OWN account, so it always sits inside that account's own
        top-`limit` — fetching `limit` per account can never miss one.
      - Stable-merge all fetched rows by date descending (ties keep ACCOUNT_ID_MAP order,
        and each account's own rows keep DynamoDB order) and take the top `limit`.
      - Advance an account's resume key only PAST the OLDEST row it contributed to this
        page (DynamoDB's ExclusiveStartKey resumes strictly after it, so no row repeats).
        An account that contributed nothing keeps its PRIOR key, so its fetched-but-unshown
        rows re-compete next page (no row is skipped).
      - Drop an account from the next cursor once it has no unshown fetched rows AND
        DynamoDB reports no more pages.

    resume_keys is {} on the first page (every account from newest); otherwise it holds
    only the still-live accounts, each mapped to a date-index key or None (from newest).
    """
    first_page = not resume_keys
    if first_page:
        live = {account_id: None for account_id in ACCOUNT_ID_MAP.values()}
    else:
        live = dict(resume_keys)

    # One query per live account, in ACCOUNT_ID_MAP order (kept stable across pages so the
    # equal-date merge tiebreak never flips a row across a page boundary).
    fetched: dict[str, list[dict]] = {}
    dynamo_has_more: dict[str, bool] = {}
    for account_id, resume_key in live.items():
        rows, next_key = repo.get_transactions_by_date_range(
            account_id, None, None, limit=limit, cursor=resume_key
        )
        fetched[account_id] = rows
        dynamo_has_more[account_id] = next_key is not None

    # Stable-merge: insertion order is account-by-account in live order, so a stable sort
    # on date-desc keeps equal-date rows in ACCOUNT_ID_MAP order and each account's rows in
    # DynamoDB order — a single deterministic global order.
    ordered = [
        (row, account_id)
        for account_id, rows in fetched.items()
        for row in rows
    ]
    ordered.sort(key=lambda pair: pair[0]["date"], reverse=True)
    page_pairs = ordered[:limit]
    page = [row for row, _ in page_pairs]

    # The page is newest-first, so the LAST time an account appears is the oldest row it
    # contributed → its next resume key.
    oldest_contributed: dict[str, dict] = {}
    contributed_count: dict[str, int] = {}
    for row, account_id in page_pairs:
        oldest_contributed[account_id] = row
        contributed_count[account_id] = contributed_count.get(account_id, 0) + 1

    next_resume_keys: dict = {}
    for account_id in live:
        row = oldest_contributed.get(account_id)
        if row is not None:
            all_fetched_shown = contributed_count[account_id] == len(fetched[account_id])
            exhausted = all_fetched_shown and not dynamo_has_more[account_id]
            if not exhausted:
                next_resume_keys[account_id] = {
                    "account_id": account_id,
                    "date": row["date"],
                    "pk": row["pk"],
                    "sk": row["sk"],
                }
            continue
        # Contributed nothing this page. If it still has fetched-but-unshown rows (or
        # DynamoDB has more), keep it live at its PRIOR position so those rows re-compete;
        # otherwise it is exhausted and drops out of the cursor.
        if fetched[account_id] or dynamo_has_more[account_id]:
            next_resume_keys[account_id] = live[account_id]

    return page, next_resume_keys


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
        return _json_response(400, {"error": "name must include at least one letter or number"})

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

    # Rollover and a bill spread are spend-only. Reclassifying a category OUT of a spend
    # bucket must clear both (keeping the target) so a stale carryover anchor can't re-fold
    # on a later move back to spend (WHIT-474), and a stale spread can't keep adjusting.
    # Best-effort, category-first — like the delete cascade below: a failed clear only
    # leaves a recoverable stale field (inert while the category is non-spend, as the read
    # path ignores both on a non-spend bucket), never a corrupt entry, so it must not fail
    # the bucket edit. Each clear is its own attempt so one failing can't skip the other.
    if bucket in (INCOME_BUCKET, SAVINGS_BUCKET):
        for clear in (budget_repo.clear_rollover, budget_repo.clear_spread):
            try:
                clear(cat_id)
            except (VersionConflictError, DatabaseError) as e:
                logger.warning("%s failed for re-bucketed category %s: %s", clear.__name__, cat_id, e)

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
    except InvalidCategoryParentError as e:
        # Too many sub-categories to detach in one write — only reachable on data written
        # before the breadth cap. A 400 naming the fix, not an uncaught 500 (WHIT-426).
        return _json_response(400, {"error": str(e)})

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


def _fetch_windowed_transactions(repo: TransactionRepository, start: str | None, end: str | None) -> list[dict]:
    """Every transaction across all accounts within [start, end], following the
    date-index pagination to completion. `start`/`end` may be None for no floor/ceiling
    (whole history) — get_transactions_by_date_range treats no dates as the whole partition.

    Its callers need every row in the window (the budget rollup, the drill-in lists, and
    the whole-history uncategorized count), so this loops on the returned cursor until each
    account is exhausted rather than stopping at the first page. The loop is bounded
    (_MAX_PAGES_PER_ACCOUNT): a cursor that never terminates raises rather than hanging.
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


# The unfiled-category predicate now lives in the shared rule engine (WHIT-527), so the
# count, the /breakdown bucket, the rule sweep, and the webhook all decide "unfiled" the
# same way. Kept under the old name for the call sites that read like a handler local.
_is_unmapped_category = is_unfiled_category


def get_uncategorized_count(transaction_repo: TransactionRepository, category_repo: CategoryRepository) -> dict:
    """GET /transactions/uncategorized/count — how many uncategorized charges the user has
    across ALL history (WHIT-500), so the tab badge, tab-bar dot, and "All caught up" empty
    state reflect the whole picture, not just the loaded feed pages.

    "Uncategorized" mirrors the client's categoryIsUnmapped EXACTLY: a charge whose category
    is null OR a raw value not in the user's taxonomy, excluding income. It deliberately does
    NOT gate on contributes_to_budget (unlike the /breakdown uncategorized bucket) — the badge
    counts excluded transfers too (WHIT-330), so the count must, or it wouldn't match the list.
    """
    taxonomy_ids = {category["id"] for category in category_repo.list_categories()}
    transactions = _fetch_windowed_transactions(transaction_repo, None, None)
    count = sum(
        1
        for transaction in transactions
        if _is_unmapped_category(transaction.get("category"), taxonomy_ids)
    )
    return _json_response(200, {"count": count})


# How many raw feed chunks one uncategorized-feed request will walk to fill a page. Each
# chunk is a MAX_PAGE_SIZE-row slice of the merged feed, so this bounds a single Load More
# to ~this many × MAX_PAGE_SIZE rows scanned. If a user's uncategorized charges are sparse
# and deep, one request may return fewer than the target (with a continuation cursor) rather
# than scanning unbounded history; the next Load More resumes where this one stopped.
_MAX_UNCATEGORIZED_SCAN_PAGES = 30


def _fetch_uncategorized_feed_page(
    repo: TransactionRepository, taxonomy_ids: set[str], target: int, resume_keys: dict
) -> tuple[list[dict], dict]:
    """One page of uncategorized rows: walk the merged all-accounts feed from `resume_keys`,
    keeping only uncategorized charges (same rule as the count), until `target` of them
    accrue, history is exhausted, or the scan cap is hit. Returns the accumulated rows plus
    the resume map for the next page.

    Reuses _fetch_feed_page unchanged, so the walk stays gap-free and dupe-free. Each raw
    chunk is MAX_PAGE_SIZE rows (not `target`) to minimise round trips. The accumulated rows
    are NOT truncated to `target`: the cursor has already advanced past every raw row consumed
    to build them, so dropping any would skip an uncategorized charge (a gap). A page may
    therefore hold slightly more than `target` on the final chunk — harmless.
    """
    accumulated: list[dict] = []
    cursor = resume_keys
    for _ in range(_MAX_UNCATEGORIZED_SCAN_PAGES):
        raw_page, cursor = _fetch_feed_page(repo, MAX_PAGE_SIZE, cursor)
        accumulated.extend(
            row for row in raw_page
            if _is_unmapped_category(row.get("category"), taxonomy_ids)
        )
        if len(accumulated) >= target or not cursor:
            break
    return accumulated, cursor


def get_uncategorized_feed(
    event: dict, transaction_repo: TransactionRepository, category_repo: CategoryRepository
) -> dict:
    """GET /transactions/uncategorized/feed — the uncategorized-only feed, newest-first,
    paged back through FULL history (Load More).

    Same {transactions, nextCursor} shape and cursor format as /transactions/feed, but each
    page returns only uncategorized charges (the SAME rule as get_uncategorized_count, so the
    tab list and the badge can't disagree). A page can be sparse (or empty) yet still carry a
    non-null nextCursor when uncategorized rows sit deep in history — the client keeps
    "Load More" available while nextCursor is non-null.

        limit   (optional) — target uncategorized rows per page, clamped to [1, MAX_PAGE_SIZE]
                             (default FEED_PAGE_SIZE)
        cursor  (optional) — an opaque nextCursor from a previous page

    Bad input → 400.
    """
    limit, resume_keys, error = _parse_feed_page_params(event)
    if error is not None:
        return error

    taxonomy_ids = {category["id"] for category in category_repo.list_categories()}
    page, next_resume_keys = _fetch_uncategorized_feed_page(
        transaction_repo, taxonomy_ids, limit, resume_keys
    )
    _shape_feed_rows(page)

    return _json_response(200, {
        "transactions": page,
        "nextCursor": _encode_feed_cursor(next_resume_keys),
    })


def get_uncategorized_merchants(
    transaction_repo: TransactionRepository, category_repo: CategoryRepository
) -> dict:
    """GET /transactions/uncategorized/merchants — the unfiled charges grouped by merchant,
    biggest group first (WHIT-515).

    Walks ALL history, exactly like get_uncategorized_count, and uses the SAME "still needs
    filing" rule, so `unfiled` in the response reconciles with the tab badge. Grouping on the
    server is not an optimisation: the Uncategorized tab only holds the pages it has loaded and
    these charges live deep in the tail, so grouping in the app would show a partial picture —
    the WHIT-506 bug again, where the badge said 639 and the list showed 1.

    Read-only: it decides nothing and writes nothing. The rule minting and the filing are a
    separate, explicit request (WHIT-516).
    """
    taxonomy_ids = {category["id"] for category in category_repo.list_categories()}
    transactions = _fetch_windowed_transactions(transaction_repo, None, None)
    body = group_unfiled_by_merchant(
        transactions, lambda category: _is_unmapped_category(category, taxonomy_ids)
    )
    return _json_response(200, body)


def _as_leaf_rule(inline_rule: dict) -> dict:
    """The inline rule in the shape rule_engine evaluates. `conditionCount` 1 is not decoration:
    rule_engine refuses to act on anything it read only the first condition of, and this rule has
    exactly one by construction."""
    return {
        "id": None,
        "field": DEFAULT_RULE_FIELD,
        "operator": DEFAULT_RULE_OPERATOR,
        "value": inline_rule["value"],
        "categoryId": inline_rule["categoryId"],
        "conditionCount": 1,
    }


def _rule_that_would_fight(rules: list[dict], inline_rule: dict) -> dict | None:
    """An existing rule that would reach the same charges but file them to a DIFFERENT category,
    or None.

    Minting alongside one is quietly destructive. The two rules disagree, so every charge they
    both match is `conflicted` — never filed, on this run or any future one — and the user is
    left with a permanent contradiction she never asked for and can't see. She taps "file these
    as groceries", nothing (or only part) is filed, and the response says 200.

    The realistic way in: a rule she wrote months ago never touched her stored charges (WHIT-502),
    so that merchant still appears on the merchant screen with its charges unfiled.

    Nesting counts, not just an exact repeat: an existing "COLES EXPRESS -> petrol" fights an
    inline "COLES -> groceries" over every EXPRESS charge, and that is the shape the merchant
    screen already warns about in `alsoCatches`. Refusing is the honest answer until the more
    specific rule can win (WHIT-518) — minting files the non-overlapping charges and strands
    the rest for good.

    A rule to the SAME category is not a clash at any width: it agrees, so nothing conflicts, and
    the re-tap after a capped run depends on that (create_rule is safe to run twice, WHIT-497).
    """
    for rule in rules:
        if rule.get("categoryId") == inline_rule["categoryId"]:
            continue
        if rule_overlaps_text(rule, DEFAULT_RULE_FIELD, DEFAULT_RULE_OPERATOR,
                              inline_rule["value"]):
            return rule
    return None


def _validate_inline_rule(body: dict, taxonomy_ids: set[str]) -> tuple[dict | None, dict | None]:
    """The optional `rule` on an apply-rules request — the one this run should mint and sweep
    with (WHIT-516), so making a rule for a merchant and filing that merchant's existing charges
    is ONE request rather than two with a gap between them.

    Returns (rule, None), (None, None) when there is no inline rule, or (None, 400).

    Fenced hard, because this mints a rule that outlives the request and files in bulk:
      * the value must clear the SAME letters/digits floor the merchant screen offers groups by
        (merchant_groups.rule_value_is_safe), or a rule on "BP" files every BPAY transfer;
      * the category must be one the user actually has, or every charge filed to it would still
        read as unfiled and the next run would file it again, forever;
      * only "description contains" is minted here. A supplied field/operator is REJECTED rather
        than ignored — silently narrowing an "equals" to a "contains" would file the wrong
        charges, and the caller would never know.

    `income` is deliberately NOT accepted, unlike POST /enrichments: it is a valid rule target
    (filed, but not a taxonomy id) and rule_engine honours it, but this route mints from the
    merchant screen, where income categories aren't pickable (WHIT-158). Unreachable today.
    """
    rule = body.get("rule")
    if rule is None:
        return None, None
    if not isinstance(rule, dict):
        return None, _json_response(400, {"error": "invalid rule; expected an object"})
    if "field" in rule or "operator" in rule:
        return None, _json_response(
            400, {"error": "rule field/operator are not accepted here; this mints "
                           f"'{DEFAULT_RULE_FIELD} {DEFAULT_RULE_OPERATOR}' only"})

    value = rule.get("value")
    if not isinstance(value, str) or not rule_value_is_safe(value):
        return None, _json_response(
            400, {"error": "rule value must contain at least "
                           f"{MIN_RULE_VALUE_ALPHANUMERICS} letters or digits"})

    category_id = rule.get("categoryId")
    if not isinstance(category_id, str) or category_id not in taxonomy_ids:
        return None, _json_response(400, {"error": "rule categoryId is not one of your categories"})

    return {"value": value.strip(), "categoryId": category_id}, None


def _apply_rules_response(plan: dict, dry_run: bool, *, filed: list = (), vanished: list = (),
                          failed: list = (), already_filed: list = (), remaining: int = 0,
                          created_rule: dict | None = None) -> dict:
    """The one response shape both the preview and the write return, so the app renders the same
    summary either way — only the outcome lists differ.

    The counts summarise the PLAN (what the rules cover); the lists report the OUTCOME of this
    request:
      filed     — rows this request's write was ACCEPTED for, {id, category} each. Note the
                  weaker claim: a settlement reconciling the same row immediately afterwards
                  re-puts the whole item and can still land on top (WHIT-513).
      vanished  — rows deleted between the scan and the write. Nothing to retry; they are gone
                  from the next scan too.
      failed    — rows the write did not land on. A re-run retries them (they are still unfiled).
                  Covers a database error AND a row that changed underneath into something still
                  unfiled — a re-sync carrying the bank's own raw label back onto the row.
      alreadyFiled — rows something else filed between the scan and the write: a tap on the phone,
                  or a settlement carrying a category across. NOTHING was written and there is
                  nothing to retry — the user's own choice stands, which is the whole point.
      remaining — matched rows this request did NOT attempt, because the write cap or the time
                  budget stopped it. Rows in `failed` are NOT counted here (they were attempted),
                  but a re-run picks them up anyway. In a preview this equals `matched`.
      createdRule — the inline rule, newly created OR the existing one that already matched it,
                  or null. create_rule is safe to run twice (WHIT-497), so a re-tap after a
                  capped run returns the rule already there rather than minting a second — do
                  not render this as "rule created" without checking. A PREVIEW always reports
                  null: it writes nothing, including to BankSync, so the numbers can be seen
                  before any rule exists. The app uses the id to refresh its rules list.

    Note the guarantee is per-run: a charge filed to a category id that later stops existing reads
    as unfiled again, so a subsequent run may legitimately file it.
    """
    return _json_response(200, {
        "dryRun": dry_run,
        "rulesConsidered": plan["rules_considered"],
        "unfiled": plan["unfiled"],
        "matched": len(plan["matched"]),
        "conflicted": plan["conflicted"],
        "conflictedSamples": plan["conflicted_samples"],
        "byCategory": plan["by_category"],
        "byRule": plan["by_rule"],
        "skippedRules": plan["skipped_rules"],
        "filed": filed,
        "vanished": vanished,
        "failed": failed,
        "alreadyFiled": already_filed,
        "remaining": remaining,
        "createdRule": created_rule,
    })


def apply_rules_to_uncategorized(
    event: dict, transaction_repo: TransactionRepository, category_repo: CategoryRepository
) -> dict:
    """POST /transactions/uncategorized/apply-rules — file charges already stored that a rule
    covers, across ALL history.

    BankSync applies rules at sync time to INCOMING charges only, so rules never reach charges
    already stored (WHIT-502). This evaluates them literally (see rule_engine) against every
    charge the badge counts as unfiled, and either reports what it WOULD file or files it.

    Two shapes, by whether the body carries an inline `rule`:
      * no rule (the plain "Apply my rules" button) — sweeps ALL the user's rules.
      * with a rule — {"value": <str>, "categoryId": <slug>}, the merchant screen's "file this
        shop": mints that rule AND sweeps with ONLY it (WHIT-523), so filing one shop files just
        that shop, not whatever her other rules match. The existing rules are read only to refuse
        a clash (a rule that would fight the new one). A PREVIEW never mints it — the numbers can
        be seen before anything exists in BankSync.

        {"dryRun": true}   (default) — decide and report, write nothing
        {"dryRun": false}            — write

    Previewing is the default so a bulk write can never happen by accident: a non-boolean
    `dryRun` is rejected rather than coerced, a missing or non-object body is a 400, and a
    missing `dryRun` previews. Safe to run twice: a charge is only ever filed to a category that
    counts as FILED, so it leaves the unfiled set and the next run won't touch it — and
    create_rule is itself idempotent on rule identity (WHIT-497), so a re-tap after a timeout
    returns the existing rule rather than piling up duplicates.
    """
    started = time.monotonic()
    body, error = _parse_json_body(event)
    if error is not None:
        return error
    dry_run = body.get("dryRun", True)
    if not isinstance(dry_run, bool):
        return _json_response(400, {"error": "invalid dryRun; expected a boolean"})

    taxonomy_ids = {category["id"] for category in category_repo.list_categories()}
    inline_rule, error = _validate_inline_rule(body, taxonomy_ids)
    if error is not None:
        return error

    try:
        rules = list_rules()
    except BankSyncError as e:
        return _banksync_error_response(e)

    if inline_rule is not None:
        clash = _rule_that_would_fight(rules, inline_rule)
        if clash is not None:
            return _json_response(409, {
                "error": f"you already have a rule for that filing to "
                         f"'{clash['categoryId']}'",
                "existingRule": clash,
            })
        # File ONLY this shop (WHIT-523). The clash check above has already read the user's
        # existing rules; the sweep must not, or "file COLES" would also file whatever her other
        # rules match in stored history. The plain "Apply my rules" path (no inline rule) still
        # sweeps every rule.
        rules = [_as_leaf_rule(inline_rule)]

    def is_unfiled(category: str | None) -> bool:
        return _is_unmapped_category(category, taxonomy_ids)

    # No rules -> nothing can match, so skip the whole-history scan entirely.
    if not rules:
        empty = plan_rule_application([], [], is_unfiled)
        return _apply_rules_response(empty, dry_run)

    transactions = _fetch_windowed_transactions(transaction_repo, None, None)
    plan = plan_rule_application(rules, transactions, is_unfiled)

    if dry_run:
        return _apply_rules_response(plan, True, remaining=len(plan["matched"]))

    created_rule = None
    if inline_rule is not None:
        # Minted BEFORE the sweep, so the failure mode is the recoverable one: a rule that
        # exists with its existing charges not yet filed is exactly today's state, and tapping
        # again finishes the job. Filing first and failing here would leave the charges filed
        # with nothing to catch the next one.
        try:
            created_rule = create_rule(
                DEFAULT_RULE_FIELD, DEFAULT_RULE_OPERATOR,
                inline_rule["value"], inline_rule["categoryId"],
            )
        except BankSyncError as e:
            return _banksync_error_response(e)

    filed: list[dict] = []
    vanished: list[str] = []
    failed: list[str] = []
    already_filed: list[str] = []
    attempted = 0  # counts ATTEMPTS, not successes — it bounds the work this request does
    for transaction, category_id in plan["matched"]:
        if attempted >= APPLY_RULES_MAX_WRITES:
            break
        # Stop well inside the API Gateway window so the response the app sees is an honest
        # account of what was written; the rest is reported as `remaining` ("tap again").
        # `attempted and` guarantees at least one write per request, so a slow rule read or a
        # long scan can never starve the loop into looping forever with nothing to show.
        if attempted and time.monotonic() - started >= APPLY_RULES_TIME_BUDGET_SECONDS:
            break
        transaction_id = transaction.get("transaction_id")
        attempted += 1
        try:
            # Conditional on the category the SCAN saw, so a charge the user filed in the seconds
            # since keeps their choice (WHIT-508). Their tap always beats a rule.
            status, current_category = transaction_repo.update_transaction_category_if_unchanged(
                transaction["pk"], transaction["sk"], category_id, transaction.get("category")
            )
        except DatabaseError:
            failed.append(transaction_id)
            continue
        if status == "written":
            filed.append({"id": transaction_id, "category": category_id})
            continue
        # The row was deleted between the scan and the write (a pending aged out, or its posted
        # twin replaced it). Nothing to retry — it is gone from the next scan too.
        if status == "gone":
            vanished.append(transaction_id)
            continue
        # It changed underneath. Only the taxonomy says whether that counts as FILED: a tap files
        # it (leave it alone, say so), but a re-sync carrying the bank's own raw label back on
        # leaves it unfiled, and reporting THAT as filed would let the app claim the job was done
        # while the badge still counted the charge.
        if is_unfiled(current_category):
            failed.append(transaction_id)
            continue
        already_filed.append(transaction_id)

    return _apply_rules_response(
        plan, False, filed=filed, vanished=vanished, failed=failed,
        already_filed=already_filed, remaining=len(plan["matched"]) - attempted,
        created_rule=created_rule,
    )


def _cycle_window_for_lookback(paycycle_repo: PayCycleRepository, cycle: int) -> tuple[str, str]:
    """The [start, end] window for a pay cycle: cycle 0 = the current cycle
    [cycle_start, today], cycle n >= 1 = the nth FULL cycle before it. The single
    window source shared by /breakdown and the category drill-in list, so the two can
    never scope to different dates.
    """
    pay_cycle = paycycle_repo.get_paycycle()
    cycle_start, cycle_end = current_cycle_window(pay_cycle["last_pay_date"], pay_cycle["length"])
    if cycle >= 1:
        return nth_prior_cycle_window(cycle_start, pay_cycle["length"], cycle)
    return cycle_start, cycle_end


def _cycle_window_for(paycycle_repo: PayCycleRepository) -> tuple[str, str]:
    """The current pay-cycle [start, today] window — the single window source shared by
    the /budgets rollup and the budget-detail transaction list, so the list can never
    scope to a different window than the total.
    """
    return _cycle_window_for_lookback(paycycle_repo, 0)


def _windowed_rows_response(transactions: list[dict], predicate: Callable[[dict], bool]) -> dict:
    """Filter windowed transactions by `predicate`, strip the storage keys, sort
    newest-first, and wrap as a 200 array — the shared tail of the cycle-scoped
    drill-in endpoints (/budgets/{category}/transactions and
    /categories/{id}/transactions). Each endpoint supplies only its predicate; the
    window + fetch differ (budget = current cycle, category = ?cycle= look-back), so
    those stay in the callers.
    """
    rows = [transaction for transaction in transactions if predicate(transaction)]
    for transaction in rows:
        transaction.pop("pk", None)
        transaction.pop("sk", None)
    rows.sort(key=lambda transaction: transaction["date"], reverse=True)
    return _json_response(200, rows)


def get_paycycle_view(paycycle_repo: PayCycleRepository) -> dict:
    """GET /paycycle — the stored pay cycle plus `days_left`: the days from today to the
    next payday, computed fresh from the payday + length using the SAME window math the
    /budgets total uses. The client reads this instead of computing its own countdown, so
    app and server can't drift a day at the UTC/Melbourne seam (WHIT-341).
    """
    cycle = paycycle_repo.get_paycycle()
    cycle_start, today = current_cycle_window(cycle["last_pay_date"], cycle["length"])
    next_payday = date.fromisoformat(cycle_start) + timedelta(days=cycle["length"])
    return {**cycle, "days_left": (next_payday - date.fromisoformat(today)).days}


def _rollover_windows(entry: dict, cycle_start: str, length: int, last_pay_date: str):
    """Pure date math for one rollover category: the completed pay cycles to fold this
    read, and a re-anchor payload if accumulation must restart.

    Returns (windows, reanchor). `windows` is the completed-cycle [(start, end), ...] since
    the stored anchor (oldest-first, capped). `reanchor` is a {carryover, carryover_from}
    payload — freeze the balance and re-anchor to the current cycle — when the stored anchor
    is missing or was sealed under a DIFFERENT pay cycle (length or payday changed); in that
    case `windows` is [] (a changed cycle makes the old windows fictional, so nothing is
    folded that read). Alignment is checked on the exact length+payday, NOT a modular test:
    e.g. 14->7 keeps `% length == 0` yet doubles the cycles.
    """
    anchor = entry.get("carryover_from")
    aligned = (
        anchor is not None
        and int(entry.get("carryover_len", 0)) == length
        and entry.get("carryover_paydate") == last_pay_date
    )
    if not aligned:
        reanchor = {"carryover": entry.get("carryover", Decimal(0)), "carryover_from": cycle_start}
        return [], reanchor
    windows = completed_cycle_windows(anchor, cycle_start, length, ROLLOVER_MAX_LOOKBACK_CYCLES)
    return windows, None


def _seal_rollover(entry: dict, windows: list, subtree: set, transactions: list,
                   length: int, today: str):
    """Fold each completed cycle's leftover (target - spend) for one rollover category,
    sealing cycles older than the settle lag into the stored balance.

    Returns (display_carryover, persist). `display_carryover` is the full buffer to show =
    sealed balance + not-yet-sealed completed-cycle leftovers (signed — a spike cycle's
    overspend carries as a deficit). `persist` is a {carryover, carryover_from} payload when
    the sealed balance or anchor advanced, else None. The current in-progress cycle is NOT
    in `windows`, so its spend is never double-counted here (it shows as posted/pending).

    Leftover uses the category's CURRENT target (no per-cycle target history is stored); the
    ~10-day lag means a regularly-opened app seals each cycle with the target in force around
    then, and a later target edit only moves the not-yet-sealed cycles.
    """
    stored_carryover = entry.get("carryover", Decimal(0))
    target = entry["target"]
    lag_cutoff = date.fromisoformat(today) - timedelta(days=ROLLOVER_SETTLE_LAG_DAYS)
    sealed = stored_carryover
    unsealed = Decimal(0)
    # Floor the anchor at the oldest window we actually fetched: if the cap dropped older
    # cycles, advance past them rather than re-scanning them forever.
    new_anchor = windows[0][0] if windows else entry.get("carryover_from")
    for window_start, window_end in windows:
        cycle_txns = transactions_in_window(transactions, window_start, window_end)
        per_id = summarise_transactions(cycle_txns, subtree, clamp=False)
        spend = fold_subtree(per_id, subtree)
        leftover = target - (spend["posted"] + spend["pending"])
        if date.fromisoformat(window_end) < lag_cutoff:
            sealed += leftover
            new_anchor = (date.fromisoformat(window_start) + timedelta(days=length)).isoformat()
        else:
            unsealed += leftover
    persist = None
    if sealed != stored_carryover or new_anchor != entry.get("carryover_from"):
        persist = {"carryover": sealed, "carryover_from": new_anchor}
    return sealed + unsealed, persist


def _persist_spread_settlements(budget_repo: BudgetRepository, finished: list, reanchored: dict) -> None:
    """Write each spread's read-side outcome back — clear the finished ones, re-save the
    settled ones — BEST-EFFORT, same posture as the rollover settle: the row is recomputed
    live on every read (a finished plan contributes 0, a settle re-derives the same plan), so
    a lost race or DB blip must never 500 the GET; it just lands on the next read. Each write
    is its own attempt so one failing can't skip the rest."""
    for cat_id in finished:
        try:
            budget_repo.clear_spread(cat_id)
        except Exception as e:
            logger.warning("spread clear failed for %s (recomputes next read): %s", cat_id, e)
    for cat_id, plan in reanchored.items():
        try:
            budget_repo.set_spread(
                cat_id, plan["spread_amount"], int(plan["spread_cycles"]), plan["spread_from"],
                int(plan["spread_len"]), plan["spread_paydate"],
            )
        except Exception as e:
            logger.warning("spread settle failed for %s (recomputes next read): %s", cat_id, e)


def _persist_rollover_settlements(budget_repo: BudgetRepository, settlements: dict,
                                  length: int, last_pay_date: str) -> None:
    """Write each rollover seal/re-anchor back — BEST-EFFORT. The displayed carryover is
    always recomputed live, so persistence is only a cost bound (it lets the next read skip
    already-sealed cycles). A lost version race or any DB blip must never 500 the GET, so
    every write is swallowed-and-logged (same posture as the WHIT-447 mint-migration)."""
    for cat_id, payload in settlements.items():
        try:
            budget_repo.settle_carryover(
                cat_id, payload["carryover"], payload["carryover_from"], length, last_pay_date
            )
        except Exception as e:
            logger.warning("rollover settle failed for %s (recomputes next read): %s", cat_id, e)


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
    so the bar agrees with the /breakdown screen. Every budgeted id (parent or leaf)
    returns {target, posted, pending, rollover, carryover}. A leaf target with no children
    rolls up only itself, byte-identical to the pre-rollup behaviour.

    Rollover (envelope carryover): a category with `rollover` on accumulates each cycle's
    leftover (target - spend) into a signed `carryover` buffer, so a sinking-fund category
    builds up until a bill lands and a spike cycle carries its overspend as a deficit. The
    buffer is SEALED lazily here (write-on-read, best-effort): completed cycles older than
    the settle lag fold into the stored balance; the recent unsealed cycles are recomputed
    live, so the returned `carryover` is stable across the sealing write. `carryover` is 0
    for a non-rollover budget — a legacy budget with no rollover field is byte-identical to
    before (bar the two always-present keys). Rollover applies to SPEND categories only: a
    flag left on a category later re-bucketed to Income/Savings is ignored (its earnings are
    never folded as a spend buffer).

    Bill spread (WHIT-504): a category with a spread plan carries a `spread` object —
    {amount, cycles, index, adjustment} — whose signed `adjustment` the client adds to the
    cycle's spendable: the full cushion in the anchor cycle, then an equal slice taken back
    each of the next `cycles` cycles (see _spread_state). A plan that has finished, or was
    settled after a pay-cycle change, is cleared best-effort here. Like rollover it is
    spend-only, ignored on a re-bucketed category, and a plain budget's wire shape is
    unchanged. A category has rollover OR a spread, never both (enforced on write).
    """
    targets = budget_repo.list_budgets()  # {id: entry}
    if not targets:
        return {}
    pay_cycle = paycycle_repo.get_paycycle()
    length = pay_cycle["length"]
    last_pay_date = pay_cycle["last_pay_date"]
    cycle_start, today = current_cycle_window(last_pay_date, length)

    categories = category_repo.list_categories()
    bucket_by_id = {c["id"]: c.get("bucket") for c in categories}
    children = build_category_children(categories)

    # Each target maps to its whole subtree — the target itself plus every descendant
    # at any depth — so a transaction tagged directly onto a parent counts toward its
    # budget too (WHIT-228). A leaf/orphan target maps to just itself, byte-identical
    # to the pre-rollup behaviour.
    ids_by_target = {cat_id: subtree_ids(cat_id, children, bucket_by_id) for cat_id in targets}

    # Rollover only for a flagged category that is STILL a spend category — a re-bucket to
    # Income/Savings after the flag was set falls back to plain output (the write guard only
    # blocks the flag going on; the bucket can change later on a different endpoint).
    rollover_ids = {
        cat_id for cat_id, entry in targets.items()
        if entry.get("rollover") and bucket_by_id.get(cat_id) not in (INCOME_BUCKET, SAVINGS_BUCKET)
    }
    # Same still-spend guard for a bill spread: the clear on reclassify is best-effort, so a
    # stale plan on a re-bucketed category must not move its spendable.
    spread_ids = {
        cat_id for cat_id, entry in targets.items()
        if "spread_amount" in entry and bucket_by_id.get(cat_id) not in (INCOME_BUCKET, SAVINGS_BUCKET)
    }

    # Pure date math up front: the completed cycles each rollover target must fold (and any
    # re-anchor). This drives how far back to widen the ONE transaction fetch — a non-rollover
    # read still fetches just the current cycle, unchanged.
    windows_by_id = {}
    reanchor_by_id = {}
    fetch_start = cycle_start
    for cat_id in rollover_ids:
        windows, reanchor = _rollover_windows(targets[cat_id], cycle_start, length, last_pay_date)
        windows_by_id[cat_id] = windows
        if reanchor is not None:
            reanchor_by_id[cat_id] = reanchor
        if windows:
            fetch_start = min(fetch_start, windows[0][0])

    transactions = _fetch_windowed_transactions(transaction_repo, fetch_start, today)
    # posted/pending are always the CURRENT cycle only. When no rollover widened the fetch,
    # it already IS the current window (byte-identical to before); when it was widened for
    # sealing, slice back to the current cycle by transaction date.
    current = transactions if fetch_start == cycle_start else transactions_in_window(transactions, cycle_start, today)

    # Split by each id's own bucket (the same-bucket rule keeps a subtree single-
    # bucket, so a parent and its descendants all land on one side). Sum every needed
    # id once (UNCLAMPED), fold per target, then clamp the target total once — so a
    # net-negative sibling nets against the rest before the floor, and the header can't
    # read higher than its own signed transaction list (aggregate-then-clamp, WHIT-343).
    needed_ids = set().union(*ids_by_target.values()) if ids_by_target else set()
    income_ids = {cid for cid in needed_ids if bucket_by_id.get(cid) == INCOME_BUCKET}
    spend_ids = needed_ids - income_ids

    per_id = summarise_transactions(current, spend_ids, clamp=False)
    per_id.update(summarise_income(current, income_ids, clamp=False))

    settlements = {}  # cat_id -> {carryover, carryover_from}, written best-effort after the loop
    finished_spreads = []   # cat_ids whose spread ran its course, cleared best-effort
    reanchored_spreads = {}  # cat_id -> the settle plan replacing it after a pay-cycle change
    result = {}
    for cat_id, entry in targets.items():
        folded = fold_subtree(per_id, ids_by_target[cat_id])
        row = {
            "target": entry["target"],
            "posted": folded["posted"],
            "pending": folded["pending"],
        }
        # Only a rollover category carries the extra keys — a non-rollover (or legacy)
        # budget's wire shape stays byte-identical; the client defaults rollover/carryover.
        if cat_id in rollover_ids:
            if cat_id in reanchor_by_id:
                carryover = reanchor_by_id[cat_id]["carryover"]
                settlements[cat_id] = reanchor_by_id[cat_id]
            else:
                carryover, persist = _seal_rollover(
                    entry, windows_by_id[cat_id], ids_by_target[cat_id], transactions, length, today
                )
                if persist is not None:
                    settlements[cat_id] = persist
            row["rollover"] = True
            row["carryover"] = carryover
        if cat_id in spread_ids:
            spread_row, finished, reanchor = _spread_state(entry, cycle_start, length, last_pay_date, today)
            if spread_row is not None:
                row["spread"] = spread_row
            if finished:
                finished_spreads.append(cat_id)
            if reanchor is not None:
                reanchored_spreads[cat_id] = reanchor
        result[cat_id] = row

    _persist_rollover_settlements(budget_repo, settlements, length, last_pay_date)
    _persist_spread_settlements(budget_repo, finished_spreads, reanchored_spreads)
    return result


def get_budget_transactions(
    event: dict,
    transaction_repo: TransactionRepository,
    paycycle_repo: PayCycleRepository,
    category_repo: CategoryRepository,
) -> dict:
    """GET /budgets/{category}/transactions — the charges behind a budget's
    posted+pending total: every contributing transaction in the current pay cycle,
    across the category's whole subtree, newest first.

    Built from the SAME window (_cycle_window_for), subtree (subtree_ids) and
    contribution rule (contributes_to_budget) as list_budgets, so the rows sum to the
    budget header. This replaces the client's old rolling 7-day feed slice, which
    under-counted any cycle longer than the feed window and dropped sub-category spend
    (the /budgets total already counts both). A bare newest-first array like the
    /transactions feed; the client shows the first rows and reveals the rest on Load More.
    """
    category_id = (event.get("pathParameters") or {}).get("category")
    if not category_id:
        return _json_response(404, {"error": "budget not found"})

    start, end = _cycle_window_for(paycycle_repo)
    transactions = _fetch_windowed_transactions(transaction_repo, start, end)

    categories = category_repo.list_categories()
    bucket_by_id = {c["id"]: c.get("bucket") for c in categories}
    children = build_category_children(categories)
    target_ids = subtree_ids(category_id, children, bucket_by_id)

    return _windowed_rows_response(
        transactions,
        lambda transaction: transaction.get("category") in target_ids
        and contributes_to_budget(transaction),
    )


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
    optionally "__uncategorized__": {...}, optionally "__earned__": {...},
    optionally "__income__": {...}, "__rollup__": {...}}. The "__earned__" bucket is the
    TOTAL income (all Income-bucket categories) over the same window, for the Insights
    Earned-vs-Spent chart (WHIT-312); "__income__" breaks that same total down PER SOURCE
    ({income_category_id: {posted, pending}}) for the "drill into Earned" screen (WHIT-366);
    both added only when there's income. "__rollup__" (server-owned netted parent totals) is
    ALWAYS present (WHIT-358), even for a flat taxonomy with no parents (then its "nodes"
    is {}) or a window with no spend — so the ONLY meaning of a missing "__rollup__" is
    "an old server", which lets the client's fallback be a pure rollout shim. The flat
    per-category keys may still be empty (e.g. a past window that predates first sync); in
    that case the response is just {"__rollup__": {"nodes": {}}}.
    """
    categories = category_repo.list_categories()
    start, end = _cycle_window_for_lookback(paycycle_repo, cycle)
    transactions = _fetch_windowed_transactions(transaction_repo, start, end)

    all_ids = {c["id"] for c in categories}
    spend_ids = {c["id"] for c in categories if c.get("bucket") in SPEND_BUCKETS}
    income_ids = {c["id"] for c in categories if c.get("bucket") == INCOME_BUCKET}

    result = summarise_transactions(transactions, spend_ids)

    uncategorized = summarise_uncategorized(transactions, all_ids)
    if uncategorized["posted"] > 0 or uncategorized["pending"] > 0:
        result[UNCATEGORIZED_KEY] = uncategorized

    # Total earned this cycle (all Income-bucket categories) over the SAME window as
    # spend, so the Insights Earned-vs-Spent chart's two bars line up (WHIT-312). Added
    # only when there's income, so a no-income cycle's response is byte-identical to
    # before — old clients ignore the extra key, new clients read it as earned (else 0).
    earned = summarise_earned(transactions, income_ids)
    has_earned = earned["posted"] > 0 or earned["pending"] > 0
    if has_earned:
        result[EARNED_KEY] = earned

    # Per-source income (WHIT-366/376): the same earnings broken out by category, so the
    # "drill into Earned" screen can list each source (Salary, side income, …) under the
    # __earned__ total. Use the SIGNED per-source net (clamp=False), so a source clawed back
    # this cycle survives as a NEGATIVE row instead of vanishing — the client renders it as a
    # "−$X" reversal and reconciles the rows to __earned__ (WHIT-376), the way Spend already
    # shows net-refunded members. Drop only a source that nets to EXACTLY $0 (no phantom row).
    # Gate on __earned__ being present (not merely a non-empty map): an all-reversed cycle nets
    # <= 0, so __earned__ is absent and __income__ must be too — otherwise the client would show
    # a lone negative row under a $0 headline. Absent when no income ⇒ old-client safe.
    income_sources = {
        category_id: amounts
        for category_id, amounts in summarise_income(transactions, income_ids, clamp=False).items()
        if amounts["posted"] + amounts["pending"] != 0
    }
    if has_earned and income_sources:
        result[INCOME_KEY] = income_sources

    # __rollup__ (WHIT-349): server-owned netted parent totals, so the Insights donut reads
    # a parent's spend from here instead of summing per-id-FLOORED leaves on the client —
    # which under-counted a refund and disagreed with /budgets on a net-refunded sub. Same
    # aggregate-then-clamp fold as /budgets (fold_subtree over the same-bucket subtree), so a
    # parent's donut total equals its Budgets bar. Additive: the flat per-category keys above
    # are untouched (the pie slices + the category drill-in still reconcile to them), and old
    # clients ignore the key. Only parents (ids with children) need it — a leaf's netted
    # subtree is just its own already-floored flat value.
    children = build_category_children(categories)
    bucket_by_id = {c["id"]: c.get("bucket") for c in categories}
    per_id_signed = summarise_transactions(transactions, spend_ids, clamp=False)
    nodes = {}
    for parent_id in children:
        # Spend parents only (a fast-path; a non-spend parent would fold to 0 anyway —
        # its subtree is bucket-filtered and per_id_signed covers only spend ids).
        if parent_id not in spend_ids:
            continue
        folded = fold_subtree(per_id_signed, subtree_ids(parent_id, children, bucket_by_id))
        if folded["posted"] > 0 or folded["pending"] > 0:
            nodes[parent_id] = folded
    if nodes:
        rollup = {"nodes": nodes}
        # Per-parent refund detail (WHIT-349): the members whose signed net is negative and are
        # therefore HIDDEN from the flat rows (floored to 0), so the client can show a "refund"
        # line and an expanded parent's rows still sum to its netted node. A member is either the
        # parent's OWN direct spend, or a same-bucket direct child whose whole subtree nets < 0
        # (it collapses — no node, dropped on the client). `amount` is the single negative combined
        # net, keyed under the direct child (or the parent itself). Additive; absent when empty.
        # A member gets a refund line only if it is FULLY HIDDEN — its own per-id floored value is
        # {0,0} (posted <= 0 AND pending <= 0). A member still shown as a flat row (e.g. a settled
        # refund in `posted` alongside a new `pending` charge -> floored {0, +x}) must NOT also get a
        # refund line, or it would appear twice. (The rare posted-vs-pending sign split then can't
        # fully reconcile the expanded list — the node clamps each bucket independently — but the
        # donut/bar total is always exactly the node; tracked as a follow-up.)
        def _hidden(sig):
            return sig is None or (sig["posted"] <= 0 and sig["pending"] <= 0)

        refunds = {}
        for parent_id in nodes:
            lines = []
            own = per_id_signed.get(parent_id)
            if own is not None and _hidden(own) and own["posted"] + own["pending"] < 0:
                lines.append({"id": parent_id, "amount": own["posted"] + own["pending"]})
            for child_id in children.get(parent_id, []):
                if bucket_by_id.get(child_id) != bucket_by_id.get(parent_id):
                    continue  # cross-bucket child isn't part of this parent's subtree
                if not _hidden(per_id_signed.get(child_id)):
                    continue  # the child still shows as its own flat row — not also a refund line
                child_net = sum(
                    (per_id_signed[cid]["posted"] + per_id_signed[cid]["pending"]
                     for cid in subtree_ids(child_id, children, bucket_by_id) if cid in per_id_signed),
                    Decimal(0),
                )
                if child_net < 0:  # net-positive/zero children show as their own rows, not refunds
                    lines.append({"id": child_id, "amount": child_net})
            if lines:
                refunds[parent_id] = lines
        if refunds:
            rollup["refunds"] = refunds
        result[ROLLUP_KEY] = rollup
    else:
        # WHIT-358 (slice 5a): always emit __rollup__, even with no parents, so a new client
        # renders a flat taxonomy via the server path (leaves read their floored flat value; the
        # total is the depth-0 sum) and "no __rollup__" means ONLY "old server". That makes the
        # client's computeCombined fallback a pure rollout shim, deletable in 5b (WHIT-353) once
        # this is deployed everywhere. Additive: old clients ignore the key.
        result[ROLLUP_KEY] = {"nodes": {}}
    return result


def get_category_transactions(
    event: dict,
    transaction_repo: TransactionRepository,
    paycycle_repo: PayCycleRepository,
    category_repo: CategoryRepository,
) -> dict:
    """GET /categories/{id}/transactions — the transactions behind one /breakdown row:
    every charge filed on a single category (or the uncategorized bucket) over the
    selected pay cycle, newest-first.

    Same window as /breakdown (_cycle_window_for_lookback, so ?cycle= look-back matches),
    but returns the rows, not an aggregate. This replaces the drill-in's old 7-day feed
    slice, which under-counted a cycle longer than the feed and returned nothing at all
    for last cycle (whose window sits entirely outside the feed).

    Selection mirrors /breakdown's two row groups:
      * a named category: EXACT match (no subtree — /breakdown rows are per-category), and
        NO contributes_to_budget filter, so the list shows refunds/excluded rows too (the
        client recomputes the contributing total for the header).
      * UNCATEGORIZED_KEY: the summarise_uncategorized rule — contributes to budget, not
        income, and not in the taxonomy.
    """
    cycle, cycle_error = _parse_breakdown_cycle(event)
    if cycle_error is not None:
        return cycle_error
    category_id = (event.get("pathParameters") or {}).get("id")
    if not category_id:
        return _json_response(404, {"error": "category not found"})

    start, end = _cycle_window_for_lookback(paycycle_repo, cycle)
    transactions = _fetch_windowed_transactions(transaction_repo, start, end)

    if category_id == UNCATEGORIZED_KEY:
        taxonomy_ids = {category["id"] for category in category_repo.list_categories()}

        def predicate(transaction: dict) -> bool:
            return (contributes_to_budget(transaction)
                    and _is_unmapped_category(transaction.get("category"), taxonomy_ids))
    else:
        def predicate(transaction: dict) -> bool:
            return transaction.get("category") == category_id

    return _windowed_rows_response(transactions, predicate)


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
    # Unclamped per id, then clamp each parent's total once — same aggregate-then-clamp
    # as /budgets, so the AI's parent spend can't disagree with the Budgets screen (WHIT-343).
    rollup = summarise_transactions(transactions, needed_ids, clamp=False)
    rows = []
    for cid in parents:
        folded = fold_subtree(rollup, ids_by_parent[cid])
        row = {"name": names.get(cid, cid), "posted": float(folded["posted"]), "pending": float(folded["pending"])}
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


def _validate_label(raw, max_len, noun) -> tuple[str | None, dict | None]:
    """Non-empty string → trimmed → length-capped. Returns (label, None) on success or
    (None, error_response) on failure. Shared by set_milestones and
    _validate_goal_checkpoints (WHIT-480) so the label rule can't drift between them."""
    if not isinstance(raw, str) or not raw.strip():
        return None, _json_response(400, {"error": f"each {noun} needs a non-empty label"})
    label = raw.strip()
    if len(label) > max_len:
        return None, _json_response(400, {"error": f"{noun} label too long"})
    return label, None


def _validate_id(raw_id, seen_ids, noun) -> tuple[str | None, dict | None]:
    """Mint a uuid when the id is absent; otherwise reject a blank/non-string id, trim it
    (so " a "/"a" collide), and reject a duplicate within `seen_ids`. On success adds the id
    to `seen_ids` (mutates it) and returns (id, None); on failure returns (None,
    error_response). Callers that need to know whether an id was minted capture
    `raw_id is None` themselves before calling — the helper never exposes that (WHIT-480)."""
    if raw_id is None:
        new_id = str(uuid.uuid4())
    elif not isinstance(raw_id, str) or not raw_id.strip():
        return None, _json_response(400, {"error": f"{noun} id must be a non-empty string"})
    else:
        new_id = raw_id.strip()
    if new_id in seen_ids:
        return None, _json_response(400, {"error": f"{noun} ids must be unique"})
    seen_ids.add(new_id)
    return new_id, None


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


def _fetch_one_account_balance(source: dict, api_key: str) -> tuple:
    """Fetch + normalise one account's live balance. Returns (aid, normalised balance)."""
    payload = fetch_balance(
        source["bid"],
        source["aid"],
        api_key,
        base_url=BANKSYNC_BASE_URL,
        timeout=REFRESH_FETCH_TIMEOUT_SECONDS,
        user_agent=BANKSYNC_USER_AGENT,
    )
    return source["aid"], normalise_account_balance(payload)


def refresh_account_balances(repo: AccountBalanceRepository) -> dict:
    """POST /accounts/balances/refresh — fetch fresh balances from BankSync now (WHIT).

    Pull-to-refresh calls this so the Accounts tab shows live balances rather than the daily
    poller's stored values. Throttled to REFRESH_THROTTLE_SECONDS: a call within that window
    of the last live fetch returns the stored balances with no bank call. Otherwise it fans a
    concurrent getBalance out per account (short timeout, well under the API-Gateway cap),
    upserts each account that succeeds, and returns the same shape as GET /accounts/balances.

    Best-effort per account (matches the daily poller): one broken/re-linked account keeps its
    last-good row and never blocks the others. A 502 comes back only when EVERY account failed.
    """
    now = int(time.time())
    last = repo.get_last_refresh_at()
    if last is not None and now - last < REFRESH_THROTTLE_SECONDS:
        return _json_response(200, repo.list_balances(sorted(set(ACCOUNT_ID_MAP.values()))))

    api_key = get_api_key()
    fresh = []
    with ThreadPoolExecutor(max_workers=len(BALANCE_SOURCES)) as executor:
        futures = [executor.submit(_fetch_one_account_balance, source, api_key) for source in BALANCE_SOURCES]
        for future in futures:
            try:
                fresh.append(future.result())
            except (BalanceError, OSError, ValueError) as e:
                # Best-effort: log and skip this account; the others still refresh.
                logger.warning("live balance refresh failed for one account: %s", e)

    # Arm the throttle on any live attempt, so pull-spam during a bank hiccup still backs off.
    repo.set_last_refresh_at(now)

    if not fresh:
        return _json_response(502, {"error": "could not refresh balances"})

    for aid, balance in fresh:
        repo.upsert_balance(
            ACCOUNT_ID_MAP[aid],
            balance["amount"],
            balance["available_balance"],
            balance["currency"],
            balance["as_of"],
            balance["account_type"],
        )
    return _json_response(200, repo.list_balances(sorted(set(ACCOUNT_ID_MAP.values()))))


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

    repayment = when = amount = None
    for r in rows:
        if is_repayment_credit(r):
            repayment, when, amount = r, r["date"], r["amount"]
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
        # A single malformed interest row (null/missing/non-numeric amount) must not 500
        # the card — skip anything we can't read rather than trusting the row shape.
        if r.get("category") == INTEREST_CATEGORY and str(r.get("date", ""))[:7] == month:
            amount_leg = r.get("amount")
            if is_number(amount_leg) and amount_leg < 0:
                interest = (interest or 0) + abs(amount_leg)   # stored negative; accumulate magnitudes

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
        return {**{field: None for field in _LOANFACTS_FIELDS}, "payoffGoalDate": None, "depositTarget": None}
    return stored


def set_loanfacts(event: dict, repo: LoanFactsRepository) -> dict:
    """PUT /loanfacts — save (replace) the user's home-loan facts.

    Body: all six of {original, homeValue, lvr, ratePct, baseRepay, extra}, plus an
    optional payoffGoalDate (WHIT-126) and an optional depositTarget (WHIT-378, a
    positive dollar amount). The six-field object is required and replaced
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

    # Optional target payoff date (WHIT-126): absent/None is fine (unset or cleared); when present
    # it must be a real ISO YYYY-MM-DD calendar date. Shape and calendar are checked separately so
    # the 400 says WHICH is wrong; the shape regex is the one shared source (ISO_DATE_RE, WHIT-418).
    goal_date = body.get("payoffGoalDate")
    if goal_date is not None:
        if not isinstance(goal_date, str) or not ISO_DATE_RE.match(goal_date):
            return _json_response(400, {"error": "payoffGoalDate must be an ISO YYYY-MM-DD date"})
        try:
            date.fromisoformat(goal_date)
        except ValueError:
            return _json_response(400, {"error": "payoffGoalDate must be a real calendar date"})

    # Optional next-place deposit target (WHIT-378): absent/None is fine (unset or
    # cleared); when present it must be a finite number > 0 within the dollar ceiling.
    deposit_target = body.get("depositTarget")
    if deposit_target is not None:
        if isinstance(deposit_target, bool) or not isinstance(deposit_target, (int, float)):
            return _json_response(400, {"error": "depositTarget must be a number"})
        if not math.isfinite(deposit_target):
            return _json_response(400, {"error": "depositTarget must be a finite number"})
        if deposit_target <= 0:
            return _json_response(400, {"error": "depositTarget must be > 0"})
        if deposit_target > LOANFACTS_FIELD_MAX:
            return _json_response(400, {"error": "depositTarget too large"})

    saved = repo.set_loanfacts(
        **{k: Decimal(str(v)) for k, v in values.items()},
        payoffGoalDate=goal_date,
        depositTarget=Decimal(str(deposit_target)) if deposit_target is not None else None)
    return _json_response(200, saved)


# Milestone plan limits (WHIT-375). Handler literals — not shared constants — so they
# never cross the lambda_api constants shadow (WHIT-136).
_MILESTONE_MAX_COUNT = 50
_MILESTONE_LABEL_MAX_LEN = 100
_MILESTONE_BALANCE_MAX = 1_000_000_000


def current_scope(event: dict) -> str:
    # Multi-tenant seam (WHIT-375): resolve "whose milestones?" in ONE place. Today every
    # request maps to the shared scope. Later, return the authenticated user id from the JWT
    # claims (event["requestContext"]["authorizer"]["jwt"]["claims"]["sub"]) — only this line
    # changes. No scope literal lives anywhere else.
    #
    # NOTE: the notify store's shared tenant is None, not this "SHARED" (WHIT-447). If you ever
    # rename the shared literal here, update _notify_scope in lockstep — it bridges the two on the
    # exact string "SHARED", and a silent mismatch makes the mint-marker migration write an item
    # the poller never reads (an inert fix, no error).
    return "SHARED"


def get_milestones(event: dict, repo: MilestoneRepository) -> list:
    """GET /milestones — the user's saved milestone plan.

    Returns the saved list, or an empty list while unset — the app shows its own built-in
    default plan until the user saves their own (WHIT-376).
    """
    stored = repo.get_milestones(current_scope(event))
    return stored if stored is not None else []


def set_milestones(event: dict, repo: MilestoneRepository, notify_repo: NotifyRepository) -> dict:
    """PUT /milestones — save (replace) the whole milestone plan.

    Body: {"milestones": [{label, targetBalance, targetDate, id?}, ...]} — a non-empty
    list, replaced whole (add/edit/delete/reorder are all one PUT). Each targetBalance is
    validated like a loan-facts field (reject bool, require a finite number in [0, cap]);
    targetDate must be a real ISO YYYY-MM-DD date; and the list must be strictly paid-down —
    each step a LOWER targetBalance and a LATER targetDate than the one before. (This extends
    shared/milestones.py's balance-only load-time invariant, additionally requiring
    strictly-increasing targetDate.) A milestone without an id gets a fresh uuid so later
    edits key off a stable id (WHIT-378); a supplied id is preserved. Stored via
    Decimal(str(...)) to avoid float drift.

    Minting an id for a legacy id-less row also migrates that row's "already celebrated"
    notify marker onto the new id (WHIT-447), so the next poll keeps — rather than re-arms —
    the celebration. `notify_repo` is required so that migration can never be silently skipped.
    """
    body, error = _parse_json_body(event)
    if error:
        return error

    raw = body.get("milestones")
    if not isinstance(raw, list) or not raw:
        return _json_response(400, {"error": "milestones must be a non-empty list"})
    if len(raw) > _MILESTONE_MAX_COUNT:
        return _json_response(400, {"error": f"milestones must have at most {_MILESTONE_MAX_COUNT} entries"})

    cleaned = []
    ids = set()
    minted = []  # (stored target, minted id) for legacy rows we filled an id into — WHIT-447
    for m in raw:
        if not isinstance(m, dict):
            return _json_response(400, {"error": "each milestone must be an object"})

        label, error = _validate_label(m.get("label"), _MILESTONE_LABEL_MAX_LEN, "milestone")
        if error:
            return error

        balance = m.get("targetBalance")
        if not _finite_number(balance, low=0, high=_MILESTONE_BALANCE_MAX):
            return _json_response(400, {"error": "targetBalance must be a number between 0 and the cap"})

        target_date = m.get("targetDate")
        if not _valid_iso_date(target_date):
            return _json_response(400, {"error": "targetDate must be a real ISO YYYY-MM-DD date"})

        raw_id = m.get("id")
        was_id_less = raw_id is None  # capture before minting — drives the WHIT-447 marker backfill
        milestone_id, error = _validate_id(raw_id, ids, "milestone")
        if error:
            return error

        stored_balance = Decimal(str(balance))
        cleaned.append({
            "id": milestone_id,
            "label": label,
            "targetBalance": stored_balance,
            "targetDate": target_date,
        })
        if was_id_less:
            minted.append((stored_balance, milestone_id))

    # Strictly paid-down: each step a LOWER balance and a LATER date than the previous. ISO
    # YYYY-MM-DD strings compare lexically == chronologically, so a plain string compare is
    # safe. (Extends shared/milestones.py's balance-only invariant with the date check.)
    for prev, cur in zip(cleaned, cleaned[1:]):
        if not (cur["targetBalance"] < prev["targetBalance"] and cur["targetDate"] > prev["targetDate"]):
            return _json_response(400, {
                "error": "milestones must be ordered by strictly decreasing targetBalance and increasing targetDate"})

    saved = repo.set_milestones(cleaned, current_scope(event))
    _migrate_minted_milestone_markers(event, notify_repo, minted)
    return _json_response(200, saved)


def _notify_scope(event: dict):
    """The notify-store scope for this request. The plan store's shared tenant is "SHARED"
    (current_scope); the notify store's is None → sk="FIRED" (repository_notify's back-compat
    wart). The poller reads and writes notify markers at scope None, so the save path must
    migrate at None too — passing "SHARED" would write to an sk="SHARED" item the poller never
    reads, making the fix inert (WHIT-447). A real per-user scope later returns the SAME id for
    both stores, so this bridge only affects the shared default."""
    scope = current_scope(event)
    return None if scope == "SHARED" else scope


def _migrate_minted_milestone_markers(event: dict, notify_repo: NotifyRepository, minted: list) -> None:
    """Carry each just-minted legacy row's "already celebrated" marker onto its new id, so the
    next poll keeps rather than re-arms the celebration (WHIT-447).

    Best-effort: the plan save has already committed, so a notify blip must never 500 the PUT.
    Worst case is one milestone left re-armed — a single stray celebration only if its balance
    later genuinely re-crosses (Option A, approved). The row is never id-less again, so this is a
    one-shot with no retry; that trade is accepted over blocking a plan save on the notify table."""
    if not minted:
        return
    try:
        migrations = [mint_migration_markers(target, minted_id) for target, minted_id in minted]
        notify_repo.migrate_milestone_markers(migrations, _notify_scope(event))
    except Exception as e:
        logger.warning("milestone marker mint-migration failed (plan already saved): %s", e)


# Absurd for a personal budget; also keeps a giant value from blowing past DynamoDB's
# number limit and 500ing at write instead of a clean 400. Named (WHIT-393) so the cap
# isn't a bare literal in the middle of the guard — _GOAL_AMOUNT_MAX is its sibling.
_BUDGET_TARGET_MAX = 1_000_000_000


def set_budget(
    event: dict, repo: BudgetRepository, category_repo: CategoryRepository,
    paycycle_repo: PayCycleRepository,
) -> dict:
    """PUT /budgets/{category} — set (upsert) a category's budget target, optionally its
    rollover flag.

    Body: {"target": <number >= 0>, "rollover"?: bool} — the user-set pay-cycle amount and
    (optionally) whether unused budget accumulates into next cycle. `target` is stored as a
    Decimal via Decimal(str(...)) so a JSON float never introduces binary-float drift. Omit
    `rollover` to leave the flag untouched (a plain amount edit never changes it).

    An UNKNOWN category id is still accepted (stored as an orphan the client ignores).
    A KNOWN Savings-bucket category is rejected (WHIT-202): the client can't render a
    target on it, so a stored one is an invisible phantom — this is the server backstop
    for the deep-link/back-door write the picker already blocks. Rollover is SPEND-only, so
    `rollover: true` is rejected on an Income earn-target too. The bucket read runs only
    after the cheap numeric checks pass.
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
    if target > _BUDGET_TARGET_MAX:
        return _json_response(400, {"error": "target too large"})

    rollover = body.get("rollover")
    if rollover is not None and not isinstance(rollover, bool):
        return _json_response(400, {"error": "rollover must be a boolean"})

    # WHIT-202: reject a Savings-bucket target (an unknown id stays accepted — .get is
    # None → not Savings). Same bucket-by-id idiom list_budgets uses.
    bucket_by_id = {c["id"]: c.get("bucket") for c in category_repo.list_categories()}
    bucket = bucket_by_id.get(cat_id)
    if bucket == SAVINGS_BUCKET:
        return _json_response(400, {"error": "cannot budget a Savings category"})
    if rollover and bucket == INCOME_BUCKET:
        return _json_response(400, {"error": "rollover is only for spend categories"})

    # Turning rollover ON (from off/unset) (re)starts accumulation at the current cycle,
    # keeping any frozen balance but never sealing the cycles that elapsed while it was off.
    # An amount edit that re-sends rollover:true while it's already on carries no anchor, so
    # a not-yet-sealed cycle isn't dropped.
    anchor = None
    if rollover:
        existing = repo.list_budgets().get(cat_id)
        # A category has rollover OR a bill spread, never both — the two would both move the
        # same cycle's spendable and double-count one overspend (WHIT-504). set_spread holds
        # the mirror guard.
        if existing and "spread_amount" in existing:
            return _json_response(400, {"error": "remove this category's bill spread before turning on rollover"})
        if not (existing and existing.get("rollover")):
            cycle = paycycle_repo.get_paycycle()
            cycle_start, _ = current_cycle_window(cycle["last_pay_date"], cycle["length"])
            anchor = {
                "carryover_from": cycle_start,
                "carryover_len": Decimal(cycle["length"]),
                "carryover_paydate": cycle["last_pay_date"],
            }

    saved = repo.set_budget(cat_id, Decimal(str(target)), rollover=rollover, anchor=anchor)
    return _json_response(200, saved)


def delete_budget(event: dict, repo: BudgetRepository) -> dict:
    """DELETE /budgets/{category} — remove a category's budget target.

    Idempotent: an unknown/already-gone id still returns 200 (the repo's
    delete_budget is a no-op when no target exists), mirroring delete_goal /
    delete_enrichment. The category itself is untouched — only its target is
    dropped, so its spend keeps being tracked; the user can set a new target
    later via PUT.
    """
    cat_id = (event.get("pathParameters") or {}).get("category")
    if not cat_id:
        return _json_response(404, {"error": "budget not found"})
    repo.delete_budget(cat_id)
    return _json_response(200, {"id": cat_id})


def set_spread(
    event: dict, repo: BudgetRepository, category_repo: CategoryRepository,
    paycycle_repo: PayCycleRepository,
) -> dict:
    """PUT /budgets/{category}/spread — spread a one-off bill over the coming pay cycles
    (WHIT-504): cover `amount` in the current cycle, take it back in `cycles` equal slices.

    Body: {"amount": <number > 0>, "cycles": <whole number in [SPREAD_MIN_CYCLES,
    SPREAD_MAX_CYCLES]>}. `amount` is stored as a Decimal quantised to cents, so the slices
    (worked out in whole cents) always sum back to exactly the stored amount. Creating a
    spread on a category that already has one replaces it, anchored afresh to the current
    cycle.

    Spend-only, like rollover: an Income earn-target or a Savings category is rejected. The
    category must already carry a budget target (the spread adjusts that target's cycle
    spendable), and must not have rollover on — a category has one or the other, never both
    (set_budget holds the mirror guard). Cheap numeric checks run before any repo read.
    """
    cat_id = (event.get("pathParameters") or {}).get("category")
    if not cat_id:
        return _json_response(404, {"error": "budget not found"})

    body, error = _parse_json_body(event)
    if error:
        return error

    amount = body.get("amount")
    # bool is an int subclass, so reject it explicitly before the numeric check.
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        return _json_response(400, {"error": "amount must be a number"})
    if not math.isfinite(amount):
        return _json_response(400, {"error": "amount must be a finite number"})
    # Cap the raw float first (set_budget's order): quantising a huge value like 1e27 would
    # raise InvalidOperation (past the 28-digit Decimal context) and 500 instead of 400.
    if amount > _BUDGET_TARGET_MAX:
        return _json_response(400, {"error": "amount too large"})
    # Quantise to cents BEFORE the > 0 check — the slices are split in whole cents, so a
    # sub-cent amount (0.004) would otherwise pass and store a $0.00 plan. Half-up is the
    # same rounding the read-side slice math uses, so the two never disagree.
    stored_amount = Decimal(str(amount)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if stored_amount <= 0:
        return _json_response(400, {"error": "amount must be at least 0.01"})

    cycles = body.get("cycles")
    if isinstance(cycles, bool) or not isinstance(cycles, int):
        return _json_response(400, {"error": "cycles must be a whole number"})
    if not SPREAD_MIN_CYCLES <= cycles <= SPREAD_MAX_CYCLES:
        return _json_response(
            400, {"error": f"cycles must be between {SPREAD_MIN_CYCLES} and {SPREAD_MAX_CYCLES}"})

    bucket_by_id = {c["id"]: c.get("bucket") for c in category_repo.list_categories()}
    if bucket_by_id.get(cat_id) in (INCOME_BUCKET, SAVINGS_BUCKET):
        return _json_response(400, {"error": "a bill spread is only for spend categories"})

    existing = repo.list_budgets().get(cat_id)
    if existing is None:
        return _json_response(400, {"error": "set a budget before spreading a bill"})
    if existing.get("rollover"):
        return _json_response(400, {"error": "turn off rollover before spreading a bill"})

    cycle = paycycle_repo.get_paycycle()
    cycle_start, _ = current_cycle_window(cycle["last_pay_date"], cycle["length"])
    saved = repo.set_spread(
        cat_id, stored_amount, cycles, cycle_start, cycle["length"], cycle["last_pay_date"],
    )
    return _json_response(200, saved)


def delete_spread(event: dict, repo: BudgetRepository) -> dict:
    """DELETE /budgets/{category}/spread — remove a category's bill spread, keeping its
    budget target. Idempotent: an id with no spread (or no budget at all) still returns 200,
    as the repo's clear_spread is a no-op then — mirroring delete_budget.
    """
    cat_id = (event.get("pathParameters") or {}).get("category")
    if not cat_id:
        return _json_response(404, {"error": "budget not found"})
    repo.clear_spread(cat_id)
    return _json_response(200, {"id": cat_id})


# --- Goals (WHIT-231) ------------------------------------------------------
# NOTE: distinct from the WHIT-134 home-loan insight-signal helpers above
# (_GOAL_PAYOFF_MODES / _sanitise_goal / _extract_goal) — those narrow an AI-prompt
# signal and are unrelated to the goals store. Kept apart on purpose.
_GOAL_DIRECTIONS = {"grow", "paydown"}
# Absurd for a personal goal; also keeps a giant value from blowing past DynamoDB's
# number limit and 500ing at write instead of a clean 400 (matches set_budget).
_GOAL_AMOUNT_MAX = 1_000_000_000
# A goal's balance source, when synced, must name one of the real synced accounts —
# the client picker only offers the mapped accounts, so a phantom id is a bug caught here.
_SYNCED_ACCOUNT_IDS = frozenset(ACCOUNT_ID_MAP.values())
# A goal's checkpoint ladder (WHIT-476): a few "you're a step closer" markers between the
# start and the target. Deliberately smaller than the mortgage plan's 50 — a goal ladder is
# a handful of steps, not a schedule.
_GOAL_CHECKPOINT_MAX_COUNT = 20
_GOAL_CHECKPOINT_LABEL_MAX_LEN = 100


# The one shared ISO YYYY-MM-DD rule (WHIT-418), now also the milestone READ bar so the two
# can't drift. Kept under the old name so every caller and the e2e tests' handler._valid_iso_date
# reference are unchanged.
_valid_iso_date = valid_iso_date


def _validate_goal_checkpoints(raw, direction: str, target_amount: Decimal):
    """Validate a goal's optional `checkpoints` ladder (WHIT-476).

    Returns (checkpoints, None), or ([], error_response) with a 400. A checkpoint is
    {id, label, amount}: a step the balance passes on the way to target_amount, ordered in
    the goal's OWN direction — a grow ladder climbs (each above the last, under the target),
    a paydown ladder falls (each below the last, above the target).

    `id` is permanent and preserved as sent: the client normally mints it (like the goal's own
    id) and this only mints one for a row that arrives without, exactly like set_milestones. The
    once-ever celebration marker keys on it, so it has to outlive a rename or a reorder.
    """
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return [], _json_response(400, {"error": "checkpoints must be a list"})
    if len(raw) > _GOAL_CHECKPOINT_MAX_COUNT:
        return [], _json_response(
            400, {"error": f"a goal can have at most {_GOAL_CHECKPOINT_MAX_COUNT} checkpoints"})

    grow = direction == "grow"
    cleaned = []
    ids = set()
    for item in raw:
        if not isinstance(item, dict):
            return [], _json_response(400, {"error": "each checkpoint must be an object"})

        label, error = _validate_label(item.get("label"), _GOAL_CHECKPOINT_LABEL_MAX_LEN, "checkpoint")
        if error:
            return [], error

        amount = item.get("amount")
        if not _finite_number(amount, low=0, high=_GOAL_AMOUNT_MAX):
            return [], _json_response(
                400, {"error": f"checkpoint amount must be a number between 0 and {_GOAL_AMOUNT_MAX}"})
        amount = Decimal(str(amount))

        # Strictly INSIDE the goal: a checkpoint at or past the target is the goal itself,
        # not a step toward it. A grow rung of 0 isn't a step toward a positive target either.
        # (A paydown target may be 0, so `> target` covers that end.)
        if grow and not (0 < amount < target_amount):
            return [], _json_response(
                400, {"error": "a savings checkpoint must be above 0 and below the target amount"})
        if not grow and amount <= target_amount:
            return [], _json_response(
                400, {"error": "a paydown checkpoint must be above the target amount"})

        checkpoint_id, error = _validate_id(item.get("id"), ids, "checkpoint")
        if error:
            return [], error

        cleaned.append({"id": checkpoint_id, "label": label, "amount": amount})

    for prev, cur in zip(cleaned, cleaned[1:]):
        if grow and cur["amount"] <= prev["amount"]:
            return [], _json_response(
                400, {"error": "savings checkpoints must be ordered by strictly increasing amount"})
        if not grow and cur["amount"] >= prev["amount"]:
            return [], _json_response(
                400, {"error": "paydown checkpoints must be ordered by strictly decreasing amount"})

    return cleaned, None


def _validate_goal_body(event: dict):
    """Validate a PUT /goals/{id} body into a stored goal dict.

    Returns (goal, None) on success or (None, error_response) with a 400. A goal has:
    name, icon (defaults like a category), direction (grow|paydown), target_amount
    (> 0 to save toward; a paydown may target 0 = pay it off), target_date (real ISO
    date), and EXACTLY ONE balance source — a synced account_id OR a manual pair
    (manual_balance + manual_as_of) — plus an optional baseline ("count from £X") and an
    optional checkpoints ladder (see _validate_goal_checkpoints).
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
            # The figure comes from the cap (WHIT-393) so the message can't outlive a change to it.
            400, {"error": f"target_amount must be a number between 0 and {_GOAL_AMOUNT_MAX}"})
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
        # Manual needs BOTH fields valid. manual_balance is a non-negative magnitude, matching the
        # goal editor (WHIT-483): owed is entered positive, savings positive. A negative would
        # normalise to £0 (goal_checkpoints.normalise_goal_balance) and false-celebrate every rung.
        if not _finite_number(manual_balance, low=0, high=_GOAL_AMOUNT_MAX):
            return None, _json_response(
                400, {"error": f"manual_balance must be a number between 0 and {_GOAL_AMOUNT_MAX}"})
        if not _valid_iso_date(manual_as_of):
            return None, _json_response(400, {"error": "manual_as_of must be a real ISO YYYY-MM-DD date"})
        goal["manual_balance"] = Decimal(str(manual_balance))
        goal["manual_as_of"] = manual_as_of

    baseline = body.get("baseline")
    if baseline is not None:
        if not _finite_number(baseline, high=_GOAL_AMOUNT_MAX):
            return None, _json_response(400, {"error": "baseline must be a number >= 0"})
        goal["baseline"] = Decimal(str(baseline))

    # Optional checkpoint ladder (WHIT-476, option B). The key is set only when the writer
    # actually SENT a list — an omitted (or null) field leaves it off, and the repository then
    # keeps the stored ladder, so a writer that doesn't know about checkpoints can't wipe them.
    # An explicit list replaces; an explicit empty list clears (the repo drops the key).
    raw_checkpoints = body.get("checkpoints")
    checkpoints, error = _validate_goal_checkpoints(
        raw_checkpoints, direction, goal["target_amount"])
    if error:
        return None, error
    if isinstance(raw_checkpoints, list):
        goal["checkpoints"] = checkpoints

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
    account is negative), and as-entered for a manual one (a non-negative magnitude — owed or
    saved, validated >= 0). The status card must normalise the two the same way balanceGoalView
    does, never compare a signed synced start to an as-entered manual current.
    """
    if "manual_balance" in goal:
        return {"start_date": _melbourne_today().isoformat(), "start_balance": goal["manual_balance"]}
    rows = balance_repo.list_balances([goal["account_id"]])
    if rows:
        return {"start_date": _melbourne_today().isoformat(), "start_balance": rows[0]["amount"]}
    return {}


def upsert_goal(event: dict, repo: GoalsRepository, balance_repo: AccountBalanceRepository,
                notify_repo=None, device_repo=None) -> dict:
    """PUT /goals/{id} — create or replace a goal (idempotent upsert). 404 on a
    missing/blank id (an empty map key would 500 at DynamoDB), 400 on a bad body.

    On the FIRST write for an id, an immutable start (date + balance) is stamped; every
    later replace carries the existing start forward (WHIT-252). An omitted `checkpoints`
    keeps the stored ladder, while an explicit list replaces it and `[]` clears it
    (WHIT-476) — both carry-forwards live in repository_goals.

    A MANUAL goal whose new balance crosses a checkpoint fires one celebration push (WHIT-479);
    synced goals cross on the daily poll instead. Best-effort — a push failure never fails the save.
    """
    goal_id = (event.get("pathParameters") or {}).get("id")
    if not goal_id:
        return _json_response(404, {"error": "goal not found"})
    goal, error = _validate_goal_body(event)
    if error:
        return error
    # Only a MANUAL save can cross a checkpoint here (synced goals cross on the daily poll), and
    # only then do we need the old balance — so skip the extra read on synced saves.
    existing = repo.list_goals().get(goal_id) if "manual_balance" in goal else None
    start_candidate = _goal_start_candidate(goal, balance_repo)
    saved = repo.upsert_goal(goal_id, goal, start_candidate)
    _celebrate_manual_goal_crossing(goal_id, existing, saved, notify_repo, device_repo)
    return _json_response(200, saved)


def _celebrate_manual_goal_crossing(goal_id, old_goal, saved_goal, notify_repo, device_repo) -> None:
    """Fire a checkpoint celebration when a MANUAL goal's saved balance crosses a checkpoint
    (WHIT-479). Synced goals are the poller's job, so skip them. Best-effort: a push failure must
    never fail the 200 save. Uses the SAVED goal so a save that omits `checkpoints` still
    celebrates against the carried-forward ladder."""
    if "manual_balance" not in saved_goal:
        return  # synced goal, or no manual source — the poller handles synced crossings
    old_balance = old_goal.get("manual_balance") if old_goal else None
    try:
        notify_goal_checkpoint_crossing(
            old_balance, saved_goal["manual_balance"],
            goal=saved_goal, goal_id=goal_id, synced=False,
            device_repo=device_repo or DeviceRepository(),
            notify_repo=notify_repo or NotifyRepository(),
        )
    except Exception as e:
        logger.warning("goal checkpoint push failed (goal still saved): %s", e)


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
