"""Goal storage: savings ("grow") and debt ("paydown") targets on an account, as a
single DynamoDB config item (WHIT-231). Mirrors BudgetRepository — a separate item at
pk=sk="GOALS" so goal writes never contend with the budget/category optimistic-lock
versions. Persistence only; all field validation lives in the handler."""

from typing import Optional

from repository_base import RepositoryBase, remove_map_entry, set_map_entry

_GOALS_KEY = {"pk": "GOALS", "sk": "GOALS"}


class GoalsRepository(RepositoryBase):
    """Stores the user's goals as a single DynamoDB config item.

    The item at pk=sk="GOALS" holds an `items` map (goal id -> the goal object) plus a
    numeric `version` for optimistic locking. Like budgets there is no server seed — the
    map seeds empty and a goal exists only once the user creates one. Saving a goal is an
    idempotent upsert of its own map key (a create and an edit are the same nested SET);
    deleting removes it. Both retry once on a version race, then raise VersionConflictError.
    """

    _config_key = _GOALS_KEY
    _config_label = "goals"

    def list_goals(self) -> dict:
        """Return the stored {goal id -> goal object} map (empty before any goal is
        created). The handler flattens it to a list of goal objects for the API."""
        item = self._read_seeded()
        return dict(item["items"])

    def upsert_goal(self, goal_id: str, goal: dict, start_candidate: Optional[dict] = None) -> dict:
        """Set (upsert) a goal under an optimistic-lock guard.

        Idempotent: succeeds whether or not the id already existed — a create and an edit
        are the same nested SET of one map key. `goal` is the already-validated object
        (Decimals + strings). Raises VersionConflictError if it can't converge within the
        retry budget.

        The immutable goal START (start_date + start_balance, WHIT-252) is carried forward:
        if the stored goal already has a start it wins (a later edit or balance update can
        never move it); otherwise `start_candidate` (the create-time pair, possibly empty
        for a synced goal not yet polled) is stamped. The pair moves together, so both
        fields always describe the same moment.

        The checkpoint ladder (WHIT-476) is carried forward too, but the INCOMING value wins
        whenever the writer sent one: an omitted `checkpoints` keeps the stored ladder, an
        explicit list replaces it, an explicit empty list clears it. Unlike the start, a
        provided value is not immutable — only omission is protected.

        Both merges are redone inside the retry loop against a fresh read, so a version race
        can't lose or duplicate either.
        """
        start_candidate = start_candidate or {}
        def build(item):
            existing = item["items"].get(goal_id)
            # Take the start as one atomic PAIR so both fields always describe the same
            # moment: keep the stored start only when BOTH keys are present (an already-frozen
            # start), else take the whole candidate (a create-time pair, or {} when a synced
            # goal isn't polled yet). A stray half-pair — only possible via external
            # corruption, never a code path here — is discarded, never split further.
            if existing and "start_date" in existing and "start_balance" in existing:
                start = {"start_date": existing["start_date"], "start_balance": existing["start_balance"]}
            else:
                start = dict(start_candidate)
            # Checkpoint ladder (WHIT-476, option B): the INCOMING value wins whenever the
            # writer sent one — a non-empty list replaces, an empty list clears. When the write
            # omits checkpoints entirely, keep whatever's stored, so a writer that doesn't know
            # about them (an old app build, a new code path) can't silently delete the ladder.
            if "checkpoints" in goal:
                ladder = goal["checkpoints"]
            elif existing:
                ladder = existing.get("checkpoints")
            else:
                ladder = None
            goal_to_write = {**goal, **start}
            goal_to_write.pop("checkpoints", None)
            if ladder:
                goal_to_write["checkpoints"] = ladder
            # Nested SET adds/overwrites ONE map key — never rewrites the whole map,
            # so two goals edited at once don't clobber each other's data.
            return set_map_entry(goal_id, goal_to_write), {"id": goal_id, **goal_to_write}

        return self._versioned_update(build, action="save goal")

    def delete_goal(self, goal_id: str) -> None:
        """Remove a goal, if present.

        Idempotent no-op when the goal is absent — neither seeds the config item nor
        bumps the version in that case. When it exists, REMOVE its map key under the
        same optimistic-lock guard as upsert_goal, retrying once on a race.
        """
        def build(item):
            if item is None or goal_id not in item["items"]:
                return None  # no goal for this id -> nothing to delete
            return remove_map_entry(goal_id), None

        self._versioned_update(build, action="delete goal", seed=False)
