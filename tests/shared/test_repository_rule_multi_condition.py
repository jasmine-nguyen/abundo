"""WHIT-561: the rule store round-trips multi-condition rules (conditions + logic), keys them by
the canonical order-independent id, and clashes on a differing category — while single-condition
rules stay byte-identical to before. Run against the conftest FakeTable-backed rule_repo."""

import pytest


def _conditions():
    return [{"field": "merchant", "operator": "contains", "value": "uber"},
            {"field": "amount", "operator": "less_than", "value": "30"}]


def test_create_multi_condition_rule_round_trips(rule_repo):
    import rule_engine
    rule, created = rule_repo.create_rule("merchant", "contains", "uber", "transport",
                                          conditions=_conditions(), logic="all")
    assert created is True
    assert rule["conditions"] == _conditions()
    assert rule["logic"] == "all"
    assert rule["id"] == rule_engine.rule_id_for_conditions(_conditions(), "all")
    stored = rule_repo.get_rule(rule["id"])
    assert stored["conditions"] == _conditions() and stored["logic"] == "all"


def test_single_condition_create_stores_no_conditions(rule_repo):
    # FAIL-ON-REVERT for back-compat: a plain rule must not sprout conditions/logic, so old rows and
    # simple rules stay byte-identical (and keep the legacy id).
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    assert "conditions" not in rule and "logic" not in rule


def test_multi_condition_clash_on_a_different_category(rule_repo):
    from repository_errors import RuleClashError
    rule_repo.create_rule("merchant", "contains", "uber", "transport",
                          conditions=_conditions(), logic="all")
    with pytest.raises(RuleClashError):
        rule_repo.create_rule("merchant", "contains", "uber", "food",
                              conditions=_conditions(), logic="all")
    assert len(rule_repo.list_rules()) == 1


def test_order_independent_id_dedups_the_same_conditions(rule_repo):
    forward = _conditions()
    reversed_conditions = list(reversed(_conditions()))
    rule_repo.create_rule("merchant", "contains", "uber", "transport",
                          conditions=forward, logic="all")
    _rule, created = rule_repo.create_rule("amount", "less_than", "30", "transport",
                                           conditions=reversed_conditions, logic="all")
    assert created is False                       # same canonical id -> dedup, not a second row
    assert len(rule_repo.list_rules()) == 1


def test_in_place_edit_of_a_multi_rule_preserves_its_conditions(rule_repo):
    # An in-place edit (same conditions -> same id, only the target category changes) must RE-WRITE
    # conditions/logic on the row, not drop them. FAIL-ON-REVERT: if _update_in_place stopped SETting
    # conditions on a multi rule, the stored row would keep the OLD category but could lose its
    # conditions, and decide's multi-rule guard would then read a lying (single-shaped) row.
    created, _ = rule_repo.create_rule("merchant", "contains", "uber", "transport",
                                       conditions=_conditions(), logic="all")
    rule_id = created["id"]
    updated = rule_repo.update_rule(rule_id, "merchant", "contains", "uber", "groceries",
                                    conditions=_conditions(), logic="all")
    assert updated["id"] == rule_id                         # in place: id unchanged
    assert updated["category_id"] == "groceries"
    assert updated["conditions"] == _conditions() and updated["logic"] == "all"
    stored = rule_repo.get_rule(rule_id)
    assert stored["conditions"] == _conditions() and stored["logic"] == "all"
    assert stored["category_id"] == "groceries"
    assert len(rule_repo.list_rules()) == 1                 # still one row, not a new id
