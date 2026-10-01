"""Mirror the bank's pending list: delete stored pendings BankSync no longer lists (WHIT-662).

The webhook only ever hears about new or changed rows, never drops. So once an hour, per
in-scope account, we fetch BankSync's full transaction list and delete our pendings inside the
check window whose id the bank no longer has. Posted rows and rows outside the window are
never touched. A pending the user edited has its edit moved onto its settled twin, then is
deleted (WHIT-663); failing that, it moves onto the bank's re-issued pending copy, or is just
deleted when that copy already holds the same edit (WHIT-678). Otherwise it's kept for next
hour, with the age-out sweep as the backstop. Any doubt about the bank's reply → that account is skipped and nothing is deleted.
"""

import json
import logging
import urllib.parse
import urllib.request
from datetime import date, timedelta
from typing import Any, Callable, Optional

from constants import (
    ACCOUNT_ID_MAP,
    BANKSYNC_BASE_URL,
    CARRY_DATE_SKEW_DAYS,
    FEED_WINDOW_DAYS,
    PENDING_MIRROR_FETCH_MARGIN_DAYS,
    PENDING_MIRROR_MAX_PAGES,
    PENDING_MIRROR_MAX_REMOVALS,
    PENDING_MIRROR_SOURCES,
    PENDING_MIRROR_TIMEOUT_SECONDS,
    PENDING_STATUS,
    POSTED_STATUS,
)
from pending_carry import find_carry_twin, find_identical_copy, is_user_edited, load_is_unfiled, with_carried_category
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
    return {"checked": checked, "removed": 0, "carried": 0, "kept": 0, "gone": 0, "failed": 0, "skipped": skipped}


def mirror_account(
    repo: Any,
    fetch: Callable[[str, str, str, str], list[dict]],
    source: dict,
    today: date,
    is_unfiled: Callable[[Optional[str]], bool],
) -> dict:
    """Delete this account's stored pendings (dated from today - FEED_WINDOW_DAYS) that the bank
    no longer lists, moving a user's edit onto the settled twin first.
    `fetch(bid, aid, date_from, date_to)` returns the bank's rows."""
    account_id = ACCOUNT_ID_MAP[source["aid"]]
    check_from = today - timedelta(days=FEED_WINDOW_DAYS)
    fetch_from = today - timedelta(days=FEED_WINDOW_DAYS + PENDING_MIRROR_FETCH_MARGIN_DAYS)
    fetch_to = today + timedelta(days=1)
    # Read ours BEFORE the bank's list: a pending stored after this read can't be judged against
    # an older bank list. Capped at fetch_to: a row dated later can never be in the bank's list.
    # Starts CARRY_DATE_SKEW_DAYS early so a settled twin dated before check_from is still found.
    read_from = check_from - timedelta(days=CARRY_DATE_SKEW_DAYS)
    stored = read_date_range_pages(repo, account_id, read_from.isoformat(), fetch_to.isoformat())
    pendings = [
        row for row in stored
        if row.get("status") == PENDING_STATUS and row.get("date", "") >= check_from.isoformat()
    ]
    posted_rows = [row for row in stored if row.get("status") == POSTED_STATUS]

    bank_rows = fetch(source["bid"], source["aid"], fetch_from.isoformat(), fetch_to.isoformat())
    if not bank_rows:
        logger.warning("pending_mirror %s: bank list is empty, skipping", account_id)
        return _result(len(pendings), "empty")

    bank_ids = {str(row["id"]) for row in bank_rows}
    missing = [row for row in pendings if row["transaction_id"] not in bank_ids]
    live_pendings = [
        row for row in stored
        if row.get("status") == PENDING_STATUS and row["transaction_id"] in bank_ids
    ]
    if len(missing) > PENDING_MIRROR_MAX_REMOVALS:
        logger.error(
            "pending_mirror %s: %d pendings missing from the bank list (cap %d), skipping",
            account_id, len(missing), PENDING_MIRROR_MAX_REMOVALS,
        )
        return _result(len(pendings), "too_many_removals")

    result = _result(len(pendings))
    for row in missing:
        if is_user_edited(row, is_unfiled):
            posted_rows, live_pendings = _carry(
                repo, account_id, row, posted_rows, live_pendings, is_unfiled, result,
            )
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


def _carry(
    repo: Any,
    account_id: str,
    pending: dict,
    posted_rows: list[dict],
    live_pendings: list[dict],
    is_unfiled: Callable[[Optional[str]], bool],
    result: dict,
) -> tuple[list[dict], list[dict]]:
    """Move a user-edited pending's edit onto its settled twin — or, with none, onto the bank's
    re-issued pending copy — then delete the pending. No confident twin → delete it only if a live
    copy already holds the same edit, else keep it for next hour. The pending is only deleted
    once the carry is saved. Returns both pools without the claimed twin, so no other pending can
    carry onto it."""
    transaction_id = pending["transaction_id"]
    twin = find_carry_twin(pending, posted_rows, is_unfiled)
    if twin is None:
        twin = find_carry_twin(pending, live_pendings, is_unfiled)
    if twin is None:
        _remove_if_identical_copy(repo, account_id, pending, live_pendings, result)
        return posted_rows, live_pendings
    try:
        saved = _save_carry(repo, twin, pending, is_unfiled)
    except DatabaseError:
        logger.exception("pending_mirror %s: carry failed, keeping txn=%s", account_id, transaction_id)
        result["failed"] += 1
        return posted_rows, live_pendings
    if not saved:
        logger.info(
            "pending_mirror %s: twin gone before carry, keeping txn=%s twin=%s",
            account_id, transaction_id, twin.get("transaction_id"),
        )
        result["gone"] += 1
        return posted_rows, live_pendings
    posted_rows = [row for row in posted_rows if row.get("sk") != twin.get("sk")]
    live_pendings = [row for row in live_pendings if row.get("sk") != twin.get("sk")]
    try:
        deleted = repo.delete_if_still_pending(pending["pk"], pending["sk"])
    except DatabaseError:
        logger.exception("pending_mirror %s: delete after carry failed txn=%s", account_id, transaction_id)
        result["failed"] += 1
        return posted_rows, live_pendings
    if not deleted:
        result["gone"] += 1
        return posted_rows, live_pendings
    logger.info(
        "pending_mirror carried account=%s pending=%s -> %s=%s",
        account_id, transaction_id, twin.get("status"), twin.get("transaction_id"),
    )
    result["carried"] += 1
    return posted_rows, live_pendings


def _save_carry(repo: Any, twin: dict, pending: dict, is_unfiled: Callable[[Optional[str]], bool]) -> bool:
    """Write the pending's edit onto the twin. A pending twin is updated in place, never
    re-inserted, so one the bank dropped mid-run isn't brought back. False → the twin is gone."""
    carried = with_carried_category(twin, pending, is_unfiled=is_unfiled)
    if twin.get("status") == PENDING_STATUS:
        return repo.carry_onto_pending(twin["pk"], twin["sk"], carried)
    repo.insert_transactions([carried])
    return True


def _remove_if_identical_copy(
    repo: Any, account_id: str, pending: dict, live_pendings: list[dict], result: dict,
) -> None:
    transaction_id = pending["transaction_id"]
    identical = find_identical_copy(pending, live_pendings)
    if identical is None:
        logger.info("pending_mirror %s: kept (user-edited, no settled twin yet) txn=%s", account_id, transaction_id)
        result["kept"] += 1
        return
    try:
        deleted = repo.delete_if_still_pending(pending["pk"], pending["sk"])
    except DatabaseError:
        logger.exception("pending_mirror %s: delete failed txn=%s", account_id, transaction_id)
        result["failed"] += 1
        return
    if not deleted:
        result["gone"] += 1
        return
    logger.info(
        "pending_mirror replaced account=%s pending=%s by=%s",
        account_id, transaction_id, identical.get("transaction_id"),
    )
    result["removed"] += 1


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
        is_unfiled = load_is_unfiled(category_repo)
    except Exception:
        logger.exception("pending_mirror: could not read categories, skipping every account")
        return {"removed": 0, "carried": 0, "kept": 0, "skipped": len(PENDING_MIRROR_SOURCES), "accounts": {}}

    def fetch_account(bid: str, aid: str, date_from: str, date_to: str) -> list[dict]:
        return fetch(bid, aid, api_key, date_from, date_to)

    accounts = {}
    for source in PENDING_MIRROR_SOURCES:
        account_id = ACCOUNT_ID_MAP[source["aid"]]
        try:
            accounts[account_id] = mirror_account(repo, fetch_account, source, today, is_unfiled)
        except MirrorSkip as e:
            logger.warning("pending_mirror %s: skipped: %s", account_id, e)
            accounts[account_id] = _result(skipped=str(e))
        except Exception as e:
            logger.exception("pending_mirror %s: failed, skipping", account_id)
            accounts[account_id] = _result(skipped=f"error: {e}")

    summary = {
        "removed": sum(result["removed"] for result in accounts.values()),
        "carried": sum(result["carried"] for result in accounts.values()),
        "kept": sum(result["kept"] for result in accounts.values()),
        "skipped": sum(1 for result in accounts.values() if result["skipped"]),
        "accounts": accounts,
    }
    logger.info(
        "pending_mirror summary: removed=%d carried=%d kept=%d skipped=%d accounts=%s",
        summary["removed"], summary["carried"], summary["kept"], summary["skipped"], accounts,
    )
    return summary
