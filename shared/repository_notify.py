"""Debounce markers for the notification lambdas, stored as DynamoDB String Sets.

Budget alerts (WHIT-22): one item per pay cycle at pk="NOTIFY#<cycle_start>#<length>",
sk="FIRED", whose `fired` attribute is a String Set of "<catId>#<pct>" markers (e.g.
"groceries#80"). A threshold fires at most once per (category, threshold) per cycle:
the sender CLAIMS the marker with a conditional ADD before sending (so two overlapping
webhook deliveries can't both send), and RELEASES it if the push didn't land, so the
next delivery retries (WHIT-577). `cycle_start` is the
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
from typing import Optional

from constants import NOTIFY_TTL_SECONDS
from repository_base import RepositoryBase, conditional_write, db_errors


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
# id to both.
_MILESTONE_SCOPE = "FIRED"


def _milestone_key(scope: Optional[str] = None) -> dict:
    """The marker item's key for `scope`; None is the shared tenant. One place for the
    None → shared default so every accessor stays consistent."""
    return {"pk": "NOTIFY#MILESTONE", "sk": _MILESTONE_SCOPE if scope is None else scope}


# The already-celebrated goal-checkpoint markers (WHIT-479), a SEPARATE item from
# NOTIFY#MILESTONE so the mortgage feature is untouched. Same once-ever, no-TTL contract: a goal
# balance isn't monotonic (a grow balance rises and falls, a debt is redrawn), so a crossed
# checkpoint can be re-crossed — the marker, not monotonicity, dedups it.
_GOALCHECKPOINT_SCOPE = "FIRED"


def _goalcheckpoint_key(scope: Optional[str] = None) -> dict:
    """The goal-checkpoint marker item's key for `scope`; None is the shared tenant."""
    return {"pk": "NOTIFY#GOALCHECKPOINT", "sk": _GOALCHECKPOINT_SCOPE if scope is None else scope}

# The single marker item for the precise repayment-miss detector (WHIT-317): a String Set
# of "<fired_at>#<amount_cents>#<txn_id>" tokens, one per repayment push. Separate from
# NOTIFY#REPAYMENT (which only dedups by txn id) because the detector needs the push AMOUNT
# and TIME to match each ingested repayment against the push that alerted it. Like the
# ~monthly NOTIFY#REPAYMENT set, this stays tiny under its TTL.
_REPAYMENT_PUSH_KEY = {"pk": "NOTIFY#REPAYPUSH", "sk": "FIRED"}


class NotifyRepository(RepositoryBase):
    """Per-cycle budget-alert debounce markers. `fired_markers` reads the set of
    already-sent "<catId>#<pct>" strings for a cycle; `claim_fired` adds one only if it's
    absent, `release_fired` drops one, `mark_fired` adds one unconditionally."""

    def _read_set(self, key: dict, action: str, attr: str = "fired") -> set:
        """The String Set stored under `attr` on the item at `key` (set() if either is missing)."""
        with db_errors(action):
            item = self._get_table().get_item(Key=key).get("Item")
        if item is None:
            return set()
        return set(item.get(attr, set()))

    def _update_set(self, key: dict, op: str, members: set, *, action: str, attr: str = "fired",
                    ttl: bool = False, now: Optional[int] = None) -> None:
        """ADD or DELETE (`op`) `members` on the `attr` String Set at `key`. With `ttl`, also
        refresh the item's `expires_at` from `now` (default: the current time)."""
        expression = f"{op} #f :m"
        names = {"#f": attr}
        values = {":m": members}
        if ttl:
            expression += " SET #e = :exp"
            names["#e"] = "expires_at"
            values[":exp"] = (int(time.time()) if now is None else now) + NOTIFY_TTL_SECONDS
        with db_errors(action):
            self._get_table().update_item(
                Key=key,
                UpdateExpression=expression,
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )

    def fired_markers(self, last_pay_date: str, length: int) -> set:
        """The set of "<catId>#<pct>" markers already fired this cycle ({} if none)."""
        key = {"pk": _pk(last_pay_date, length), "sk": "FIRED"}
        return self._read_set(key, "read budget-alert markers")

    def mark_fired(self, last_pay_date: str, length: int, marker: str) -> None:
        """Record that "<marker>" (e.g. "groceries#80") has fired this cycle, and
        refresh the item's TTL. ADD to a String Set is idempotent, so re-marking is
        harmless; the first ADD creates the item."""
        key = {"pk": _pk(last_pay_date, length), "sk": "FIRED"}
        self._update_set(key, "ADD", {marker}, action="mark budget-alert fired", ttl=True)

    def claim_fired(self, last_pay_date: str, length: int, marker: str) -> bool:
        """Add "<marker>" to this cycle's set ONLY if it isn't there yet, and refresh the TTL.
        True if this caller claimed it (and so owns the send), False if another delivery
        already had (WHIT-577). The first claim creates the item."""
        key = {"pk": _pk(last_pay_date, length), "sk": "FIRED"}
        return conditional_write("claim budget-alert marker", lambda: self._get_table().update_item(
            Key=key,
            UpdateExpression="ADD #f :m SET #e = :exp",
            ConditionExpression="attribute_not_exists(#f) OR NOT contains(#f, :v)",
            ExpressionAttributeNames={"#f": "fired", "#e": "expires_at"},
            ExpressionAttributeValues={
                ":m": {marker}, ":v": marker, ":exp": int(time.time()) + NOTIFY_TTL_SECONDS},
        ))

    def release_fired(self, last_pay_date: str, length: int, marker: str) -> None:
        """Drop a claimed "<marker>" whose push never landed, so the next delivery can retry
        it. Deleting the last member drops the `fired` attribute; fired_markers reads set()."""
        key = {"pk": _pk(last_pay_date, length), "sk": "FIRED"}
        self._update_set(key, "DELETE", {marker}, action="release budget-alert marker")

    def fired_repayments(self) -> set:
        """The set of home-loan repayment transaction ids already notified (WHIT-15)."""
        return self._read_set(_REPAYMENT_KEY, "read repayment-notify markers")

    def mark_repayment_fired(self, txn_id: str) -> None:
        """Record that repayment `txn_id` has been notified, refresh the item's TTL, and
        stamp `last_fired_at` (epoch seconds) so the balance poller's missed-repayment
        check (WHIT-316) knows when a push last fired. ADD to a String Set is idempotent,
        so re-marking is harmless."""
        now = int(time.time())
        with db_errors("mark repayment notified"):
            self._get_table().update_item(
                Key=_REPAYMENT_KEY,
                UpdateExpression="ADD #f :m SET #e = :exp, #lf = :now",
                ExpressionAttributeNames={"#f": "fired", "#e": "expires_at", "#lf": "last_fired_at"},
                ExpressionAttributeValues={":m": {txn_id}, ":exp": now + NOTIFY_TTL_SECONDS, ":now": now},
            )

    def last_repayment_fired_at(self) -> Optional[int]:
        """Epoch seconds of the most recent repayment push, or None if none is recorded
        (no push since the marker item was created, or the item TTL'd away). Read by the
        balance poller's missed-repayment alarm check (WHIT-316)."""
        with db_errors("read repayment last-fired time"):
            item = self._get_table().get_item(Key=_REPAYMENT_KEY).get("Item")
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
        self._update_set(_REPAYMENT_PUSH_KEY, "ADD", {token}, action="mark repayment push",
                         attr="pushes", ttl=True, now=now)

    def repayment_push_amounts_since(self, cutoff: int) -> list:
        """The amounts (integer cents) of every repayment push fired at or after `cutoff`
        (epoch seconds), as a LIST so duplicates survive — two same-amount repayments need
        two pushes to both count as alerted (WHIT-317). Tokens older than `cutoff` fall
        outside the detector's window and are skipped."""
        amounts = []
        for token in self._read_set(_REPAYMENT_PUSH_KEY, "read repayment pushes", attr="pushes"):
            fired_at_str, amount_str, _txn_id = token.split("#", 2)
            if int(fired_at_str) >= cutoff:
                amounts.append(int(amount_str))
        return amounts

    def fired_milestones(self, scope: Optional[str] = None) -> set:
        """The set of already-celebrated payoff-milestone markers for `scope` (WHIT-301/369).
        A marker is the saved milestone's dedup key "id:<id>:bal:<amount>". `scope` selects the
        owner; None is the shared tenant."""
        return self._read_set(_milestone_key(scope), "read milestone-notify markers")

    def mark_milestone_fired(self, key: str, scope: Optional[str] = None) -> None:
        """Record that the milestone with dedup marker `key` has been celebrated for `scope`.
        Deliberately NO TTL (unlike the per-cycle/per-repayment markers above): the paydown is
        monotonic, so a milestone is a once-ever event that must never expire and re-fire.
        `scope` selects the owner; None is the shared tenant."""
        self._update_set(_milestone_key(scope), "ADD", {key}, action="mark milestone celebrated")

    def fired_goal_checkpoints(self, scope: Optional[str] = None) -> set:
        """The set of already-celebrated goal-checkpoint markers for `scope` (WHIT-479). A marker
        is a checkpoint's dedup key "g:<goal>:cp:<id>:bal:<amount>" (goal_checkpoints._checkpoint_marker).
        `scope` selects the owner; None is the shared tenant."""
        return self._read_set(_goalcheckpoint_key(scope), "read goal-checkpoint markers")

    def mark_goal_checkpoint_fired(self, key: str, scope: Optional[str] = None) -> None:
        """Record that the goal checkpoint with dedup marker `key` has been celebrated for `scope`
        (WHIT-479). Deliberately NO TTL: a checkpoint crossing is a once-ever event that must never
        expire and re-fire (the balance isn't monotonic, so it could be re-crossed). `scope`
        selects the owner; None is the shared tenant."""
        self._update_set(_goalcheckpoint_key(scope), "ADD", {key}, action="mark goal checkpoint celebrated")

    def remove_milestone_markers(self, keys: set, scope: Optional[str] = None) -> None:
        """Drop dead milestone markers from the String Set (WHIT-385): a re-targeted or deleted
        custom milestone's old marker must be removed so the set can't grow forever. DELETE
        removes the given members; deleting the LAST member drops the `fired` attribute entirely,
        so fired_milestones() then reads back set(). No TTL is written (same once-ever contract as
        mark_milestone_fired). Guards on empty — DynamoDB rejects an empty String Set, so a no-op
        call must not touch the table. `scope` selects the owner; None is the shared tenant."""
        if not keys:
            return
        self._update_set(_milestone_key(scope), "DELETE", set(keys), action="remove milestone markers")
