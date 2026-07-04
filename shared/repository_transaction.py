"""Transaction storage: the per-account transaction rows plus the failed-record
and idempotency-event helpers used by the sync/webhook pipeline."""

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from constants import MAX_PAGE_SIZE, PENDING_STATUS
from models import Transaction
from repository_base import REGION_NAME, TABLE_NAME, handle_database_error, logger


def sanitise_transaction(txn: Transaction) -> dict[str, Any]:
    """Strips out unassigned None properties to keep DynamoDB documents sparse."""
    return {k: v for k, v in txn.items() if v is not None}


def _build_pk(account_id: str) -> str:
    return f"ACCOUNT#{account_id}"


def _build_sk(transaction_id: str) -> str:
    return f"TXN#{transaction_id}"


class TransactionRepository:
    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        """Lazy-loads and buffers the connection to the physical DynamoDB table resource."""
        if self._table is None:
            self._dynamodb: Any = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def insert_transactions(self, transactions: list[Transaction]) -> None:
        """Inserts multiple transactions efficiently using DynamoDB Batch Write."""
        if not transactions:
            return
        items = []

        for transaction in transactions:
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

    def get_transactions_by_date_range(
        self,
        account_id: str,
        start_date: Optional[str],
        end_date: Optional[str],
        limit: int = 20,
        cursor: Optional[dict[str, Any]] = None,
    ) -> tuple[list[dict[str, Any]], Optional[dict[str, Any]]]:
        if not account_id:
            return [], None

        # GSI keys hold RAW values — no ACCOUNT# / TXN# prefixes
        key_condition = Key("account_id").eq(account_id)

        if start_date and end_date:
            key_condition &= Key("date").between(start_date, end_date)
        elif start_date:
            key_condition &= Key("date").gte(start_date)
        # no dates → whole partition, newest-first

        query_kwargs = {
            "IndexName": "date-index",
            "KeyConditionExpression": key_condition,
            "ScanIndexForward": False,  # newest transaction first
            "Limit": min(limit, MAX_PAGE_SIZE),
        }
        if cursor:
            query_kwargs["ExclusiveStartKey"] = cursor

        try:
            response = self._get_table().query(**query_kwargs)
            return response.get("Items", []), response.get("LastEvaluatedKey")
        except ClientError as e:
            handle_database_error(e, "read")

    def get_pending_transactions_for_account(self, account_id: str) -> list[dict[str, Any]]:
        """Retrieves all pending transaction of an account using the account_id"""
        try:
            response = self._get_table().query(
                KeyConditionExpression=Key("pk").eq(_build_pk(account_id)),
                FilterExpression=Attr("status").eq(PENDING_STATUS),
            )

            return response.get("Items", [])
        except ClientError as e:
            handle_database_error(e, "read")

    def get_transaction_keys_by_id(
        self, transaction_id: str
    ) -> Optional[dict[str, str]]:
        """
        Queries the GSI to find the primary keys (pk and sk) for a given transaction_id.
        Returns a dict with {"pk": "...", "sk": "..."} if found, or None.
        """
        try:
            # Query the GSI instead of a table Scan
            response = self._get_table().query(
                IndexName="transaction-id-index",
                KeyConditionExpression=Key("transaction_id").eq(transaction_id),
            )

            items = response.get("Items", [])

            if not items:
                logger.debug(f"Transaction ID {transaction_id} not found in GSI.")
                return None

            if len(items) > 1:
                logger.warning(
                    f"Multiple records found for transaction_id {transaction_id}, using first match."
                )

            first_match = items[0]
            return {"pk": first_match["pk"], "sk": first_match["sk"]}

        except ClientError as e:
            handle_database_error(e, "index query")

    def update_transaction_category(self, pk: str, sk: str, category: str) -> bool:
        """Sets a transaction's category, leaving all other attributes intact.

        Uses a #c alias because 'category' is a reserved word in DynamoDB. The
        attribute_exists(pk) guard makes the write conditional on the row still
        existing: get_transaction_keys_by_id and this update are not atomic, so a
        row deleted in between yields ConditionalCheckFailedException, which we
        surface as False (a 404 for the caller) rather than a 500.
        """
        try:
            self._get_table().update_item(
                Key={"pk": pk, "sk": sk},
                UpdateExpression="SET #c = :category",
                ExpressionAttributeNames={"#c": "category"},
                ExpressionAttributeValues={":category": category},
                ConditionExpression="attribute_exists(pk)",
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            handle_database_error(e, "write")

    def update_transaction_categories(
        self, updates: list[dict[str, str]]
    ) -> list[dict[str, str]]:
        """Set the category on many transactions, best-effort (WHIT-70).

        Each update is {"id", "category"}. Applied INDEPENDENTLY: resolve the row's
        keys via the GSI, then conditionally update, so one unknown or vanished id
        yields a per-item "not_found" rather than failing the whole batch. Returns
        [{"id", "status"}] in input order, status ∈ {"updated", "not_found"}. A
        partial UpdateItem loop (not batch_writer, which is put-only and would
        overwrite the whole row; not transact_write_items, whose all-or-nothing
        would let one stale id sink the entire sweep).
        """
        results: list[dict[str, str]] = []
        for item in updates:
            transaction_id = item["id"]
            keys = self.get_transaction_keys_by_id(transaction_id)
            if keys is None:
                results.append({"id": transaction_id, "status": "not_found"})
                continue
            updated = self.update_transaction_category(
                keys["pk"], keys["sk"], item["category"]
            )
            results.append(
                {"id": transaction_id, "status": "updated" if updated else "not_found"}
            )
        return results
