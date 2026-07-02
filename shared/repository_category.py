"""Category taxonomy storage: the user-defined categories as a single DynamoDB
config item, with the seed taxonomy and colour palette kept local to this module."""

from decimal import Decimal
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error
from repository_errors import (
    CategoryNotFoundError,
    DuplicateCategoryError,
    VersionConflictError,
)

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
