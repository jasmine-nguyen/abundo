"""WHIT-559 GAPS — RuleRepository smooth-field storage seams the impl suite left uncovered.

tests/shared/test_repository_rule.py pins store/non-smooth/clash/arm/preserve-dismissed/shed/
text-move-rearm. The shed test, though, sheds from a FRESHLY-created rule (smooth_seeded already
False). This suite adds:

  * turning smooth OFF strips a smooth_seeded that is actually True (a plan that WAS created) — the
    real "user turned smoothing off after it seeded" case, proving the DynamoDB REMOVE fires on a
    present-True field, not just an absent one;
  * re-creating an IDENTICAL smooth rule is idempotent (created=False, one row) and does NOT re-arm
    a smooth_seeded the store already holds True;
  * a same-id edit of a smooth rule keeps budget_excluded independent of the smooth toggle.

Uses the shared conftest `rule_repo` fixture as the sibling suite does.
"""

from decimal import Decimal


def _make(rule_repo, value="COLES", category="groceries", field="description",
          operator="contains", **kwargs):
    return rule_repo.create_rule(field, operator, value, category, **kwargs)


def test_turning_smooth_off_removes_a_true_seeded_marker(rule_repo):
    # FAIL-ON-REVERT: a rule whose plan was already created carries smooth_seeded True. Editing it
    # to smooth:false must REMOVE that field (not leave a stale True). Drop smooth_seeded from the
    # REMOVE list in _update_in_place's else-branch and this reddens.
    rule, _ = _make(rule_repo, smooth=True, smooth_amount=Decimal("42.50"), smooth_gap_days=30)
    seeded = {**rule_repo.get_rule(rule["id"]), "smooth_seeded": True}
    rule_repo._table.put_item(Item=seeded)   # the apply path created the plan

    rule_repo.update_rule(rule["id"], "description", "contains", "COLES", "groceries", smooth=False)

    stored = rule_repo.get_rule(rule["id"])
    assert stored["smooth"] is False
    assert "smooth_seeded" not in stored
    assert "smooth_amount" not in stored and "smooth_gap_days" not in stored


def test_recreating_an_identical_smooth_rule_is_idempotent_and_does_not_rearm(rule_repo):
    # Same text + category + smooth flag -> the existing row, created=False. The store must NOT
    # re-write (so must NOT re-arm smooth_seeded to False) a plan the user already dismissed.
    rule, created_first = _make(rule_repo, smooth=True,
                                smooth_amount=Decimal("42.50"), smooth_gap_days=30)
    seeded = {**rule_repo.get_rule(rule["id"]), "smooth_seeded": True}
    rule_repo._table.put_item(Item=seeded)

    again, created_second = _make(rule_repo, smooth=True,
                                  smooth_amount=Decimal("42.50"), smooth_gap_days=30)

    assert created_first is True and created_second is False
    assert len(rule_repo.list_rules()) == 1
    assert rule_repo.get_rule(rule["id"])["smooth_seeded"] is True   # not re-armed


def test_budget_excluded_survives_a_same_id_smooth_toggle(rule_repo):
    rule, _ = _make(rule_repo, budget_excluded=True)
    updated = rule_repo.update_rule(rule["id"], "description", "contains", "COLES", "groceries",
                                    budget_excluded=True, smooth=True,
                                    smooth_amount=Decimal("80.00"), smooth_gap_days=14)
    assert updated["budget_excluded"] is True and updated["smooth"] is True
    stored = rule_repo.get_rule(rule["id"])
    assert stored["budget_excluded"] is True and stored["smooth"] is True
