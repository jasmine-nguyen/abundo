"""Pay-cycle storage: the user's window length + payday anchor as a single
DynamoDB config item (one settings object, replaced whole under the version guard)."""

from decimal import Decimal
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

from constants import DEFAULT_PAYCYCLE
from repository_base import REGION_NAME, TABLE_NAME, handle_database_error
from repository_errors import VersionConflictError

_PAYCYCLE_KEY = {"pk": "PAYCYCLE", "sk": "PAYCYCLE"}


class PayCycleRepository:
    """Stores the user's pay cycle as a single DynamoDB config item.

    The item at pk=sk="PAYCYCLE" holds a `length` (int days: 7/14/30) and an
    `anchor` (ISO date string of a real past payday), plus a numeric `version`
    for optimistic locking. Unlike BudgetRepository there is no per-key `items`
    map — the pay cycle is one small settings object, so a write REPLACES both
    fields together under the version guard. Seeds to DEFAULT_PAYCYCLE so a fresh
    install reads a valid cycle before the user has set one.
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
            return self._get_table().get_item(Key=_PAYCYCLE_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read pay cycle")

    def _ensure_seeded(self) -> None:
        """Idempotently write the seed pay cycle if the config item is absent.

        A lost race (another caller seeded first) raises ConditionalCheckFailed
        and is a no-op success: the seed is the same deterministic DEFAULT_PAYCYCLE
        either way.
        """
        try:
            self._get_table().put_item(
                Item={
                    **_PAYCYCLE_KEY,
                    "length": Decimal(DEFAULT_PAYCYCLE["length"]),
                    "anchor": DEFAULT_PAYCYCLE["anchor"],
                    "version": Decimal(1),
                },
                ConditionExpression="attribute_not_exists(pk)",
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return
            handle_database_error(e, "seed pay cycle")

    def get_paycycle(self) -> dict:
        """Return the stored {"length": int, "anchor": str}, seeding the default on
        first read. `length` is normalised back to a plain int (DynamoDB stores it
        as a Decimal) so the handler serialises it as a JSON integer."""
        item = self._get_config()
        if item is None:
            self._ensure_seeded()
            item = self._get_config()  # re-read so a concurrent set is reflected
        return {"length": int(item["length"]), "anchor": item["anchor"]}

    def set_paycycle(self, length: int, anchor: str) -> dict:
        """Set (replace) the pay cycle under an optimistic-lock guard.

        Both fields are written together — the pay cycle is one object, not a map
        of independent keys — so a concurrent length change and anchor change can't
        silently interleave. Validation (allowed length, parseable past-date anchor)
        is the handler's job; this just persists. Raises VersionConflictError if it
        can't converge within the retry budget.
        """
        self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            version = item["version"]
            try:
                self._get_table().update_item(
                    Key=_PAYCYCLE_KEY,
                    UpdateExpression="SET #length = :length, #anchor = :anchor, #v = :next",
                    ConditionExpression="attribute_exists(pk) AND #v = :expected",
                    ExpressionAttributeNames={
                        "#length": "length",
                        "#anchor": "anchor",
                        "#v": "version",
                    },
                    ExpressionAttributeValues={
                        ":length": Decimal(length),
                        ":anchor": anchor,
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return {"length": length, "anchor": anchor}
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "set pay cycle")
                # The version moved under us; loop retries once.
        raise VersionConflictError("set_paycycle: exhausted retries under write contention")
