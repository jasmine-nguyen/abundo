"""Debounce markers for the notification lambdas, stored as DynamoDB String Sets.

Budget alerts (WHIT-22): one item per pay cycle at pk="NOTIFY#<last_pay_date>#<length>",
sk="FIRED", whose `fired` attribute is a String Set of "<catId>#<pct>" markers (e.g.
"groceries#80"). A crossing fires at most once per (category, threshold) per cycle:
before sending we check the set, after sending we ADD the marker. A new pay cycle
has a new pk → an empty set → re-arms automatically.

Repayment pushes (WHIT-15): one shared item at pk="NOTIFY#REPAYMENT", sk="FIRED",
whose `fired` attribute is a String Set of already-notified repayment transaction ids.
The webhook fires only on POSTED repayments, whose ids are stable across re-syncs, so
a re-ingested repayment is deduped to one push. Repayments are ~monthly, so the set
stays tiny under its TTL.

Both use the same primitive: Set ADD is idempotent and commutative, so no version lock
is needed (same pattern as DeviceRepository). Each write refreshes an `expires_at`
epoch-seconds TTL (NOTIFY_TTL_SECONDS) so a marker self-cleans well after it stops
being relevant instead of accumulating.
"""

import time
from typing import Any

import boto3
from botocore.exceptions import ClientError

from constants import NOTIFY_TTL_SECONDS
from repository_base import REGION_NAME, TABLE_NAME, handle_database_error


def _pk(last_pay_date: str, length: int) -> str:
    return f"NOTIFY#{last_pay_date}#{length}"


# The single marker item holding every already-notified repayment id (WHIT-15).
_REPAYMENT_KEY = {"pk": "NOTIFY#REPAYMENT", "sk": "FIRED"}

# The single marker item holding every already-celebrated payoff-milestone sprint (WHIT-301).
_MILESTONE_KEY = {"pk": "NOTIFY#MILESTONE", "sk": "FIRED"}


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

    def fired_repayments(self) -> set:
        """The set of home-loan repayment transaction ids already notified (WHIT-15)."""
        try:
            item = self._get_table().get_item(Key=_REPAYMENT_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read repayment-notify markers")
        if item is None:
            return set()
        return set(item.get("fired", set()))

    def mark_repayment_fired(self, txn_id: str) -> None:
        """Record that repayment `txn_id` has been notified, and refresh the item's
        TTL. ADD to a String Set is idempotent, so re-marking is harmless."""
        try:
            self._get_table().update_item(
                Key=_REPAYMENT_KEY,
                UpdateExpression="ADD #f :m SET #e = :exp",
                ExpressionAttributeNames={"#f": "fired", "#e": "expires_at"},
                ExpressionAttributeValues={":m": {txn_id}, ":exp": int(time.time()) + NOTIFY_TTL_SECONDS},
            )
        except ClientError as e:
            handle_database_error(e, "mark repayment notified")

    def fired_milestones(self) -> set:
        """The set of payoff-milestone sprint numbers (as strings) already celebrated (WHIT-301)."""
        try:
            item = self._get_table().get_item(Key=_MILESTONE_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read milestone-notify markers")
        if item is None:
            return set()
        return set(item.get("fired", set()))

    def mark_milestone_fired(self, sprint: str) -> None:
        """Record that payoff milestone `sprint` has been celebrated. Deliberately NO TTL
        (unlike the per-cycle/per-repayment markers above): the paydown is monotonic, so a
        milestone is a once-ever event that must never expire and re-fire."""
        try:
            self._get_table().update_item(
                Key=_MILESTONE_KEY,
                UpdateExpression="ADD #f :m",
                ExpressionAttributeNames={"#f": "fired"},
                ExpressionAttributeValues={":m": {sprint}},
            )
        except ClientError as e:
            handle_database_error(e, "mark milestone celebrated")
