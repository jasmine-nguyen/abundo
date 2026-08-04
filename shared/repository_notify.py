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

# The already-celebrated payoff-milestone markers, one item per owner (WHIT-301/369). The sort
# key IS the `scope` (owner): None → the shared tenant, an authenticated user id later. The
# shared-tenant value stays the historical "FIRED" so existing markers are NOT orphaned by the
# WHIT-369 seam — orphaning them would let an already-celebrated milestone re-fire a duplicate
# push, because the balance is NOT strictly monotonic (interest and redraws raise it, so a
# crossed milestone can be re-crossed; the marker, not monotonicity, is what dedups it). The
# plan store (MilestoneRepository) scopes its shared tenant as "SHARED"; the two literals differ
# only for the shared default and only for back-compat — real per-user scopes pass the SAME user
# id to both. A module literal, not a shared constant, so it never crosses the lambda_api
# constants shadow (WHIT-136).
_MILESTONE_SCOPE = "FIRED"


def _milestone_key(scope: Optional[str] = None) -> dict:
    """The marker item's key for `scope`; None is the shared tenant. One place for the
    None → shared default so every accessor stays consistent."""
    return {"pk": "NOTIFY#MILESTONE", "sk": _MILESTONE_SCOPE if scope is None else scope}

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

    def fired_milestones(self, scope: Optional[str] = None) -> set:
        """The set of already-celebrated payoff-milestone markers for `scope` (WHIT-301/369).
        A marker is the milestone's dedup key — "id:<id>:bal:<amount>" for a saved milestone,
        or a bare sprint "0".."4" for the built-in default. `scope` selects the owner; None is
        the shared tenant."""
        try:
            item = self._get_table().get_item(Key=_milestone_key(scope)).get("Item")
        except ClientError as e:
            handle_database_error(e, "read milestone-notify markers")
        if item is None:
            return set()
        return set(item.get("fired", set()))

    def mark_milestone_fired(self, key: str, scope: Optional[str] = None) -> None:
        """Record that the milestone with dedup marker `key` has been celebrated for `scope`.
        Deliberately NO TTL (unlike the per-cycle/per-repayment markers above): the paydown is
        monotonic, so a milestone is a once-ever event that must never expire and re-fire.
        `scope` selects the owner; None is the shared tenant."""
        try:
            self._get_table().update_item(
                Key=_milestone_key(scope),
                UpdateExpression="ADD #f :m",
                ExpressionAttributeNames={"#f": "fired"},
                ExpressionAttributeValues={":m": {key}},
            )
        except ClientError as e:
            handle_database_error(e, "mark milestone celebrated")

    def remove_milestone_markers(self, keys: set, scope: Optional[str] = None) -> None:
        """Drop dead milestone markers from the String Set (WHIT-385): a re-targeted or deleted
        custom milestone's old marker must be removed so the set can't grow forever. DELETE
        removes the given members; deleting the LAST member drops the `fired` attribute entirely,
        so fired_milestones() then reads back set(). No TTL is written (same once-ever contract as
        mark_milestone_fired). Guards on empty — DynamoDB rejects an empty String Set, so a no-op
        call must not touch the table. `scope` selects the owner; None is the shared tenant."""
        if not keys:
            return
        try:
            self._get_table().update_item(
                Key=_milestone_key(scope),
                UpdateExpression="DELETE #f :m",
                ExpressionAttributeNames={"#f": "fired"},
                ExpressionAttributeValues={":m": set(keys)},
            )
        except ClientError as e:
            handle_database_error(e, "remove milestone markers")

    def migrate_milestone_markers(self, migrations: list, scope: Optional[str] = None) -> None:
        """Rename each (old, new) once-ever milestone marker in place, for a legacy id-less row
        that the save endpoint has just minted an id for (WHIT-447). Without this, the next poll
        keys the now-id'd row under `new`, finds `old` uncovered, and sweeps it as dead — re-arming
        an already-celebrated milestone.

        ONLY a marker already in the fired set is migrated: adding a `new` whose `old` was never
        celebrated would wrongly suppress a legitimate future first celebration. Same no-TTL
        once-ever contract as mark_milestone_fired / remove_milestone_markers.

        ADD the new markers BEFORE deleting the old ones — the order is the partial-failure
        contract. If the DELETE never runs, the row is left holding BOTH markers: still deduped,
        and the poller later reaps the now-genuinely-dead `old` as stale. Deleting first and then
        failing to add would leave NO marker and re-arm the celebration — the exact bug this
        migration prevents. `scope` selects the owner; None is the shared tenant."""
        if not migrations:
            return
        fired = self.fired_milestones(scope)
        relevant = [(old, new) for old, new in migrations if old in fired]
        if not relevant:
            return
        to_add = {new for _, new in relevant}
        to_remove = {old for old, _ in relevant}
        key = _milestone_key(scope)
        try:
            self._get_table().update_item(
                Key=key,
                UpdateExpression="ADD #f :m",
                ExpressionAttributeNames={"#f": "fired"},
                ExpressionAttributeValues={":m": to_add},
            )
            self._get_table().update_item(
                Key=key,
                UpdateExpression="DELETE #f :m",
                ExpressionAttributeNames={"#f": "fired"},
                ExpressionAttributeValues={":m": to_remove},
            )
        except ClientError as e:
            handle_database_error(e, "migrate milestone markers")
