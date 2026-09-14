"""WHIT-535 — the webhook rule-filing path tolerates pre-WHIT-535 stored rule rows.

rule_ingest._to_engine_rule maps a stored row to the engine shape reading only id/field/operator/
value/category_id, and the conditionCount skip branch is gone from rule_engine. So a legacy row
that STILL carries banksync_enrichment_ids / imported_at / source="banksync" / conditionCount!=1
(written before this change, never rewritten) must still FILE its charges — proving the "no data
migration" claim on the webhook side too.

Driven through the webhook `lam` fixture (tests/lambda/conftest.py), like test_rule_ingest.py.
"""


class _FakeRuleStore:
    """Minimal RuleRepository stand-in over snake_case rows (preserves every seeded key)."""

    def __init__(self, rules):
        self._rules = [dict(rule) for rule in rules]

    def list_rules(self):
        return [dict(rule) for rule in self._rules]


class _FakeCategoryRepo:
    def __init__(self, ids):
        self._ids = list(ids)

    def list_categories(self):
        return [{"id": cid} for cid in self._ids]


def _legacy_row(value="COLES", category_id="groceries"):
    return {"id": "rule-legacy", "field": "description", "operator": "contains",
            "value": value, "category_id": category_id, "source": "banksync",
            "imported_at": "2026-07-02T00:00:00+00:00",
            "banksync_enrichment_ids": ["enr_1", "enr_2"], "conditionCount": 4}


def _charge(txn_id="t1", description="COLES 55 RICHMOND", category=None):
    return {"transaction_id": txn_id, "account_id": "up-spending", "description": description,
            "category": category, "counts_to_budget": True}


def test_legacy_row_with_retired_fields_still_files(lam):
    # FAIL-ON-REVERT for _to_engine_rule's tolerance: a mapper that passed the row through unchanged
    # (or choked on the extra keys) would let the retired conditionCount=4 reach the engine, which —
    # if the deleted skip branch were also restored — would skip this row and leave it unfiled. The
    # mapper dropping the retired fields is what keeps a legacy row filing; that is what reddens.
    # (The conditionCount guard itself is pinned directly in
    # tests/shared/test_rule_engine_conditioncount_removed.py.)
    charge = _charge(category=None)
    lam.rule_ingest.apply(
        [charge], rule_repo=_FakeRuleStore([_legacy_row("COLES")]),
        category_repo=_FakeCategoryRepo(["groceries"]))
    assert charge["category"] == "groceries"
