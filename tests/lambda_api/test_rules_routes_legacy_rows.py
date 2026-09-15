"""WHIT-535 — "no data migration" safety: a rule row written BEFORE the import-ledger deletion
still carries banksync_enrichment_ids / imported_at / source (and maybe a stray conditionCount).
_rule_to_client and GET /rules must read it back WITHOUT error and map it to the clean client
shape, dropping the retired fields — so no rewrite of existing DynamoDB rows is needed.

Sibling to test_rules_routes.py / _gaps.py; reuses their handler fixture + FakeRuleRepo (which
preserves arbitrary seeded keys via dict(rule), so a legacy row survives the round trip faithfully).

The DIRECT _rule_to_client projection is already pinned by
test_apply_rules_repoint_gaps.py::test_rule_to_client_maps_a_full_store_row_to_exactly_the_client_shape
(exact-dict ==, so any leaked key reddens it); this file adds only the END-TO-END GET /rules
round trip over a legacy row.
"""

import json

from _feed_fakes import FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


_CLIENT_KEYS = {"id", "field", "operator", "value", "categoryId", "budgetExcluded", "conditions", "logic"}


def _legacy_row(value="COLES", category_id="groceries"):
    """A pre-WHIT-535 stored row: the current fields PLUS the retired import metadata."""
    return {
        "id": None, "field": "description", "operator": "contains",
        "value": value, "category_id": category_id, "source": "banksync",
        "imported_at": "2026-07-02T00:00:00+00:00",
        "banksync_enrichment_ids": ["enr_1", "enr_2"],
        "conditionCount": 1,
    }


def _event(method, path):
    return {"rawPath": path, "requestContext": {"http": {"method": method}}}


def _inject(handler, monkeypatch, rule_repo):
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(("groceries",)))


def test_get_rules_maps_a_legacy_row_to_the_clean_shape(handler, monkeypatch):
    # End to end through GET /rules: a legacy row reads back fine and clean.
    _inject(handler, monkeypatch, FakeRuleRepo(rules=[_legacy_row("COLES")]))

    resp = handler.lambda_handler(_event("GET", "/rules"), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert len(body) == 1
    assert set(body[0]) == _CLIENT_KEYS
    assert body[0]["value"] == "COLES" and body[0]["categoryId"] == "groceries"
