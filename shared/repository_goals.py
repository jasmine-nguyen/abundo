"""Goal storage: savings ("grow") and debt ("paydown") targets on an account, as a
single DynamoDB config item (WHIT-231). Mirrors BudgetRepository — a separate item at
pk=sk="GOALS" so goal writes never contend with the budget/category optimistic-lock
versions. Persistence only; all field validation lives in the handler."""

from decimal import Decimal
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error
from repository_errors import VersionConflictError

_GOALS_KEY = {"pk": "GOALS", "sk": "GOALS"}


class GoalsRepository:
    """Stores the user's goals as a single DynamoDB config item.

    The item at pk=sk="GOALS" holds an `items` map (goal id -> the goal object) plus a
    numeric `version` for optimistic locking. Like budgets there is no server seed — the
    map seeds empty and a goal exists only once the user creates one. Saving a goal is an
    idempotent upsert of its own map key (a create and an edit are the same nested SET);
    deleting removes it. Both retry once on a version race, then raise VersionConflictError.
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
            return self._get_table().get_item(Key=_GOALS_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read goals")

    def _ensure_seeded(self) -> None:
        """Idempotently write an empty goals config item if absent. A lost race
        (another caller seeded first) raises ConditionalCheckFailed and is a no-op
        success: the seed is an empty map either way."""
        try:
            self._get_table().put_item(
                Item={**_GOALS_KEY, "items": {}, "version": Decimal(1)},
                ConditionExpression="attribute_not_exists(pk)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return
            handle_database_error(e, "seed goals")

    def list_goals(self) -> dict:
        """Return the stored {goal id -> goal object} map (empty before any goal is
        created). The handler flattens it to a list of goal objects for the API."""
        item = self._get_config()
        if item is None:
            self._ensure_seeded()
            item = self._get_config()  # re-read so a concurrent create is reflected
        return dict(item["items"])

    def upsert_goal(self, goal_id: str, goal: dict) -> dict:
        """Set (upsert) a goal under an optimistic-lock guard.

        Idempotent: succeeds whether or not the id already existed — a create and an
        edit are the same nested SET of one map key, so the whole goal object is
        replaced. `goal` is the already-validated object (Decimals + strings). Raises
        VersionConflictError if it can't converge within the retry budget.
        """
        self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            version = item["version"]
            try:
                self._get_table().update_item(
                    Key=_GOALS_KEY,
                    # Nested SET adds/overwrites ONE map key — never rewrites the whole map,
                    # so two goals edited at once don't clobber each other's data.
                    UpdateExpression="SET #items.#id = :val, #v = :next",
                    ConditionExpression="attribute_exists(pk) AND #v = :expected",
                    ExpressionAttributeNames={"#items": "items", "#id": goal_id, "#v": "version"},
                    ExpressionAttributeValues={
                        ":val": goal,
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return {"id": goal_id, **goal}
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "save goal")
                # The version moved under us; loop retries once.
        raise VersionConflictError("upsert_goal: exhausted retries under write contention")

    def delete_goal(self, goal_id: str) -> None:
        """Remove a goal, if present.

        Idempotent no-op when the goal is absent — neither seeds the config item nor
        bumps the version in that case. When it exists, REMOVE its map key under the
        same optimistic-lock guard as upsert_goal, retrying once on a race.
        """
        for _attempt in range(2):
            item = self._get_config()
            if item is None or goal_id not in item["items"]:
                return  # no goal for this id -> nothing to delete
            version = item["version"]
            try:
                self._get_table().update_item(
                    Key=_GOALS_KEY,
                    # REMOVE drops one map key; SET bumps the version. The config item stays.
                    UpdateExpression="REMOVE #items.#id SET #v = :next",
                    ConditionExpression="attribute_exists(pk) AND #v = :expected",
                    ExpressionAttributeNames={"#items": "items", "#id": goal_id, "#v": "version"},
                    ExpressionAttributeValues={
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "delete goal")
                # The version moved under us; loop re-reads and retries once.
        raise VersionConflictError("delete_goal: exhausted retries under write contention")
