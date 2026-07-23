"""Debounce markers for the notification lambdas, stored as DynamoDB String Sets.

Budget alerts (WHIT-22): one item per pay cycle at pk="NOTIFY#<cycle_start>#<length>",
sk="FIRED", whose `fired` attribute is a String Set of "<catId>#<pct>" markers (e.g.
"groceries#80"). A crossing fires at most once per (category, threshold) per cycle:
before sending we check the set, after sending we ADD the marker. `cycle_start` is the
CURRENT cycle's start (the rolled-forward payday from current_cycle_window), so each new
cycle gets a fresh pk → an empty set → re-arms automatically. (The key was previously the
raw stored last_pay_date, which never rolled forward once the user's saved payday went
stale, so a threshold stayed suppressed for the whole 60-day TTL — budget_alerts now passes
the cycle start. NOTE: goal_nudge still passes the raw last_pay_date and has the same latent
gap — tracked as follow-up.)

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
from typing import Any, Optional

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

# The single marker item for the precise repayment-miss detector (WHIT-317): a String Set
# of "<fired_at>#<amount_cents>#<txn_id>" tokens, one per repayment push. Separate from
# NOTIFY#REPAYMENT (which only dedups by txn id) because the detector needs the push AMOUNT
# and TIME to match each ingested repayment against the push that alerted it. Like the
# ~monthly NOTIFY#REPAYMENT set, this stays tiny under its TTL.
_REPAYMENT_PUSH_KEY = {"pk": "NOTIFY#REPAYPUSH", "sk": "FIRED"}


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
        """Record that repayment `txn_id` has been notified, refresh the item's TTL, and
        stamp `last_fired_at` (epoch seconds) so the balance poller's missed-repayment
        check (WHIT-316) knows when a push last fired. ADD to a String Set is idempotent,
        so re-marking is harmless."""
        now = int(time.time())
        try:
            self._get_table().update_item(
                Key=_REPAYMENT_KEY,
                UpdateExpression="ADD #f :m SET #e = :exp, #lf = :now",
                ExpressionAttributeNames={"#f": "fired", "#e": "expires_at", "#lf": "last_fired_at"},
                ExpressionAttributeValues={":m": {txn_id}, ":exp": now + NOTIFY_TTL_SECONDS, ":now": now},
            )
        except ClientError as e:
            handle_database_error(e, "mark repayment notified")

    def last_repayment_fired_at(self) -> Optional[int]:
        """Epoch seconds of the most recent repayment push, or None if none is recorded
        (no push since the marker item was created, or the item TTL'd away). Read by the
        balance poller's missed-repayment alarm check (WHIT-316)."""
        try:
            item = self._get_table().get_item(Key=_REPAYMENT_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read repayment last-fired time")
        if item is None:
            return None
        last_fired_at = item.get("last_fired_at")
        return int(last_fired_at) if last_fired_at is not None else None

    def mark_repayment_push(self, amount_cents: int, txn_id: str, fired_at: Optional[int] = None) -> None:
        """Record that a repayment push of `amount_cents` fired at `fired_at` (epoch seconds,
        default now), so the precise miss-detector (WHIT-317) can match an ingested repayment
        against the push that alerted it. The token is "<fired_at>#<amount_cents>#<txn_id>" —
        txn_id keeps two same-amount pushes distinct in the Set. ADD is idempotent and each
        write refreshes the TTL."""
        now = int(time.time())
        stamped_at = now if fired_at is None else fired_at
        token = f"{stamped_at}#{amount_cents}#{txn_id}"
        try:
            self._get_table().update_item(
                Key=_REPAYMENT_PUSH_KEY,
                UpdateExpression="ADD #f :m SET #e = :exp",
                ExpressionAttributeNames={"#f": "pushes", "#e": "expires_at"},
                ExpressionAttributeValues={":m": {token}, ":exp": now + NOTIFY_TTL_SECONDS},
            )
        except ClientError as e:
            handle_database_error(e, "mark repayment push")

    def repayment_push_amounts_since(self, cutoff: int) -> list:
        """The amounts (integer cents) of every repayment push fired at or after `cutoff`
        (epoch seconds), as a LIST so duplicates survive — two same-amount repayments need
        two pushes to both count as alerted (WHIT-317). Tokens older than `cutoff` fall
        outside the detector's window and are skipped."""
        try:
            item = self._get_table().get_item(Key=_REPAYMENT_PUSH_KEY).get("Item")
        except ClientError as e:
            handle_database_error(e, "read repayment pushes")
        if item is None:
            return []
        amounts = []
        for token in item.get("pushes", set()):
            fired_at_str, amount_str, _txn_id = token.split("#", 2)
            if int(fired_at_str) >= cutoff:
                amounts.append(int(amount_str))
        return amounts

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
