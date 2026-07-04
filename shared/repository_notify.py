"""Budget-alert debounce markers (WHIT-22), stored one item per pay cycle.

Each cycle gets a single item at pk="NOTIFY#<last_pay_date>#<length>", sk="FIRED",
whose `fired` attribute is a DynamoDB String Set of "<catId>#<pct>" markers (e.g.
"groceries#80"). A crossing fires at most once per (category, threshold) per cycle:
before sending we check the set, after sending we ADD the marker. A new pay cycle
has a new pk → an empty set → re-arms automatically. Set ADD is idempotent and
commutative, so no version lock is needed (same pattern as DeviceRepository).

Each write refreshes an `expires_at` epoch-seconds TTL (NOTIFY_TTL_SECONDS) so a
cycle's marker self-cleans well after the cycle ends instead of accumulating.
"""

import time
from typing import Any

import boto3
from botocore.exceptions import ClientError

from constants import NOTIFY_TTL_SECONDS
from repository_base import REGION_NAME, TABLE_NAME, handle_database_error


def _pk(last_pay_date: str, length: int) -> str:
    return f"NOTIFY#{last_pay_date}#{length}"


class NotifyRepository:
    """Per-cycle budget-alert debounce markers. `fired_markers` reads the set of
    already-sent "<catId>#<pct>" strings for a cycle; `mark_fired` adds one."""

    def __init__(self) -> None:
        self._dynamodb = None
        self._table = None

    def _get_table(self) -> Any:
        if self._table is None:
            self._dynamodb = boto3.resource("dynamodb", region_name=REGION_NAME)
            self._table = self._dynamodb.Table(TABLE_NAME)
        return self._table

    def fired_markers(self, last_pay_date: str, length: int) -> set:
        """The set of "<catId>#<pct>" markers already fired this cycle ({} if none)."""
        key = {"pk": _pk(last_pay_date, length), "sk": "FIRED"}
        try:
            item = self._get_table().get_item(Key=key).get("Item")
        except ClientError as e:
            handle_database_error(e, "read budget-alert markers")
        if item is None:
            return set()
        return set(item.get("fired", set()))

    def mark_fired(self, last_pay_date: str, length: int, marker: str) -> None:
        """Record that "<marker>" (e.g. "groceries#80") has fired this cycle, and
        refresh the item's TTL. ADD to a String Set is idempotent, so re-marking is
        harmless; the first ADD creates the item."""
        key = {"pk": _pk(last_pay_date, length), "sk": "FIRED"}
        try:
            self._get_table().update_item(
                Key=key,
                UpdateExpression="ADD #f :m SET #e = :exp",
                ExpressionAttributeNames={"#f": "fired", "#e": "expires_at"},
                ExpressionAttributeValues={":m": {marker}, ":exp": int(time.time()) + NOTIFY_TTL_SECONDS},
            )
        except ClientError as e:
            handle_database_error(e, "mark budget-alert fired")
