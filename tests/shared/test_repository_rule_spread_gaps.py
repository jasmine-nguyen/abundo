"""WHIT-559 GAPS — RuleRepository spread-field storage seams the impl suite left uncovered.

tests/shared/test_repository_rule.py pins store/non-spread/clash/arm/preserve-dismissed/shed/
text-move-rearm. The shed test, though, sheds from a FRESHLY-created rule (spread_seeded already
False). This suite adds:

  * turning spread OFF strips a spread_seeded that is actually True (a plan that WAS created) — the
    real "user turned spreading off after it seeded" case, proving the DynamoDB REMOVE fires on a
    present-True field, not just an absent one;
  * re-creating an IDENTICAL spread rule is idempotent (created=False, one row) and does NOT re-arm
    a spread_seeded the store already holds True;
  * a same-id edit of a spread rule keeps budget_excluded independent of the spread toggle.

Uses the shared conftest `rule_repo` fixture as the sibling suite does.
"""

from decimal import Decimal


def _make(rule_repo, value="COLES", category="groceries", field="description",
          operator="contains", **kwargs):
    return rule_repo.create_rule(field, operator, value, category, **kwargs)


def test_turning_spread_off_removes_a_true_seeded_marker(rule_repo):
    # FAIL-ON-REVERT: a rule whose plan was already created carries spread_seeded True. Editing it
    # to spread:false must REMOVE that field (not leave a stale True). Drop spread_seeded from the
    # REMOVE list in _update_in_place's else-branch and this reddens.
    rule, _ = _make(rule_repo, spread=True, spread_amount=Decimal("42.50"), spread_gap_days=30)
    seeded = {**rule_repo.get_rule(rule["id"]), "spread_seeded": True}
    rule_repo._table.put_item(Item=seeded)   # the apply path created the plan

    rule_repo.update_rule(rule["id"], "description", "contains", "COLES", "groceries", spread=False)

    stored = rule_repo.get_rule(rule["id"])
    assert stored["spread"] is False
    assert "spread_seeded" not in stored
    assert "spread_amount" not in stored and "spread_gap_days" not in stored


def test_recreating_an_identical_spread_rule_is_idempotent_and_does_not_rearm(rule_repo):
    # Same text + category + spread flag -> the existing row, created=False. The store must NOT
    # re-write (so must NOT re-arm spread_seeded to False) a plan the user already dismissed.
    rule, created_first = _make(rule_repo, spread=True,
                                spread_amount=Decimal("42.50"), spread_gap_days=30)
    seeded = {**rule_repo.get_rule(rule["id"]), "spread_seeded": True}
    rule_repo._table.put_item(Item=seeded)

    again, created_second = _make(rule_repo, spread=True,
                                  spread_amount=Decimal("42.50"), spread_gap_days=30)

    assert created_first is True and created_second is False
    assert len(rule_repo.list_rules()) == 1
    assert rule_repo.get_rule(rule["id"])["spread_seeded"] is True   # not re-armed


def test_budget_excluded_survives_a_same_id_spread_toggle(rule_repo):
    rule, _ = _make(rule_repo, budget_excluded=True)
    updated = rule_repo.update_rule(rule["id"], "description", "contains", "COLES", "groceries",
                                    budget_excluded=True, spread=True,
                                    spread_amount=Decimal("80.00"), spread_gap_days=14)
    assert updated["budget_excluded"] is True and updated["spread"] is True
    stored = rule_repo.get_rule(rule["id"])
    assert stored["budget_excluded"] is True and stored["spread"] is True
