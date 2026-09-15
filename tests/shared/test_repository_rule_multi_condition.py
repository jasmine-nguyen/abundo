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
