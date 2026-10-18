"""Budget-target storage: per-category pay-cycle targets as a single DynamoDB
config item (separate from CATEGORIES so their optimistic-lock versions never
contend)."""

from decimal import Decimal
from typing import Optional

from repository_base import RepositoryBase, remove_map_entry, set_map_entry

_BUDGETS_KEY = {"pk": "BUDGETS", "sk": "BUDGETS"}

# The rollover-only fields on a budget entry (everything but `target`). Cleared when a
# category is reclassified out of a spend bucket (rollover is spend-only). Kept local.
_ROLLOVER_FIELDS = (
    "rollover", "carryover", "carryover_from", "carryover_len", "carryover_paydate", "carryover_history",
)


class BudgetRepository(RepositoryBase):
    """Stores per-category budget targets as a single DynamoDB config item.

    The item at pk=sk="BUDGETS" holds an `items` map (category id -> entry) plus a
    numeric `version` for optimistic locking. An entry is `{"target": Decimal}` plus,
    once a category opts into rollover (WHIT budget-rollover), the optional fields
    `rollover` (bool), `carryover` (signed Decimal buffer), `carryover_from` (ISO cycle
    start the buffer is sealed as of), `carryover_len`/`carryover_paydate` (the pay-cycle
    the buffer was sealed under, so a cycle-config change can re-anchor). All optional fields are absent on a legacy/plain budget and default to off/0. Kept separate from
    the CATEGORIES item on purpose: an independent version means budget writes and
    category edits never contend on the same lock. Unlike the taxonomy there is no
    server seed — a target exists only once the user sets one, so the map seeds
    empty. Setting a target is an idempotent upsert (set whether or not the id was
    already present), retrying once on a version race.
    """

    _config_key = _BUDGETS_KEY
    _config_label = "budgets"

    def list_budgets(self) -> dict:
        """Return the stored {category id -> {"target": Decimal}} map (empty before
        any target is set). The handler flattens it to the API's {id: number} shape.
        """
        item = self._read_seeded()
        return dict(item["items"])

    def _merge_entry(self, cat_id: str, fields: dict,
                     expected: Optional[dict] = None) -> Optional[dict]:
        """Read-modify-write ONE category entry: merge `fields` over the existing entry
        (or an empty one), and write the whole entry back under
        the optimistic-lock guard.

        Merge — not a per-field nested SET — for two reasons: it PRESERVES the entry's
        other fields (so an amount edit can't wipe a stored `carryover`/`rollover`, and a
        settle can't wipe `target`), and it works when the entry doesn't exist yet (a
        nested `SET #items.#id.#field` errors on a missing parent map, but `SET #items.#id
        = :val` is valid because the `items` map itself is always seeded). Retries once on a version race; raises
        VersionConflictError if it can't converge.

        Skipped (returns None) when `expected` is given and the saved entry no longer equals
        it, so a read-path settle never overwrites an edit made after the read. Re-checked on
        every attempt.
        """
        def build(item):
            if expected is not None and item["items"].get(cat_id) != expected:
                return None
            entry = {**item["items"].get(cat_id, {}), **fields}
            # SET the whole entry for ONE map key — never rewrites the other keys.
            return set_map_entry(cat_id, entry), {"id": cat_id, **entry}

        return self._versioned_update(build, action="set budget")

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
        """
        fields: dict = {"target": target}
        if rollover is not None:
            fields["rollover"] = rollover
        if anchor is not None:
            fields.update(anchor)
        entry = self._merge_entry(cat_id, fields)
        return {"id": cat_id, "target": entry["target"]}

    def settle_carryover(self, cat_id: str, carryover: Decimal, carryover_from: str,
                         carryover_len: int, carryover_paydate: str,
                         carryover_history: Optional[list] = None, *,
                         expected: Optional[dict] = None) -> Optional[dict]:
        """Persist a rollover category's sealed carryover balance + anchor (the write-on-read
        step of the /budgets settlement). Preserves `target`/`rollover` via _merge_entry.

        `carryover_history` (the sealed cycles, newest first, WHIT-742) is saved in the SAME
        write when given, so it can never disagree with the balance; when omitted (a
        re-anchor) the stored history is kept.

        Called best-effort from the read path: the caller swallows a VersionConflictError so
        a settle that loses the race never fails the GET — the balance simply re-seals on the
        next read (the displayed number is always recomputed live, not read from the store).
        Skipped (returns None) when `expected` is given and the saved entry no longer equals
        it, so a read-path settle never overwrites an edit made after the read.
        """
        fields = {
            "carryover": carryover,
            "carryover_from": carryover_from,
            "carryover_len": Decimal(carryover_len),
            "carryover_paydate": carryover_paydate,
        }
        if carryover_history is not None:
            fields["carryover_history"] = carryover_history
        return self._merge_entry(cat_id, fields, expected=expected)

    def delete_budget(self, cat_id: str) -> None:
        """Remove a category's budget target, if any — the cascade run when a
        category is deleted, so a stale target can't linger (and silently reappear
        if a same-slug category is later re-created).

        Idempotent no-op when the target is absent — the common case, since most
        categories never carry a budget — so it neither seeds the config item nor
        bumps the version in that case. When a target exists, REMOVE its map key
        under the same optimistic-lock guard as set_budget, retrying once on a race.
        """
        def build(item):
            if item is None or cat_id not in item["items"]:
                return None  # no target for this id -> nothing to cascade
            # REMOVE drops one map key; SET bumps the version. The config item stays.
            return remove_map_entry(cat_id), None

        self._versioned_update(build, action="delete budget", seed=False)

    def clear_rollover(self, cat_id: str) -> None:
        """Strip the rollover fields (see _ROLLOVER_FIELDS) from a category's budget entry,
        KEEPING its `target` — run when the category is reclassified out of a spend bucket
        (rollover is spend-only). Without this a stale carryover anchor lingers and, on a
        later move back to spend under the same pay cycle, `list_budgets` would re-fold every
        cycle since — inflating the buffer with money that was never budgeted (WHIT-474).

        The buffer itself is discarded: it is meaningless on an Income earn-target, and
        re-enabling rollover later starts fresh. A no-op (no seed, no version bump) when the
        category has no budget entry or carries no rollover fields; otherwise writes the stripped
        entry back under the same optimistic-lock guard as set_budget, retrying once on a race.
        """
        def build(item):
            if item is None or cat_id not in item["items"]:
                return None  # no budget for this id -> nothing to clear
            entry = item["items"][cat_id]
            stripped = {k: v for k, v in entry.items() if k not in _ROLLOVER_FIELDS}
            if stripped == entry:
                return None  # no rollover fields present -> no-op, don't bump the version
            return set_map_entry(cat_id, stripped), None

        self._versioned_update(build, action="clear rollover", seed=False)
