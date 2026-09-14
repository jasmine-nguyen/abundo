"""WHIT-535 — regression guard for the DELETED conditionCount skip branch in rule_engine._skip_reason.

The guard `if rule.get("conditionCount", 1) != 1: return "rule has more than one condition"` was
removed (our store only ever held single-leaf rules, and the foreign multi-condition rule it
defended against left with the BankSync proxy). These pin the INVERSE of the deleted
test_repository/test_rule_engine multi-condition-skip test: a rule that STILL carries
conditionCount != 1 (e.g. a row written before this change, or a stray field) is now APPLIED,
not skipped. Re-introducing the branch turns these red.

Uses the standalone `rule_engine` fixture (tests/shared/conftest.py).
"""


def _rule(value, category_id="groceries", field="description", operator="contains",
          rule_id="r1", **extra):
    rule = {"id": rule_id, "field": field, "operator": operator, "value": value,
            "categoryId": category_id}
    rule.update(extra)
    return rule


def _txn(transaction_id, description="COLES 1234 RICHMOND", category=None):
    return {"transaction_id": transaction_id, "description": description, "category": category,
            "pk": "ACCOUNT#a1", "sk": f"TXN#{transaction_id}"}


def _is_unfiled(taxonomy):
    return lambda category: category != "income" and category not in taxonomy


def test_skip_reason_ignores_conditionCount(rule_engine):
    # FAIL-ON-REVERT: with the deleted branch back, conditionCount=5 would return
    # "rule has more than one condition" instead of None.
    rule = _rule("coles", conditionCount=5)
    assert rule_engine._skip_reason(rule, _is_unfiled({"groceries"})) is None


def test_multi_condition_rule_is_now_applied_not_skipped(rule_engine):
    # The inverse of the removed multi-condition-skip test: a conditionCount!=1 rule fed to
    # plan_rule_application now FILES its matches rather than landing in skipped_rules.
    rule = _rule("coles", rule_id="multi", conditionCount=3)
    plan = rule_engine.plan_rule_application(
        [rule], [_txn("t1", "COLES 55 RICHMOND")], _is_unfiled({"groceries"}))

    assert plan["skipped_rules"] == []
    assert [c for _, c, _ in plan["matched"]] == ["groceries"]


def test_conditionCount_zero_is_also_applied(rule_engine):
    # The old guard fired on ANY value != 1 (including 0). Pin that 0 no longer skips either.
    rule = _rule("coles", rule_id="zero", conditionCount=0)
    assert rule_engine._skip_reason(rule, _is_unfiled({"groceries"})) is None
