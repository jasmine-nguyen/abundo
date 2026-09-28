"""WHIT-623 — the server's one rule book module, shared/rule_book.py.

Slice 1: one converter (`rule_from_row`, saved rule row → the matcher's shape) and one rule-ID
calculation (`rule_engine.rule_identity`). Driven with the real RuleRepository over FakeTable, so
the rows converted are exactly what the store saves.
"""

import importlib
import sys
from decimal import Decimal

import pytest

from _rule_fakes import FakeRuleRepo

COLES_AND_GROCERY = [
    {"field": "description", "operator": "contains", "value": "COLES"},
    {"field": "description", "operator": "contains", "value": "grocery"},
]


@pytest.fixture
def rule_book(shared):
    sys.modules.pop("rule_book", None)
    module = importlib.import_module("rule_book")
    try:
        yield module
    finally:
        sys.modules.pop("rule_book", None)


def test_every_saved_rule_field_reaches_the_matcher_including_spread_seeded(rule_book, rule_repo):
    # FAIL-ON-REVERT: dropping spread_seeded is how the old converters drifted apart.
    created, _ = rule_repo.create_rule(
        "description", "contains", "COLES", "groceries", budget_excluded=True,
        conditions=COLES_AND_GROCERY, logic="AND",
        spread=True, spread_amount=Decimal("42.50"), spread_gap_days=30,
    )
    rule_repo.mark_spread_seeded(created["id"])
    [row] = rule_repo.list_rules()

    assert rule_book.rule_from_row(row) == {
        "id": created["id"],
        "field": "description",
        "operator": "contains",
        "value": "COLES",
        "categoryId": "groceries",
        "budgetExcluded": True,
        "spread": True,
        "spreadSeeded": True,
        "spreadAmount": Decimal("42.50"),
        "spreadGapDays": 30,
        "conditions": COLES_AND_GROCERY,
        "logic": "AND",
    }


@pytest.mark.parametrize("conditions, logic", [
    (None, None),
    ([{"field": "description", "operator": "contains", "value": "COLES"}], "AND"),
    (COLES_AND_GROCERY, "AND"),
    (COLES_AND_GROCERY, "OR"),
])
def test_store_fake_and_engine_agree_on_one_rule_id(shared, rule_repo, conditions, logic):
    import rule_engine

    expected = rule_engine.rule_identity("description", "contains", "COLES", conditions, logic)
    saved, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries",
                                     conditions=conditions, logic=logic)
    faked, _ = FakeRuleRepo().create_rule("description", "contains", "COLES", "groceries",
                                          conditions=conditions, logic=logic)

    assert saved["id"] == expected
    assert faked["id"] == expected
    # A 1-condition rule keeps its legacy single-condition id.
    if conditions is None or len(conditions) == 1:
        assert expected == rule_engine.rule_id_for("description", "contains", "COLES")
