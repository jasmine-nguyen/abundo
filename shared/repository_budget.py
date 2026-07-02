"""Budget-target storage: per-category pay-cycle targets as a single DynamoDB
config item (separate from CATEGORIES so their optimistic-lock versions never
contend)."""

from decimal import Decimal
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error
from repository_errors import VersionConflictError

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
