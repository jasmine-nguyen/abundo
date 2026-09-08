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

# The rollover-only fields on a budget entry (everything but `target`). Cleared when a
# category is reclassified out of a spend bucket (rollover is spend-only). Kept local —
# NOT imported from shared/constants.py — so the WHIT-136 constants-sync guard is untouched.
_ROLLOVER_FIELDS = ("rollover", "carryover", "carryover_from", "carryover_len", "carryover_paydate")

# The bill-spread fields on a budget entry (WHIT-504): the bill amount, how many cycles it
# is paid back over, and the anchor cycle it was created in (`spread_from`) plus the pay
# cycle that anchor was captured under (`spread_len`/`spread_paydate`, so a cycle-config
# change can be detected — the same pattern as the rollover anchor). Spend-only, like
# rollover, and cleared on a reclassify out of spend. Kept local for the same WHIT-136 reason.
_SPREAD_FIELDS = ("spread_amount", "spread_cycles", "spread_from", "spread_len", "spread_paydate")


class BudgetRepository:
    """Stores per-category budget targets as a single DynamoDB config item.

    The item at pk=sk="BUDGETS" holds an `items` map (category id -> entry) plus a
    numeric `version` for optimistic locking. An entry is `{"target": Decimal}` plus,
    once a category opts into rollover (WHIT budget-rollover), the optional fields
    `rollover` (bool), `carryover` (signed Decimal buffer), `carryover_from` (ISO cycle
    start the buffer is sealed as of), `carryover_len`/`carryover_paydate` (the pay-cycle
    the buffer was sealed under, so a cycle-config change can re-anchor), or — instead of
    rollover, never alongside it — a bill spread's `spread_*` fields (see _SPREAD_FIELDS,
    WHIT-504). All optional fields are absent on a legacy/plain budget and default to off/0. Kept separate from
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

    def _merge_entry(self, cat_id: str, fields: dict, drop: tuple = ()) -> dict:
        """Read-modify-write ONE category entry: merge `fields` over the existing entry
        (or an empty one), minus any keys in `drop`, and write the whole entry back under
        the optimistic-lock guard.

        Merge — not a per-field nested SET — for two reasons: it PRESERVES the entry's
        other fields (so an amount edit can't wipe a stored `carryover`/`rollover`, and a
        settle can't wipe `target`), and it works when the entry doesn't exist yet (a
        nested `SET #items.#id.#field` errors on a missing parent map, but `SET #items.#id
        = :val` is valid because the `items` map itself is always seeded). `drop` is
        applied on EVERY attempt, so a retry after a version race re-strips whatever the
        competing writer merged in. Retries once on a version race; raises
        VersionConflictError if it can't converge.
        """
        self._ensure_seeded()
        for _attempt in range(2):
            item = self._get_config()
            version = item["version"]
            existing = {k: v for k, v in item["items"].get(cat_id, {}).items() if k not in drop}
            entry = {**existing, **fields}
            try:
                self._get_table().update_item(
                    Key=_BUDGETS_KEY,
                    # SET the whole entry for ONE map key — never rewrites the other keys.
                    UpdateExpression="SET #items.#id = :val, #v = :next",
                    ConditionExpression="attribute_exists(pk) AND #v = :expected",
                    ExpressionAttributeNames={"#items": "items", "#id": cat_id, "#v": "version"},
                    ExpressionAttributeValues={
                        ":val": entry,
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return {"id": cat_id, **entry}
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "set budget")
                # The version moved under us; loop retries once.
        raise VersionConflictError("set_budget: exhausted retries under write contention")

    def set_budget(self, cat_id: str, target: Decimal,
                   rollover: Optional[bool] = None, anchor: Optional[dict] = None) -> dict:
        """Set (upsert) a category's budget target, optionally its rollover flag.

        Idempotent: succeeds whether or not the id already had a target. The id is not
        validated against the taxonomy: an unknown id just stores an orphan target, which
        the client ignores. Preserves any stored rollover/carryover fields (read-modify-
        write), so a plain amount edit never wipes a category's accumulated buffer.

        `rollover` (when given) sets the flag. `anchor` (a {carryover_from, carryover_len,
        carryover_paydate} dict) is supplied by the handler when rollover turns ON, to
        (re)start accumulation from the current cycle — the stored `carryover` balance is
        left untouched (frozen-then-resumed), so toggling OFF then ON keeps the buffer but
        never seals the cycles that elapsed while it was off. Raises VersionConflictError
        if it can't converge within the retry budget.

        A category has rollover OR a bill spread, never both (WHIT-504). The handler 400s
        the co-state up front, but that is check-then-act; this write is where the rule is
        made structural — turning rollover ON strips any spread fields in the SAME write,
        so a lost race can never leave both stored (last writer wins).
        """
        fields: dict = {"target": target}
        if rollover is not None:
            fields["rollover"] = rollover
        if anchor is not None:
            fields.update(anchor)
        drop = _SPREAD_FIELDS if rollover else ()
        entry = self._merge_entry(cat_id, fields, drop=drop)
        return {"id": cat_id, "target": entry["target"]}

    def settle_carryover(self, cat_id: str, carryover: Decimal, carryover_from: str,
                         carryover_len: int, carryover_paydate: str) -> dict:
        """Persist a rollover category's sealed carryover balance + anchor (the write-on-read
        step of the /budgets settlement). Preserves `target`/`rollover` via _merge_entry.

        Called best-effort from the read path: the caller swallows a VersionConflictError so
        a settle that loses the race never fails the GET — the balance simply re-seals on the
        next read (the displayed number is always recomputed live, not read from the store).
        """
        return self._merge_entry(cat_id, {
            "carryover": carryover,
            "carryover_from": carryover_from,
            "carryover_len": Decimal(carryover_len),
            "carryover_paydate": carryover_paydate,
        })

    def delete_budget(self, cat_id: str) -> None:
        """Remove a category's budget target, if any — the cascade run when a
        category is deleted, so a stale target can't linger (and silently reappear
        if a same-slug category is later re-created).

        Idempotent no-op when the target is absent — the common case, since most
        categories never carry a budget — so it neither seeds the config item nor
        bumps the version in that case. When a target exists, REMOVE its map key
        under the same optimistic-lock guard as set_budget, retrying once on a race.
        """
        for _attempt in range(2):
            item = self._get_config()
            if item is None or cat_id not in item["items"]:
                return  # no target for this id -> nothing to cascade
            version = item["version"]
            try:
                self._get_table().update_item(
                    Key=_BUDGETS_KEY,
                    # REMOVE drops one map key; SET bumps the version. The config item stays.
                    UpdateExpression="REMOVE #items.#id SET #v = :next",
                    ConditionExpression="attribute_exists(pk) AND #v = :expected",
                    ExpressionAttributeNames={"#items": "items", "#id": cat_id, "#v": "version"},
                    ExpressionAttributeValues={
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, "delete budget")
                # The version moved under us; loop re-reads and retries once.
        raise VersionConflictError("delete_budget: exhausted retries under write contention")

    def set_spread(self, cat_id: str, amount: Decimal, cycles: int, spread_from: str,
                   spread_len: int, spread_paydate: str) -> dict:
        """Record (upsert) a bill spread on a category's budget entry (WHIT-504): cover
        `amount` this cycle and take it back in equal slices over the next `cycles` cycles.
        The anchor is the current cycle start plus the pay cycle it was captured under, so a
        later cycle-config change is detectable (as with the rollover anchor).

        Preserves `target` via _merge_entry. The handler has already quantised `amount` to
        cents and enforced that a target exists and rollover is off — but that check is
        check-then-act, so this write strips any rollover fields in the SAME write: a
        category has rollover OR a spread, never both, even after a lost race (last writer
        wins; the mirror strip lives in set_budget). Raises VersionConflictError if it
        can't converge.
        """
        entry = self._merge_entry(cat_id, {
            "spread_amount": amount,
            "spread_cycles": Decimal(cycles),
            "spread_from": spread_from,
            "spread_len": Decimal(spread_len),
            "spread_paydate": spread_paydate,
        }, drop=_ROLLOVER_FIELDS)
        return {"id": cat_id, "amount": entry["spread_amount"], "cycles": cycles}

    def clear_rollover(self, cat_id: str) -> None:
        """Strip the rollover fields (see _ROLLOVER_FIELDS) from a category's budget entry,
        KEEPING its `target` — run when the category is reclassified out of a spend bucket
        (rollover is spend-only). Without this a stale carryover anchor lingers and, on a
        later move back to spend under the same pay cycle, `list_budgets` would re-fold every
        cycle since — inflating the buffer with money that was never budgeted (WHIT-474).

        The buffer itself is discarded: it is meaningless on an Income earn-target, and
        re-enabling rollover later starts fresh. No-op/lock semantics per _strip_fields.
        """
        self._strip_fields(cat_id, _ROLLOVER_FIELDS, "clear rollover")

    def clear_spread(self, cat_id: str) -> None:
        """Strip the bill-spread fields (see _SPREAD_FIELDS) from a category's budget entry,
        KEEPING its `target` and rollover fields — run when the user removes the spread, when
        a plan has run its course or been settled after a pay-cycle change (best-effort from
        the read path), and on a reclassify out of spend. No-op/lock semantics per _strip_fields.
        """
        self._strip_fields(cat_id, _SPREAD_FIELDS, "clear spread")

    def _strip_fields(self, cat_id: str, fields: tuple, operation: str) -> None:
        """Remove `fields` from ONE category's budget entry, keeping everything else.

        Idempotent no-op (no seed, no version bump) when the category has no budget entry or
        the entry carries none of `fields` — the common case, so a plain edit of an
        Income/Savings category is cheap. Writes the whole stripped entry back under the same
        optimistic-lock guard as set_budget, retrying once on a race. `operation` names the
        caller in the error it raises.
        """
        for _attempt in range(2):
            item = self._get_config()
            if item is None or cat_id not in item["items"]:
                return  # no budget for this id -> nothing to clear
            entry = item["items"][cat_id]
            stripped = {k: v for k, v in entry.items() if k not in fields}
            if stripped == entry:
                return  # none of the fields present -> no-op, don't bump the version
            version = item["version"]
            try:
                self._get_table().update_item(
                    Key=_BUDGETS_KEY,
                    # Rewrite ONE entry; SET bumps the version. Other ids untouched.
                    UpdateExpression="SET #items.#id = :val, #v = :next",
                    ConditionExpression="attribute_exists(pk) AND #v = :expected",
                    ExpressionAttributeNames={"#items": "items", "#id": cat_id, "#v": "version"},
                    ExpressionAttributeValues={
                        ":val": stripped,
                        ":expected": version,
                        ":next": version + Decimal(1),
                    },
                )
                return
            except ClientError as e:
                if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    handle_database_error(e, operation)
                # The version moved under us; loop re-reads and retries once.
        raise VersionConflictError(f"{operation}: exhausted retries under write contention")
