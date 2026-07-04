import boto3
from datetime import datetime, timezone
from decimal import Decimal
import json
import re
import uuid
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Attr, Key
from typing import Any, NoReturn, Optional
from models import Transaction
from constants import PENDING_STATUS, TIP_HEADROOM

REGION_NAME = "ap-southeast-2"
RESOURCE_NAME = "dynamodb"
TABLE_NAME = "whittle-dynamodb-table"


def handle_database_error(e: ClientError, action: str) -> NoReturn:
    """Logs an AWS client error and re-raises it as a RuntimeError."""
    error_code = e.response["Error"]["Code"]
    error_message = e.response["Error"]["Message"]
    print(f"DynamoDB Error [{error_code}]: {error_message}")
    raise RuntimeError(f"Database {action} failed: {error_message}") from e


def sanitise_transaction(txn: Transaction) -> dict[str, Any]:
    """Strips out unassigned None properties to keep DynamoDB documents sparse."""
    return {k: v for k, v in txn.items() if v is not None}


def _build_pk(account_id: str) -> str:
    return f"ACCOUNT#{account_id}"


def _build_sk(transaction_id: Optional[str]) -> str:
    return f"TXN#{transaction_id}"


_WORD = re.compile(r"[a-z0-9]+")


def _words(s: Optional[str]) -> list[str]:
    """Lowercase alphanumeric words of a string. BankSync descriptor noise
    ('POS AUTHORISATION', 'DD *', country/store codes) splits out on the
    non-alphanumeric boundaries, leaving comparable merchant words."""
    return _WORD.findall((s or "").lower())


def _merchant_in_description(merchant: str, description: str) -> bool:
    """Whether every word of `merchant` appears as a CONSECUTIVE run inside
    `description`'s words. Word-level (not raw substring) so a short or adjacent
    token can't over-match: 'coles' is NOT a word in "nicole's cafe", 'bp' is NOT a
    word in 'bpay' — while a multi-word merchant ('DOORDASH XUANBANHC') still matches
    a pending's raw "POS AUTHORISATION  DD *DOORDASH XUANBANHC ..." description.
    Empty merchant -> False (never over-match on an underivable token)."""
    m = _words(merchant)
    if not m:
        return False
    d = _words(description)
    return any(d[i:i + len(m)] == m for i in range(len(d) - len(m) + 1))


def _is_tip_adjusted(auth_amount: Decimal, settled_amount: Decimal) -> bool:
    """Whether `settled_amount` is `auth_amount` plus at most a tip (TIP_HEADROOM).
    Both must be spend (negative) and ONE-DIRECTIONAL — a tip only makes the
    magnitude larger — so a smaller settled amount, or an opposite-sign one (a
    refund/credit), is never a tip-match."""
    if auth_amount >= 0 or settled_amount >= 0:
        return False
    auth_mag = -auth_amount
    settled_mag = -settled_amount
    return auth_mag <= settled_mag <= auth_mag * (Decimal(1) + TIP_HEADROOM)


class TransactionRepository:
    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self):
        """Lazy-loads and buffers the connection to the physical DynamoDB table resource."""
        if self._table is None:
            self._dynamodb: Any = boto3.resource(RESOURCE_NAME, region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def insert_transactions(self, transactions: list[Transaction]) -> None:
        """Inserts multiple transactions efficiently using DynamoDB Batch Write."""

        if not transactions:
            return
        items = []

        for transaction in transactions:
            # Ensure each transaction has the correct DynamoDB schema keys
            item = {
                "pk": _build_pk(transaction["account_id"]),
                "sk": _build_sk(transaction["transaction_id"]),
                **sanitise_transaction(transaction),
            }
            items.append(item)

        self._batch_put(items, "batch_write")

    def save_failed_transactions(self, failed_transactions: list[dict]) -> None:
        """Inserts failed transactions using DynamoDB Batch Write."""

        if not failed_transactions:
            return

        items = []
        for transaction in failed_transactions:
            item = {
                "pk": "FAILED",
                # A uuid disambiguates two failures written in the same microsecond,
                # whose isoformat timestamps would otherwise collide and overwrite
                # each other (WHIT-84) — matches shared/repository_transaction.py.
                "sk": f"{datetime.now(timezone.utc).isoformat()}#{uuid.uuid4()}",
                "raw": json.dumps(transaction),
            }
            items.append(item)
        self._batch_put(items, "save_failed_transactions")

    def _batch_put(self, items: list[dict], action: str) -> None:
        if not items:
            return
        try:
            table = self._get_table()
            with table.batch_writer() as batch:
                for item in items:
                    batch.put_item(Item=item)
        except ClientError as e:
            handle_database_error(e, action)

    def get_transaction(self, pk: str, sk: str) -> Optional[dict[str, Any]]:
        """Retrieves a single record document. Returns None if it is missing."""
        try:
            response = self._get_table().get_item(Key={"pk": pk, "sk": sk})
            item = response.get("Item")
            if not item:
                print(f"Transaction not found for PK: {pk}, SK: {sk}")
                return None
            return item
        except ClientError as e:
            handle_database_error(e, "read")

    def get_recent_transactions(
        self, account_id: str, start_date: str, end_date: str
    ) -> list[dict]:
        if not account_id or not start_date or not end_date:
            return []

        try:
            response = self._get_table().query(
                KeyConditionExpression=Key("pk").eq(_build_pk(account_id))
                & Key("sk").between(_build_sk(None), f"{_build_sk(None)}~"),
                ScanIndexForward=False,
            )

            return response.get("Items", [])
        except ClientError as e:
            handle_database_error(e, "read")

    def get_pending_transactions_for_account(self, account_id: str) -> list[dict]:
        """Retrieves all pending transactions of an account using the account_id.

        Follows pagination (WHIT-82): DynamoDB caps a query at 1MB per page and the
        ``status == pending`` FilterExpression is applied AFTER that scan, per page.
        Reading only the first page would leave a pending row that sits beyond it
        invisible to reconciliation — a silent duplicate + lost category, no error.
        So we loop on LastEvaluatedKey and accumulate across every page.
        """
        try:
            table = self._get_table()
            key_condition = Key("pk").eq(_build_pk(account_id))
            items: list[dict] = []
            start_key = None
            while True:
                kwargs = {
                    "KeyConditionExpression": key_condition,
                    "FilterExpression": Attr("status").eq(PENDING_STATUS),
                }
                if start_key is not None:
                    kwargs["ExclusiveStartKey"] = start_key
                response = table.query(**kwargs)
                items.extend(response.get("Items", []))
                start_key = response.get("LastEvaluatedKey")
                if not start_key:
                    break
            return items
        except ClientError as e:
            handle_database_error(e, "read")

    def get_failed_transactions(self) -> list[dict]:
        """Retrieve all dead-lettered rows — the ``pk="FAILED"`` partition written by
        save_failed_transactions. Paginated (WHIT-82 pattern) so a large backlog isn't
        truncated at DynamoDB's 1MB page. Read-only; the reprocess sweep (WHIT-55)
        drives it."""
        try:
            table = self._get_table()
            key_condition = Key("pk").eq("FAILED")
            items: list[dict] = []
            start_key = None
            while True:
                kwargs = {"KeyConditionExpression": key_condition}
                if start_key is not None:
                    kwargs["ExclusiveStartKey"] = start_key
                response = table.query(**kwargs)
                items.extend(response.get("Items", []))
                start_key = response.get("LastEvaluatedKey")
                if not start_key:
                    break
            return items
        except ClientError as e:
            handle_database_error(e, "read")

    def delete_failed_transaction(self, sk: str) -> None:
        """Delete a dead-letter row after it has been successfully reprocessed
        (WHIT-55). No attribute_exists guard, so a re-run deleting an already-gone row
        is a harmless no-op (mirrors _delete_pending_if_present)."""
        try:
            self._get_table().delete_item(Key={"pk": "FAILED", "sk": sk})
        except ClientError as e:
            handle_database_error(e, "delete failed")

    def insert_or_reconcile(self, transactions: list[Transaction]) -> None:
        """Insert transactions, reconciling pending->posted so a user's category
        survives settlement.

        On settlement BankSync issues a NEW id for the posted transaction with no
        link back to the pending one (`pendingTransactionId` is null today), so a
        blind insert would leave two rows — a categorized pending + an uncategorized
        posted. Instead, for each POSTED transaction we find its pending twin, carry
        the pending row's `category` onto the posted row, and delete the stale
        pending. Match order (see _find_pending_twin): exact `pending_transaction_id`
        link (forward-compat), else same authorized_date + EXACT amount, else a
        tip-adjusted match (same day + merchant + amount within TIP_HEADROOM above the
        auth), else a same-id re-sync of an already-stored posted row. No match ->
        a plain insert. A missing/racey match never raises: it degrades to insert.

        Pending rows are inserted as-is. All inserts are batched at the end; stale
        pendings are deleted after.
        """
        if not transactions:
            return

        pending_pools: dict[str, list[dict]] = {}   # account_id -> loaded pending rows
        to_insert: list[Transaction] = []
        stale_pending_keys: list[tuple[str, str]] = []

        for txn in transactions:
            if txn.get("status") == PENDING_STATUS:
                # Pending rows just insert. NOTE: a posted twin arriving in this SAME
                # payload won't see this pending (the pool is the DB scan), so both
                # would insert -> a duplicate. Real settlements arrive in separate
                # webhooks; a backfill payload containing both is an accepted edge,
                # cleaned by the age-out follow-up.
                to_insert.append(txn)
                continue

            match = self._find_pending_twin(txn, pending_pools)
            if match is not None:
                to_insert.append(self._with_carried_category(txn, match))
                match_key = (match["pk"], match["sk"])
                own_key = (_build_pk(txn["account_id"]), _build_sk(txn["transaction_id"]))
                if match_key != own_key:
                    stale_pending_keys.append(match_key)
                continue

            # No pending twin, but a posted row may already exist under this same id
            # (a re-sync). Preserve any user category on it (read-then-carry).
            own_pk = _build_pk(txn["account_id"])
            own_sk = _build_sk(txn["transaction_id"])
            existing = self.get_transaction(own_pk, own_sk)
            if existing is not None:
                to_insert.append(self._with_carried_category(txn, existing))
            else:
                to_insert.append(txn)

        self.insert_transactions(to_insert)
        for pk, sk in stale_pending_keys:
            self._delete_pending_if_present(pk, sk)

    def _find_pending_twin(
        self, posted_txn: Transaction, pending_pools: dict[str, list[dict]]
    ) -> Optional[dict]:
        """Return AND consume the stored pending row that settled into `posted_txn`,
        or None. Only ever returns a row taken from the account's pending scan, so
        the caller never gets an unverified key. Consumed rows are removed from the
        pool so one pending can't be claimed by two posted rows in the same batch.
        """
        account_id = posted_txn["account_id"]
        pool = pending_pools.get(account_id)
        if pool is None:
            pool = list(self.get_pending_transactions_for_account(account_id))
            pending_pools[account_id] = pool

        # 1. Exact link (forward-compat; pending_transaction_id is null today). The
        #    pool IS the full account pending scan, so a link not in it means the
        #    pending is already gone -> fall through to the heuristic, never a
        #    fabricated key.
        link_id = posted_txn.get("pending_transaction_id")
        if link_id:
            for i, item in enumerate(pool):
                if item.get("transaction_id") == link_id:
                    return pool.pop(i)

        # 2. Heuristic: same authorized_date + EXACT amount (account already scoped by
        #    the pool). Skip when authorized_date is missing — matching on amount alone
        #    is too loose. authorized_date is preserved across settlement, so it
        #    discriminates identical daily purchases.
        authorized_date = posted_txn.get("authorized_date")
        if not authorized_date:
            return None
        amount = posted_txn.get("amount")
        exact = [
            i for i, item in enumerate(pool)
            if item.get("authorized_date") == authorized_date and item.get("amount") == amount
        ]
        if exact:
            # Two identical same-day charges are indistinguishable; pick deterministically
            # (lowest transaction_id) so behaviour is stable and testable.
            best = min(exact, key=lambda i: pool[i].get("transaction_id", ""))
            return pool.pop(best)

        # 3. Tip-adjusted settlement (WHIT-116): a tip added at settlement changes the
        #    amount, so tier 2's exact match misses. Match same authorized_date + the
        #    posted merchant appearing (word-for-word) in the pending's raw description
        #    — pending rows carry no clean merchant_name, only the description — + a
        #    settled amount within TIP_HEADROOM above the auth. The merchant gate plus
        #    the one-directional amount headroom keep a coincidental same-day charge
        #    (or a refund) from being swept in. tier 2 already claimed any exact-amount
        #    twin, so this only sees strictly-larger-amount leftovers.
        if amount is None:
            return None
        # A tip-adjusted match DELETES a pending, so require a merchant strong enough to
        # trust: at least TWO words. A lone common word (a bare location like "MELBOURNE",
        # or a generic token like "EXPRESS") is a whole word in many unrelated same-day
        # descriptions and would wrongly consume a different merchant's pending. Single-
        # word merchants simply don't tip-reconcile — they fall back to the exact-amount
        # tier (today's behaviour: a leftover duplicate, never a wrong merge).
        merchant = posted_txn.get("merchant_name") or ""
        if len(_words(merchant)) < 2:
            return None
        tip = [
            i for i, item in enumerate(pool)
            if item.get("authorized_date") == authorized_date
            and item.get("amount") is not None
            and _is_tip_adjusted(item["amount"], amount)
            and _merchant_in_description(merchant, item.get("description") or "")
        ]
        if not tip:
            return None
        best = min(tip, key=lambda i: pool[i].get("transaction_id", ""))
        return pool.pop(best)

    @staticmethod
    def _with_carried_category(posted_txn: Transaction, source_row: dict) -> Transaction:
        """A copy of the posted txn with `category` carried from `source_row` (the
        matched pending / existing posted) when that row has one. Falsy/absent ->
        keep the posted txn's own (bank) category."""
        carried = posted_txn.copy()
        source_category = source_row.get("category")
        if source_category:
            carried["category"] = source_category
        return carried

    def _delete_pending_if_present(self, pk: str, sk: str) -> None:
        """Delete a stale pending row. No attribute_exists guard, so deleting an
        already-gone row is a harmless no-op (avoids a race raising a 500)."""
        try:
            self._get_table().delete_item(Key={"pk": pk, "sk": sk})
        except ClientError as e:
            handle_database_error(e, "delete pending")

    def has_event(self, envelope_id: str) -> bool:
        """Whether this event was already fully processed (its marker exists).

        The marker is written by mark_event only AFTER a delivery succeeds, so a
        failed delivery leaves no marker and BankSync's retry re-processes it — a
        failed write can never drop the transaction (WHIT-83, save-then-mark).
        """
        try:
            result = self._get_table().get_item(
                Key={"pk": f"EVENT#{envelope_id}", "sk": "EVENT"}
            )
            return "Item" in result
        except ClientError as e:
            handle_database_error(e, "has_event")

    def mark_event(self, envelope_id: str) -> None:
        """Record that an event has been fully processed. Called only after the
        write succeeds; a plain, idempotent put — re-marking is harmless."""
        try:
            self._get_table().put_item(
                Item={"pk": f"EVENT#{envelope_id}", "sk": "EVENT"}
            )
        except ClientError as e:
            handle_database_error(e, "mark_event")
