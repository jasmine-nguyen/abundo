"""Shared fake for the RuleRepository store (WHIT-531).

The apply-rules suites (test_apply_rules.py and its _gaps / _inline_rule / _inline_rule_gaps
siblings) used to monkeypatch handler.list_rules / handler.create_rule (the BankSync proxy).
WHIT-531 repointed the sweep, the clash guard and the inline mint at our own RuleRepository, so
those suites drive this in-memory stand-in instead — passed in as the handler's rule_repo.

It models RuleRepository FAITHFULLY, in the store's own SNAKE_CASE row shape (`category_id`, not
`categoryId`): the handler maps store rows to the client shape at its boundary, and a camelCase
fake would hide a bug in that mapper. Ids come from rule_engine.rule_id_for so they match
production, and create_rule reproduces the real dedup/clash contract.

Imports the shared layer LAZILY (inside the methods), never at module scope: the fakes-invariants
[G2] guard forbids a shared-layer import at top level, and this keeps the module importable with
no shared/ dir on the path (same pattern as _feed_fakes.WritableFeedRepo's deferred import).
Registered in the `rule` domain of test_fakes_invariants.py.
"""


def _identity(rule_engine, field, operator, value, conditions, logic):
    """The rule id — mirrors repository_rule._rule_identity: the canonical multi-condition hash when
    `conditions` is present (a 1-condition list collapses to the legacy id), else the legacy hash."""
    if conditions:
        return rule_engine.rule_id_for_conditions(conditions, logic)
    return rule_engine.rule_id_for(field, operator, value)


class FakeRuleRepo:
    """In-memory RuleRepository stand-in: list/get/create/update/delete, snake_case store rows."""

    def __init__(self, rules=(), *, list_error=False, create_error=False,
                 update_error=False, delete_error=False):
        # Seed "existing rules" keyed by rule id (the real store's database-key dedup). A seed row
        # may omit its id — compute it the same way the store does so ids stay consistent.
        self._rows = {}
        for rule in rules:
            row = dict(rule)
            if row.get("id") is None:
                import rule_engine
                row["id"] = rule_engine.rule_id_for(row["field"], row["operator"], row["value"])
            self._rows[row["id"]] = row
        self.list_error = list_error
        self.create_error = create_error
        self.update_error = update_error
        self.delete_error = delete_error
        self.minted = []  # rows create_rule actually WROTE (a dedup hit does not append)
        self.updated = []  # rows update_rule returned (in-place or moved)
        self.deleted = []  # rule ids delete_rule (and a text-move update) removed
        self.list_calls = 0

    def list_rules(self):
        self.list_calls += 1
        if self.list_error:
            from repository import DatabaseError
            raise DatabaseError("rules read failed")
        return [dict(row) for row in self._rows.values()]

    def create_rule(self, field, operator, value, category_id, budget_excluded=False,
                    conditions=None, logic=None):
        if self.create_error:
            from repository import DatabaseError
            raise DatabaseError("rule write failed")
        import rule_engine
        rule_id = _identity(rule_engine, field, operator, value, conditions, logic)
        existing = self._rows.get(rule_id)
        if existing is not None:
            # Same identity: idempotent on same category + same budget_excluded (return it,
            # created=False), a clash when EITHER differs — exactly the store's contract (safe to
            # run twice, WHIT-497; the budget flag is a clash dimension, WHIT-558).
            if (existing.get("category_id") != category_id
                    or bool(existing.get("budget_excluded")) != budget_excluded):
                from repository import RuleClashError
                raise RuleClashError(existing)
            return dict(existing), False
        row = {
            "id": rule_id, "field": field, "operator": operator, "value": value,
            "category_id": category_id, "budget_excluded": budget_excluded, "source": "app",
        }
        if conditions:
            row["conditions"] = conditions
            row["logic"] = logic or "all"
        self._rows[rule_id] = row
        self.minted.append(dict(row))
        return dict(row), True

    def get_rule(self, rule_id):
        row = self._rows.get(rule_id)
        return dict(row) if row is not None else None

    def update_rule(self, rule_id, field, operator, value, category_id, budget_excluded=False,
                    conditions=None, logic=None):
        # Faithful to RuleRepository.update_rule: unknown id -> RuleNotFoundError; the id IS the
        # rule's identity, so an id-preserving edit updates in place while an identity edit MOVES the
        # row to a new id (deleting the old); a move onto another rule's identity -> RuleClashError.
        if self.update_error:
            from repository import DatabaseError
            raise DatabaseError("rule update failed")
        import rule_engine
        from repository import RuleClashError, RuleNotFoundError
        existing = self._rows.get(rule_id)
        if existing is None:
            raise RuleNotFoundError(rule_id)

        new_id = _identity(rule_engine, field, operator, value, conditions, logic)
        if new_id == rule_id:
            existing["value"] = value
            existing["category_id"] = category_id
            existing["budget_excluded"] = budget_excluded
            if conditions:
                existing["conditions"] = conditions
                existing["logic"] = logic or "all"
            self.updated.append(dict(existing))
            return dict(existing)

        clash = self._rows.get(new_id)
        if clash is not None:
            raise RuleClashError(clash)

        new_row = {**existing, "id": new_id, "field": field, "operator": operator,
                   "value": value, "category_id": category_id, "budget_excluded": budget_excluded}
        if conditions:
            new_row["conditions"] = conditions
            new_row["logic"] = logic or "all"
        self._rows[new_id] = new_row
        del self._rows[rule_id]
        self.updated.append(dict(new_row))
        self.deleted.append(rule_id)
        return dict(new_row)

    def delete_rule(self, rule_id):
        # Unguarded delete: a no-op on a missing id, so it is safe to run twice (the store's
        # idempotent-delete contract). The import script's guarded delete is not modelled here.
        if self.delete_error:
            from repository import DatabaseError
            raise DatabaseError("rule delete failed")
        self._rows.pop(rule_id, None)
        self.deleted.append(rule_id)
