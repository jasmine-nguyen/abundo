import boto3
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Attr, Key
from typing import Any, NoReturn, Optional
from models import Transaction
from constants import PENDING_STATUS

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


def _build_sk(date: Optional[str], transaction_id: Optional[str]) -> str:
    if date is None:
        return f"TXN#{transaction_id}"
    if transaction_id is None:
        return f"TXN#{date}"
    return f"TXN#{date}#{transaction_id}"


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

    def insert_transaction(self, txn: Transaction) -> None:
        """Inserts a new record or completely overwrites an existing item."""
        self.insert_transactions([txn])

    def insert_transactions(self, transactions: list[Transaction]) -> None:
        """Inserts multiple transactions efficiently using DynamoDB Batch Write."""

        if not transactions:
            return

        try:
            table = self._get_table()
            with table.batch_writer() as batch:
                for txn in transactions:
                    # Ensure each transaction has the correct DynamoDB schema keys
                    item = {
                        "pk": _build_pk(txn["account_id"]),
                        "sk": _build_sk(txn["date"], txn["transaction_id"]),
                        **sanitise_transaction(txn),
                    }
                    # Put item into the batch buffer
                    batch.put_item(Item=item)
        except ClientError as e:
            handle_database_error(e, "batch_write")

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
                & Key("sk").between(
                    _build_sk(start_date, None), f"{_build_sk(end_date, None)}~"
                ),
                ScanIndexForward=False,
            )

            return response.get("Items", [])
        except ClientError as e:
            handle_database_error(e, "read")

    def get_pending_transactions_for_account(self, account_id: str) -> list[dict]:
        """Retrieves all pending transaction of an account using the account_id"""
        try:
            response = self._get_table().query(
                KeyConditionExpression=Key("pk").eq(_build_pk(account_id)),
                FilterExpression=Attr("status").eq(PENDING_STATUS),
            )

            return response.get("Items", [])
        except ClientError as e:
            handle_database_error(e, "read")

    def get_latest_updated_at(self, account_id: str) -> Optional[str]:
        """Retrieves most recent transaction for a given account, sorted descending by SK, limit 1 and then returns its `updated_at`"""
        try:
            response = self._get_table().query(
                # KeyConditionExpression isolates just the Partition Key (pk)
                KeyConditionExpression=Key("pk").eq(_build_pk(account_id)),
                # Sort descending (newest first)
                ScanIndexForward=False,
                Limit=1,
            )

            items = response.get("Items", [])
            if items:
                return items[0]["updated_at"]

            return None
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
            # 1. Run a Query operation against the GSI instead of a table Scan
            response = self._get_table().query(
                IndexName="transaction-id-index",
                KeyConditionExpression=Key("transaction_id").eq(transaction_id),
            )

            items = response.get("Items", [])

            # 2. Check if the index query returned any matching records
            if not items:
                print(f"Transaction ID {transaction_id} not found in GSI.")
                return None

            if len(items) > 1:
                print(
                    f"Warning: multiple records found for transaction_id {transaction_id}, using first match."
                )
            # 3. Extract and return the primary keys of the first match
            first_match = items[0]
            return {"pk": first_match["pk"], "sk": first_match["sk"]}

        except ClientError as e:
            handle_database_error(e, "index query")

    def update_transaction_status(self, pk: str, sk: str, new_status: str) -> None:
        """Updates a transaction's status. Uses a #s alias because 'status' is a reserved word in DynamoDB."""
        try:
            self._get_table().update_item(
                Key={"pk": pk, "sk": sk},
                UpdateExpression="SET #s = :new_status",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":new_status": new_status},
            )
        except ClientError as e:
            handle_database_error(e, "write")

    def delete_transaction(self, pk: str, sk: str) -> None:
        """Deletes a record. Asserts that the key must physically exist prior to removal."""
        try:
            self._get_table().delete_item(
                Key={"pk": pk, "sk": sk},
                ConditionExpression="attribute_exists(pk)",
            )
        except ClientError as e:
            handle_database_error(e, "delete")

    def reconcile_and_replace(
        self, pending_pk: str, pending_sk: str, posted_txn: Transaction
    ) -> None:
        """Inserts the posted transaction, carrying over any user edits (notes, category) from the pending row, then deletes the old pending row if its key differs."""
        pending_txn = self.get_transaction(pending_pk, pending_sk)
        if not pending_txn:
            raise ValueError(
                f"Cannot reconcile: Pending transaction {pending_pk} / {pending_sk} not found."
            )

        # Copy so we don't mutate the caller's transaction
        posted_txn_copy = posted_txn.copy()

        # Carry over user edits from the pending row if present
        pending_txn_notes = pending_txn.get("notes")
        if pending_txn_notes:
            posted_txn_copy["notes"] = pending_txn_notes

        pending_txn_category = pending_txn.get("category")
        if pending_txn_category:
            posted_txn_copy["category"] = pending_txn_category

        # Write the merged posted transaction
        self.insert_transaction(posted_txn_copy)

        # Delete the old pending row only if it has a different key
        posted_pk = _build_pk(posted_txn_copy["account_id"])
        posted_sk = _build_sk(
            posted_txn_copy["date"], posted_txn_copy["transaction_id"]
        )
        if pending_pk != posted_pk or pending_sk != posted_sk:
            self.delete_transaction(pending_pk, pending_sk)
