import boto3
from botocore.exceptions import ClientError
from boto3.dynamodb.conditions import Key
from handler import Transaction
from typing import Any, Optional

REGION_NAME = "ap-southeast-2"
RESOURCE_NAME = "dynamodb"
TABLE_NAME = "whittle-dynamodb-table"


def handle_database_error(e: ClientError, action: str) -> None:
    """Centralized AWS exception handling and telemetry logging."""
    error_code = e.response["Error"]["Code"]
    error_message = e.response["Error"]["Message"]
    print(f"DynamoDB Error [{error_code}]: {error_message}")
    raise RuntimeError(f"Database {action} failed: {error_message}") from e


def sanitise_transaction(txn: Transaction) -> dict[str, Any]:
    """Strips out unassigned None properties to keep DynamoDB documents sparse."""
    return {k: v for k, v in txn.items() if v is not None}


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
        pk = f"ACCOUNT#{txn['account_id']}"
        sk = f"TXN#{txn['date']}#{txn['transaction_id']}"

        # Unpacks and strips fields safely
        item = {"pk": pk, "sk": sk, **sanitise_transaction(txn)}

        try:
            self._get_table().put_item(Item=item)
        except ClientError as e:
            handle_database_error(e, "write")

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
        """Modifies a transaction's status flag using a safe attribute alias placeholder."""
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
        """Merges pending metadata edits into a posted payload, committing atomically."""
        pending_txn = self.get_transaction(pending_pk, pending_sk)
        if not pending_txn:
            raise ValueError(
                f"Cannot reconcile: Pending transaction {pending_pk} / {pending_sk} not found."
            )

        # Clone context to shield upstream code states from side-effect mutations
        posted_txn_copy = posted_txn.copy()

        # Pull historical fields safely via identity checks
        pending_txn_notes = pending_txn.get("notes")
        if pending_txn_notes:
            posted_txn_copy["notes"] = pending_txn_notes

        pending_txn_category = pending_txn.get("category")
        if pending_txn_category:
            posted_txn_copy["category"] = pending_txn_category

        # Pushes directly through the single-entry write gatekeeper
        self.insert_transaction(posted_txn_copy)

        # Clear out the original pending marker only if structural key boundaries shifted
        posted_pk = f"ACCOUNT#{posted_txn_copy['account_id']}"
        posted_sk = f"TXN#{posted_txn_copy['date']}#{posted_txn_copy['transaction_id']}"
        if pending_pk != posted_pk or pending_sk != posted_sk:
            self.delete_transaction(pending_pk, pending_sk)
