"""Registered Expo push tokens, stored as a single DynamoDB config item.

The device tokens the app registers (POST /devices) live in one item at
pk=sk="DEVICES" as a DynamoDB String Set attribute ``tokens``. A String Set gives
dedupe + idempotency for free: ADD is set-union (re-registering a token is a
no-op), DELETE is set-difference, and removing the last token drops the attribute
(DynamoDB forbids empty sets) so ``list_tokens`` reads back []. No version guard is
needed — set ADD/DELETE are commutative and idempotent, so two concurrent writers
can't corrupt the set. Uses UpdateItem (not DeleteItem) throughout, matching the
lambda_api role's grants.
"""

from typing import Any

import boto3
from botocore.exceptions import ClientError

from repository_base import REGION_NAME, TABLE_NAME, handle_database_error

_DEVICES_KEY = {"pk": "DEVICES", "sk": "DEVICES"}


class DeviceRepository:
    """Stores registered Expo push tokens as a String Set on a single config item
    at pk=sk="DEVICES"."""

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def register(self, token: str) -> None:
        """Add a token to the set. Idempotent — re-adding an existing token is a
        no-op at the DB level (set-union), and the first ADD creates the item."""
        try:
            self._get_table().update_item(
                Key=_DEVICES_KEY,
                UpdateExpression="ADD #t :tok",
                ExpressionAttributeNames={"#t": "tokens"},
                ExpressionAttributeValues={":tok": {token}},
            )
        except ClientError as e:
            handle_database_error(e, "register device token")

    def list_tokens(self) -> list[str]:
        """Return the registered tokens (sorted), or [] before any register."""
        try:
            item = self._get_table().get_item(Key=_DEVICES_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "list device tokens")
        if item is None:
            return []
        return sorted(item.get("tokens", []))

    def remove(self, token: str) -> None:
        """Delete a token from the set (a no-op if it isn't there). Removing the
        last token drops the ``tokens`` attribute entirely — DynamoDB forbids an
        empty set — which ``list_tokens`` reads back as []."""
        try:
            self._get_table().update_item(
                Key=_DEVICES_KEY,
                UpdateExpression="DELETE #t :tok",
                ExpressionAttributeNames={"#t": "tokens"},
                ExpressionAttributeValues={":tok": {token}},
            )
        except ClientError as e:
            handle_database_error(e, "remove device token")
