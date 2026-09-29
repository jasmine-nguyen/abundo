"""Mirror the bank's pending list: delete stored pendings BankSync no longer lists (WHIT-662).

The webhook only ever hears about new or changed rows, never drops. So once an hour, per
in-scope account, we fetch BankSync's full transaction list and delete our pendings inside the
check window whose id the bank no longer has. Posted rows and rows outside the window are
never touched. A pending the user edited is kept (left to the age-out sweep). Any doubt about
the bank's reply → that account is skipped and nothing is deleted.
"""

import json
import logging
import urllib.parse
import urllib.request
from datetime import date, timedelta
from typing import Any, Callable, Optional

import rule_engine
from constants import (
    ACCOUNT_ID_MAP,
    BANKSYNC_BASE_URL,
    FEED_WINDOW_DAYS,
    PENDING_MIRROR_FETCH_MARGIN_DAYS,
    PENDING_MIRROR_MAX_PAGES,
    PENDING_MIRROR_MAX_REMOVALS,
    PENDING_MIRROR_SOURCES,
    PENDING_MIRROR_TIMEOUT_SECONDS,
    PENDING_STATUS,
)
from repository_category import CategoryRepository
from repository_errors import DatabaseError
from repository_transaction import TransactionRepository, read_date_range_pages
from spend import melbourne_today

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


class MirrorSkip(Exception):
    """The bank's reply can't be trusted as the full list, so the account is skipped."""


def _get_page(url: str, api_key: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "X-API-Key": api_key,
            # Cloudflare blocks the default "Python-urllib" User-Agent (see handler.trigger_sync).
            "User-Agent": "abundo-transaction-trigger",
        },
    )
    with urllib.request.urlopen(req, timeout=PENDING_MIRROR_TIMEOUT_SECONDS) as resp:
        return json.loads(resp.read())


def fetch_bank_transactions(bid: str, aid: str, api_key: str, date_from: str, date_to: str) -> list[dict]:
    """Every row BankSync lists for the account between `date_from` and `date_to` (booking date),
    following `cursor` until `hasMore` is false. Raises MirrorSkip on any sign of a partial list;
    HTTP errors propagate."""
    base_url = f"{BANKSYNC_BASE_URL}/v1/banks/{bid}/accounts/{aid}/transactions"
    params = {"from": date_from, "to": date_to}
    rows: list[dict] = []
    for _ in range(PENDING_MIRROR_MAX_PAGES):
        body = _get_page(f"{base_url}?{urllib.parse.urlencode(params)}", api_key)
        if body.get("success") is not True:
            raise MirrorSkip("success is not true")
        data = body.get("data")
        if not isinstance(data, list):
            raise MirrorSkip("data is not a list")
        for row in data:
            if "id" not in row or "pending" not in row:
                raise MirrorSkip("a row lacks id or pending")
            if row.get("accountId", aid) != aid:
                raise MirrorSkip("a row belongs to another account")
        rows.extend(data)
        meta = body.get("meta") or {}
        if not meta.get("hasMore"):
            return rows
        if not meta.get("cursor"):
            raise MirrorSkip("hasMore with no cursor")
        params = {"from": date_from, "to": date_to, "cursor": meta["cursor"]}
    raise MirrorSkip(f"more than {PENDING_MIRROR_MAX_PAGES} pages")


def _result(checked: int = 0, skipped: Optional[str] = None) -> dict:
    return {"checked": checked, "removed": 0, "kept": 0, "gone": 0, "failed": 0, "skipped": skipped}


def mirror_account(
    repo: Any,
    fetch: Callable[[str, str, str, str], list[dict]],
    source: dict,
    today: date,
    is_user_filed: Callable[[dict], bool],
) -> dict:
    """Delete this account's stored pendings (dated from today - FEED_WINDOW_DAYS) that the bank
    no longer lists. `fetch(bid, aid, date_from, date_to)` returns the bank's rows."""
    account_id = ACCOUNT_ID_MAP[source["aid"]]
    check_from = today - timedelta(days=FEED_WINDOW_DAYS)
    # Read ours BEFORE the bank's list: a pending stored after this read can't be judged against
    # an older bank list.
    stored = read_date_range_pages(repo, account_id, check_from.isoformat(), None)
    pendings = [row for row in stored if row.get("status") == PENDING_STATUS]

    fetch_from = today - timedelta(days=FEED_WINDOW_DAYS + PENDING_MIRROR_FETCH_MARGIN_DAYS)
    fetch_to = today + timedelta(days=1)
    bank_rows = fetch(source["bid"], source["aid"], fetch_from.isoformat(), fetch_to.isoformat())
    if not bank_rows:
        logger.warning("pending_mirror %s: bank list is empty, skipping", account_id)
        return _result(len(pendings), "empty")

    bank_ids = {str(row["id"]) for row in bank_rows}
    missing = [row for row in pendings if row["transaction_id"] not in bank_ids]
    if len(missing) > PENDING_MIRROR_MAX_REMOVALS:
        logger.error(
            "pending_mirror %s: %d pendings missing from the bank list (cap %d), skipping",
            account_id, len(missing), PENDING_MIRROR_MAX_REMOVALS,
        )
        return _result(len(pendings), "too_many_removals")

    result = _result(len(pendings))
    for row in missing:
        if is_user_filed(row):
            logger.info("pending_mirror %s: kept (user-edited) txn=%s", account_id, row["transaction_id"])
            result["kept"] += 1
            continue
        try:
            deleted = repo.delete_if_still_pending(row["pk"], row["sk"])
        except DatabaseError:
            logger.exception("pending_mirror %s: delete failed txn=%s", account_id, row["transaction_id"])
            result["failed"] += 1
            continue
        if not deleted:
            result["gone"] += 1
            continue
        logger.info(
            "pending_mirror removed account=%s txn=%s date=%s amount=%s description=%s",
            account_id, row["transaction_id"], row.get("date"), row.get("amount"), row.get("description"),
        )
        result["removed"] += 1
    return result


def _load_is_user_filed(category_repo: Any) -> Callable[[dict], bool]:
    """A pending the user edited: a real category not set by a rule, or a note/tag/exclusion
    (the age-out rescue's definitions, WHIT-511/553). Rule-filed pendings aren't protected: the
    posted twin gets the rule on ingest."""
    taxonomy_ids = {category["id"] for category in category_repo.list_categories()}

    def is_user_filed(row: dict) -> bool:
        category = row.get("category")
        if not rule_engine.is_unfiled_category(category, taxonomy_ids) and not row.get("filed_by_rule"):
            return True
        return bool(row.get("notes") or row.get("tags") or row.get("budget_excluded"))

    return is_user_filed


def mirror_pendings(
    api_key: str,
    repo: Any = None,
    category_repo: Any = None,
    today: Optional[date] = None,
    fetch: Callable[..., list[dict]] = fetch_bank_transactions,
) -> dict:
    """Mirror every in-scope account. One account failing never stops the others."""
    repo = repo or TransactionRepository()
    category_repo = category_repo or CategoryRepository()
    today = today or melbourne_today()
    try:
        is_user_filed = _load_is_user_filed(category_repo)
    except Exception:
        logger.exception("pending_mirror: could not read categories, skipping every account")
        return {"removed": 0, "kept": 0, "skipped": len(PENDING_MIRROR_SOURCES), "accounts": {}}

    def fetch_account(bid: str, aid: str, date_from: str, date_to: str) -> list[dict]:
        return fetch(bid, aid, api_key, date_from, date_to)

    accounts = {}
    for source in PENDING_MIRROR_SOURCES:
        account_id = ACCOUNT_ID_MAP[source["aid"]]
        try:
            accounts[account_id] = mirror_account(repo, fetch_account, source, today, is_user_filed)
        except MirrorSkip as e:
            logger.warning("pending_mirror %s: skipped: %s", account_id, e)
            accounts[account_id] = _result(skipped=str(e))
        except Exception as e:
            logger.exception("pending_mirror %s: failed, skipping", account_id)
            accounts[account_id] = _result(skipped=f"error: {e}")

    summary = {
        "removed": sum(result["removed"] for result in accounts.values()),
        "kept": sum(result["kept"] for result in accounts.values()),
        "skipped": sum(1 for result in accounts.values() if result["skipped"]),
        "accounts": accounts,
    }
    logger.info(
        "pending_mirror summary: removed=%d kept=%d skipped=%d accounts=%s",
        summary["removed"], summary["kept"], summary["skipped"], accounts,
    )
    return summary
