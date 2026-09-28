"""WHIT-623 slice 1 QA — one rule-ID calculation, on the paths test_rule_book.py doesn't drive.

test_rule_book.py pins create_rule. Here: update_rule (an identity edit MOVES the row to a new id)
on the real RuleRepository over FakeTable and on FakeRuleRepo, and the empty-conditions edge.
"""

import pytest

from _rule_fakes import FakeRuleRepo

COLES_AND_GROCERY = [
    {"field": "description", "operator": "contains", "value": "COLES"},
    {"field": "description", "operator": "contains", "value": "grocery"},
]


def test_empty_conditions_list_falls_back_to_the_legacy_id(shared):
    # [A10] An app that sends `conditions: []` must not mint a different id from the flat rule.
    import rule_engine

    assert (rule_engine.rule_identity("description", "contains", "COLES", [], "all")
            == rule_engine.rule_id_for("description", "contains", "COLES"))


@pytest.mark.parametrize("conditions, logic", [
    (None, None),
    (COLES_AND_GROCERY, "all"),
    (COLES_AND_GROCERY, "any"),
])
def test_update_moves_to_the_same_id_in_the_store_the_fake_and_the_engine(
        shared, rule_repo, conditions, logic):
    # [A11] Edit a WOOLWORTHS rule to the given identity; the moved row's id must agree everywhere.
    import rule_engine

    expected = rule_engine.rule_identity("description", "contains", "COLES", conditions, logic)
    saved, _ = rule_repo.create_rule("description", "contains", "WOOLWORTHS", "groceries")
    fake = FakeRuleRepo()
    faked, _ = fake.create_rule("description", "contains", "WOOLWORTHS", "groceries")

    moved = rule_repo.update_rule(saved["id"], "description", "contains", "COLES", "groceries",
                                  conditions=conditions, logic=logic)
    fake_moved = fake.update_rule(faked["id"], "description", "contains", "COLES", "groceries",
                                  conditions=conditions, logic=logic)

    assert moved["id"] == expected
    assert fake_moved["id"] == expected
    assert [row["id"] for row in rule_repo.list_rules()] == [expected]
