import json
import logging
import os
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, NoReturn, Optional

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from constants import MAX_PAGE_SIZE, PENDING_STATUS
from models import Transaction

REGION_NAME = os.environ["AWS_REGION"]
TABLE_NAME = os.environ["TABLE_NAME"]

logger = logging.getLogger(__name__)


def handle_database_error(e: ClientError, action: str) -> NoReturn:
    """Logs an AWS client error and re-raises it as a RuntimeError."""
    error_code = e.response["Error"]["Code"]
    error_message = e.response["Error"]["Message"]
    logger.error(f"DynamoDB Error [{error_code}]: {error_message}")
    raise RuntimeError(f"Database {action} failed: {error_message}") from e


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

    def insert_transaction(self, txn: Transaction) -> None:
        """Inserts a new record or completely overwrites an existing item."""
        self.insert_transactions([txn])

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

    def get_transaction(self, pk: str, sk: str) -> Optional[dict[str, Any]]:
        """Retrieves a single record document. Returns None if it is missing."""
        try:
            response = self._get_table().get_item(Key={"pk": pk, "sk": sk})
            item = response.get("Item")
            if not item:
                logger.debug(f"Transaction not found for PK: {pk}, SK: {sk}")
                return None
            return item
        except ClientError as e:
            handle_database_error(e, "read")

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

    def get_latest_updated_at(self, account_id: str) -> Optional[str]:
        """Retrieves most recent transaction for a given account, sorted descending by SK, limit 1 and then returns its `updated_at`"""
        try:
            response = self._get_table().query(
                KeyConditionExpression=Key("pk").eq(_build_pk(account_id)),
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
        """Inserts the posted transaction, carrying over the user's category from the pending row, then deletes the old pending row if its key differs."""
        pending_txn = self.get_transaction(pending_pk, pending_sk)
        if not pending_txn:
            raise ValueError(
                f"Cannot reconcile: Pending transaction {pending_pk} / {pending_sk} not found."
            )

        posted_txn_copy = posted_txn.copy()

        # Carry over user edits from the pending row if present
        pending_txn_category = pending_txn.get("category")
        if pending_txn_category:
            posted_txn_copy["category"] = pending_txn_category

        self.insert_transaction(posted_txn_copy)

        posted_pk = _build_pk(posted_txn_copy["account_id"])
        posted_sk = _build_sk(posted_txn_copy["transaction_id"])
        if pending_pk != posted_pk or pending_sk != posted_sk:
            self.delete_transaction(pending_pk, pending_sk)

    def is_new_event(self, envelope_id: str) -> bool:
        try:
            self._get_table().put_item(
                Item={"pk": f"EVENT#{envelope_id}", "sk": "EVENT"},
                ConditionExpression="attribute_not_exists(pk)",
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False

            handle_database_error(e, "is_new_event")


# Category taxonomy data lives here, not in constants.py, on purpose: this module
# ships in the Lambda layer, and a `from constants import ...` here binds to the
# FUNCTION's constants.py — coupling the layer to another package's symbols. A
# deploy skew there fails this import at module load and 500s EVERY route
# (including /transactions). The palette + seed are used only by CategoryRepository,
# so keeping them local makes the layer self-contained. Ids are the curated slugs
# from src/context.tsx SEED_CATS (the vocabulary BankSync rules + client
# budgets/rules reference); `recent` is omitted (client-derived).
CATEGORY_PALETTE = [
    "#E8A87C", "#7FD49B", "#F08C8C", "#8AB4F8", "#F2A0C9",
    "#C7A8F0", "#F2C94C", "#6FD0C9", "#8FD46B", "#B0A8F0",
]

SEED_CATEGORIES = {
    "coffee": {"id": "coffee", "name": "Cafes & Coffee", "icon": "coffee", "color": "#E8A87C", "bucket": "Lifestyle"},
    "groceries": {"id": "groceries", "name": "Groceries", "icon": "cart", "color": "#7FD49B", "bucket": "Living"},
    "eatingout": {"id": "eatingout", "name": "Eating Out", "icon": "food", "color": "#F08C8C", "bucket": "Lifestyle"},
    "transport": {"id": "transport", "name": "Transport", "icon": "car", "color": "#8AB4F8", "bucket": "Living"},
    "health": {"id": "health", "name": "Health", "icon": "health", "color": "#F2A0C9", "bucket": "Living"},
    "pets": {"id": "pets", "name": "Pets", "icon": "pets", "color": "#C7A8F0", "bucket": "Lifestyle"},
    "utilities": {"id": "utilities", "name": "Utilities", "icon": "bolt", "color": "#F2C94C", "bucket": "Living"},
    "shopping": {"id": "shopping", "name": "Shopping", "icon": "bag", "color": "#6FD0C9", "bucket": "Lifestyle"},
    "fitness": {"id": "fitness", "name": "Health & Fitness", "icon": "dumbbell", "color": "#8FD46B", "bucket": "Lifestyle"},
    "subs": {"id": "subs", "name": "Subscriptions", "icon": "film", "color": "#F0B27A", "bucket": "Lifestyle"},
    "travel": {"id": "travel", "name": "Travel", "icon": "plane", "color": "#6FB6D0", "bucket": "Lifestyle"},
    "gifts": {"id": "gifts", "name": "Gifts", "icon": "gift", "color": "#E59BD0", "bucket": "Lifestyle"},
    "phonenet": {"id": "phonenet", "name": "Phone & Internet", "icon": "phone", "color": "#B0A8F0", "bucket": "Living"},
}


_CATEGORIES_KEY = {"pk": "CATEGORIES", "sk": "CATEGORIES"}


class DuplicateCategoryError(Exception):
    """A category with the given id already exists (handler maps this to 409)."""


class CategoryNotFoundError(Exception):
    """No category with the given id exists (handler maps this to 404)."""


class VersionConflictError(Exception):
    """A config-item write could not converge within its retry budget because a
    concurrent writer kept moving the optimistic-lock version (handler maps this
    to 409). Shared by every single-config-item repository."""


class CategoryRepository:
    """Stores the user-defined category taxonomy as a single DynamoDB config item.

    The item at pk=sk="CATEGORIES" holds an `items` map (id -> category) plus a
    numeric `version` for optimistic-locking on writes. Categories are read-heavy
    and rarely written (single user), so a single-item read is the common path;
    writes are conditional and retry once on a version race.
    """

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def _get_config(self) -> Optional[dict]:
        try:
            return self._get_table().get_item(Key=_CATEGORIES_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read categories")

    def _ensure_seeded(self) -> None:
        """Idempotently write the seed taxonomy if the config item is absent.

        A lost race (another caller seeded first) raises ConditionalCheckFailed
        and is a no-op success: the seed content is deterministic, so the winner
        wrote exactly the same 13 categories.
        """
        try:
            self._get_table().put_item(
                Item={**_CATEGORIES_KEY, "items": dict(SEED_CATEGORIES), "version": Decimal(1)},
                ConditionExpression="attribute_not_exists(pk)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return
            handle_database_error(e, "seed categories")

    def list_categories(self) -> list[dict]:
        item = self._get_config()
        if item is None:
            self._ensure_seeded()
            item = self._get_config()  # re-read so a concurrent create is reflected
        return list(item["items"].values())

    def create_category(self, cat_id: str, name: str, bucket: str, icon: str) -> dict:
        """Add one category. Seeds first so the 13 defaults are never lost, then
        adds a single map key under an optimistic-lock guard. Raises
        DuplicateCategoryError if the id already exists.
        """
        self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            items = item["items"]
            version = item["version"]
            if cat_id in items:
                raise DuplicateCategoryError(cat_id)

            # Count taken AFTER seeding, so a new category never reuses a seed's index.
            color = CATEGORY_PALETTE[len(items) % len(CATEGORY_PALETTE)]
            new_cat = {"id": cat_id, "name": name, "icon": icon, "color": color, "bucket": bucket}
            try:
                self._get_table().update_item(
                    Key=_CATEGORIES_KEY,
                    # Nested SET adds ONE map key — never rewrites the whole items map.
                    UpdateExpression="SET #items.#id = :cat, #v = :next",
                    ConditionExpression=(
                        "attribute_exists(pk) AND #v = :expected "
                        "AND attribute_not_exists(#items.#id)"
                    ),
                    ExpressionAttributeNames={"#items": "items", "#id": cat_id, "#v": "version"},
                    ExpressionAttributeValues={
                        ":cat": new_cat,
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return new_cat
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "create category")
                # Disambiguate: duplicate id (409) vs a concurrent version bump (retry).
                latest = self._get_config()
                if cat_id in latest["items"]:
                    raise DuplicateCategoryError(cat_id)
                # id still free — the version moved under us; loop retries once.
        raise VersionConflictError("create_category: exhausted retries under write contention")

    def update_category(self, cat_id: str, name: str, bucket: str, icon: str) -> dict:
        """Update a category's editable fields (name, bucket, icon). The id/slug is
        immutable (it's the BankSync vocabulary), and color is server-owned, so
        neither changes here. Raises CategoryNotFoundError if the id is absent.
        `#name` is aliased because `name` is a DynamoDB reserved word; the others
        are aliased for consistency.
        """
        self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            items = item["items"]
            version = item["version"]
            if cat_id not in items:
                raise CategoryNotFoundError(cat_id)
            try:
                self._get_table().update_item(
                    Key=_CATEGORIES_KEY,
                    UpdateExpression=(
                        "SET #items.#id.#name = :name, #items.#id.#bucket = :bucket, "
                        "#items.#id.#icon = :icon, #v = :next"
                    ),
                    ConditionExpression=(
                        "attribute_exists(pk) AND #v = :expected "
                        "AND attribute_exists(#items.#id)"
                    ),
                    ExpressionAttributeNames={
                        "#items": "items", "#id": cat_id, "#name": "name",
                        "#bucket": "bucket", "#icon": "icon", "#v": "version",
                    },
                    ExpressionAttributeValues={
                        ":name": name,
                        ":bucket": bucket,
                        ":icon": icon,
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                # Build the response from the pre-read item so id/color survive.
                return {**items[cat_id], "name": name, "bucket": bucket, "icon": icon}
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "update category")
                # Disambiguate: id deleted under us (404) vs a concurrent version bump (retry).
                latest = self._get_config()
                if cat_id not in latest["items"]:
                    raise CategoryNotFoundError(cat_id)
                # id still present — the version moved under us; loop retries once.
        raise VersionConflictError("update_category: exhausted retries under write contention")

    def delete_category(self, cat_id: str) -> str:
        """Hard-delete a category (REMOVE its map key). No server-side cascade —
        transactions still referencing the id render as Uncategorized client-side.
        Raises CategoryNotFoundError if the id is absent.
        """
        self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            items = item["items"]
            version = item["version"]
            if cat_id not in items:
                raise CategoryNotFoundError(cat_id)
            try:
                self._get_table().update_item(
                    Key=_CATEGORIES_KEY,
                    # REMOVE drops one map key; SET bumps the version. The config item stays.
                    UpdateExpression="REMOVE #items.#id SET #v = :next",
                    ConditionExpression=(
                        "attribute_exists(pk) AND #v = :expected "
                        "AND attribute_exists(#items.#id)"
                    ),
                    ExpressionAttributeNames={"#items": "items", "#id": cat_id, "#v": "version"},
                    ExpressionAttributeValues={
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return cat_id
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "delete category")
                latest = self._get_config()
                if cat_id not in latest["items"]:
                    raise CategoryNotFoundError(cat_id)
                # id still present — the version moved under us; loop retries once.
        raise VersionConflictError("delete_category: exhausted retries under write contention")


_BUDGETS_KEY = {"pk": "BUDGETS", "sk": "BUDGETS"}


class BudgetRepository:
    """Stores per-category budget targets as a single DynamoDB config item.

    The item at pk=sk="BUDGETS" holds an `items` map (category id -> {"target":
    Decimal}) plus a numeric `version` for optimistic locking. Kept separate from
    the CATEGORIES item on purpose: an independent version means budget writes and
    category edits never contend on the same lock. Unlike the taxonomy there is no
    server seed — a target exists only once the user sets one, so the map seeds
    empty. Setting a target is an idempotent upsert (set whether or not the id was
    already present), retrying once on a version race.
    """

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def _get_config(self) -> Optional[dict]:
        try:
            return self._get_table().get_item(Key=_BUDGETS_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read budgets")

    def _ensure_seeded(self) -> None:
        """Idempotently write an empty budgets config item if absent. A lost race
        (another caller seeded first) raises ConditionalCheckFailed and is a no-op
        success: the seed is an empty map either way."""
        try:
            self._get_table().put_item(
                Item={**_BUDGETS_KEY, "items": {}, "version": Decimal(1)},
                ConditionExpression="attribute_not_exists(pk)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return
            handle_database_error(e, "seed budgets")

    def list_budgets(self) -> dict:
        """Return the stored {category id -> {"target": Decimal}} map (empty before
        any target is set). The handler flattens it to the API's {id: number} shape.
        """
        item = self._get_config()
        if item is None:
            self._ensure_seeded()
            item = self._get_config()  # re-read so a concurrent set is reflected
        return dict(item["items"])

    def set_budget(self, cat_id: str, target: Decimal) -> dict:
        """Set (upsert) a category's budget target under an optimistic-lock guard.

        Idempotent: succeeds whether or not the id already had a target — no
        attribute_(not_)exists guard on the map key, unlike create/update category.
        The id is not validated against the taxonomy: an unknown id just stores an
        orphan target, which the client ignores (same tolerance as a transaction
        pointing at a deleted category). Raises VersionConflictError if it can't
        converge within the retry budget.
        """
        self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            version = item["version"]
            try:
                self._get_table().update_item(
                    Key=_BUDGETS_KEY,
                    # Nested SET adds/overwrites ONE map key — never rewrites the whole map.
                    UpdateExpression="SET #items.#id = :val, #v = :next",
                    ConditionExpression="attribute_exists(pk) AND #v = :expected",
                    ExpressionAttributeNames={"#items": "items", "#id": cat_id, "#v": "version"},
                    ExpressionAttributeValues={
                        ":val": {"target": target},
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return {"id": cat_id, "target": target}
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "set budget")
                # The version moved under us; loop retries once.
        raise VersionConflictError("set_budget: exhausted retries under write contention")
