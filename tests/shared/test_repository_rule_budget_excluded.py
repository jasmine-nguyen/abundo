"""WHIT-558: a rule carries an optional budget_excluded action.

Run against the conftest FakeTable-backed rule_repo (same as test_repository_rule.py), so the
persist, the dedup id and the clash guard are exercised for real. budget_excluded is NOT part of
the rule id (the id stays the rule text) but IS a clash dimension: two same-text/same-category
rules that disagree on the flag must clash, because a charge they both match would fight over
whether it is kept out of the budget.
"""

import pytest


def _make(rule_repo, value="COLES", category="groceries", **kwargs):
    return rule_repo.create_rule("description", "contains", value, category, **kwargs)


def test_create_persists_budget_excluded_and_round_trips(rule_repo):
    rule, created = _make(rule_repo, budget_excluded=True)
    assert created is True
    assert rule["budget_excluded"] is True
    assert rule_repo.get_rule(rule["id"])["budget_excluded"] is True
    assert rule_repo.list_rules()[0]["budget_excluded"] is True


def test_create_defaults_budget_excluded_false(rule_repo):
    rule, _ = _make(rule_repo)
    assert rule["budget_excluded"] is False
    assert rule_repo.get_rule(rule["id"])["budget_excluded"] is False


def test_same_text_same_category_same_flag_is_one_row(rule_repo):
    first, created_first = _make(rule_repo, budget_excluded=True)
    second, created_second = _make(rule_repo, budget_excluded=True)
    assert created_first is True and created_second is False
    assert second["id"] == first["id"]
    assert len(rule_repo.list_rules()) == 1


def test_same_text_same_category_different_flag_clashes(rule_repo):
    # FAIL-ON-REVERT for the new clash dimension: drop
    # `bool(existing.get("budget_excluded")) != budget_excluded` from create_rule's clash test and
    # the second create returns created=False (silently keeping the first's flag) instead of clashing.
    from repository_errors import RuleClashError
    first, _ = _make(rule_repo, budget_excluded=False)
    with pytest.raises(RuleClashError) as excinfo:
        _make(rule_repo, budget_excluded=True)
    assert excinfo.value.existing["id"] == first["id"]
    assert len(rule_repo.list_rules()) == 1


def test_budget_excluded_is_not_part_of_the_id(rule_repo):
    # The id is the rule TEXT only (rule_id_for), so toggling the flag can only ever collide with the
    # same text, never mint a second row.
    import rule_engine
    first, _ = _make(rule_repo, budget_excluded=False)
    assert first["id"] == rule_engine.rule_id_for("description", "contains", "COLES")


def test_update_in_place_toggles_the_flag(rule_repo):
    created, _ = _make(rule_repo, budget_excluded=False)
    # Same text + same category, only the flag changes -> an in-place update.
    updated = rule_repo.update_rule(created["id"], "description", "contains", "COLES", "groceries",
                                    budget_excluded=True)
    assert updated["budget_excluded"] is True
    assert rule_repo.get_rule(created["id"])["budget_excluded"] is True
    rule_repo.update_rule(created["id"], "description", "contains", "COLES", "groceries",
                          budget_excluded=False)
    assert rule_repo.get_rule(created["id"])["budget_excluded"] is False
