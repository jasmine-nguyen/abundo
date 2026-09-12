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


class FakeRuleRepo:
    """In-memory RuleRepository stand-in: list_rules + create_rule, snake_case store rows."""

    def __init__(self, rules=(), *, list_error=False, create_error=False):
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
        self.minted = []  # rows create_rule actually WROTE (a dedup hit does not append)
        self.list_calls = 0

    def list_rules(self):
        self.list_calls += 1
        if self.list_error:
            from repository import DatabaseError
            raise DatabaseError("rules read failed")
        return [dict(row) for row in self._rows.values()]

    def create_rule(self, field, operator, value, category_id, *, source="app",
                    imported_at=None, banksync_enrichment_ids=None):
        if self.create_error:
            from repository import DatabaseError
            raise DatabaseError("rule write failed")
        import rule_engine
        rule_id = rule_engine.rule_id_for(field, operator, value)
        existing = self._rows.get(rule_id)
        if existing is not None:
            # Same text: idempotent on same category (return it, created=False), a clash on a
            # different one — exactly the store's contract (safe to run twice, WHIT-497).
            if existing.get("category_id") != category_id:
                from repository import RuleClashError
                raise RuleClashError(existing)
            return dict(existing), False
        row = {
            "id": rule_id, "field": field, "operator": operator, "value": value,
            "category_id": category_id, "source": source,
        }
        if imported_at:
            row["imported_at"] = imported_at
        if banksync_enrichment_ids:
            row["banksync_enrichment_ids"] = list(banksync_enrichment_ids)
        self._rows[rule_id] = row
        self.minted.append(dict(row))
        return dict(row), True
