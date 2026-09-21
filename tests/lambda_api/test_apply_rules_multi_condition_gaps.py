"""WHIT-561 GAP tests for the "Apply my rules" sweep with multi-condition rules.

Complements test_apply_rules_multi_condition.py. Probes cross-feature seams:
  * a multi rule + budget_excluded (WHIT-558) -> the sweep sets the flag from the winning multi rule
  * two multi rules AGREEING on a category -> filed (not conflicted) end to end
  * two multi rules DISAGREEING -> conflicted, left unfiled (decide guard, through the sweep)
  * a direction=credit multi rule files a positive (income) charge
  * the inline "file this shop" path is still single-condition (mints no conditions)
"""

import json

from decimal import Decimal

from _feed_fakes import SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _multi_row(conditions, logic="all", category_id="transport", rule_id="m1",
               budget_excluded=False):
    first = conditions[0]
    return {"id": rule_id, "field": first["field"], "operator": first["operator"],
            "value": first["value"], "category_id": category_id,
            "conditions": conditions, "logic": logic, "budget_excluded": budget_excluded}


def _apply_event(body):
    return {"rawPath": "/transactions/uncategorized/apply-rules",
            "requestContext": {"http": {"method": "POST"}}, "body": json.dumps(body)}


def _call(handler, repo, rules, body, categories=frozenset({"transport", "groceries", "income"})):
    resp = handler.apply_rules_to_uncategorized(
        _apply_event(body), repo, FakeCategoryRepo(categories), FakeRuleRepo(rules=rules))
    return resp, json.loads(resp["body"])


def _stored(repo, txn_id="t1"):
    return repo._find_row(f"ACCOUNT#{SPENDING}", f"TXN#{txn_id}")


_UNDER_30 = [{"field": "merchant", "operator": "contains", "value": "uber"},
             {"field": "amount", "operator": "less_than", "value": "30"}]


def test_sweep_sets_budget_excluded_from_a_winning_multi_rule(handler):
    # [G-a1] WHIT-558 x WHIT-561: budget_excluded rides on the SAME write for a multi rule too. The
    # sweep reads the flag off the multi rule's client shape (rule_excluded_by_id keyed by its id).
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", merchant_name="UBER",
             amount=Decimal("-25.00"), category=None)]})
    _call(handler, repo, [_multi_row(_UNDER_30, budget_excluded=True)], {"dryRun": False})
    row = _stored(repo)
    assert row["category"] == "transport"
    assert row["budget_excluded"] is True


def test_sweep_multi_rule_without_flag_does_not_exclude(handler):
    # [G-a1b] FAIL-ON-REVERT companion: a multi rule with the flag off leaves budget_excluded unset.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", merchant_name="UBER",
             amount=Decimal("-25.00"), category=None)]})
    _call(handler, repo, [_multi_row(_UNDER_30, budget_excluded=False)], {"dryRun": False})
    assert "budget_excluded" not in _stored(repo)


def test_sweep_two_agreeing_multi_rules_file_the_charge(handler):
    # [G-a2] Two multi rules both -> "transport" agree, so decide resolves (len(categories)==1) and
    # the charge is filed. The multi conflict guard must NOT fire on agreement.
    a = _multi_row(_UNDER_30, category_id="transport", rule_id="a")
    b = _multi_row([{"field": "merchant", "operator": "contains", "value": "uber"},
                    {"field": "direction", "operator": "is", "value": "debit"}],
                   category_id="transport", rule_id="b")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", merchant_name="UBER",
             amount=Decimal("-25.00"), category=None)]})
    _resp, body = _call(handler, repo, [a, b], {"dryRun": False})
    assert _stored(repo)["category"] == "transport"
    assert len(body["filed"]) == 1


def test_sweep_two_disagreeing_multi_rules_leave_the_charge_unfiled(handler):
    # [G-a3] Two multi rules disagree (transport vs groceries) on one charge -> the decide guard
    # keeps it CONFLICTED, so the sweep files nothing and the charge stays unfiled.
    a = _multi_row(_UNDER_30, category_id="transport", rule_id="a")
    b = _multi_row([{"field": "merchant", "operator": "contains", "value": "uber"},
                    {"field": "direction", "operator": "is", "value": "debit"}],
                   category_id="groceries", rule_id="b")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", merchant_name="UBER",
             amount=Decimal("-25.00"), category=None)]})
    _resp, body = _call(handler, repo, [a, b], {"dryRun": False})
    assert _stored(repo).get("category") is None
    assert body["filed"] == []


def test_sweep_direction_credit_rule_files_an_income_charge(handler):
    # [G-a4] A `direction is credit -> income` multi rule files a POSITIVE (income) charge, and
    # leaves a spend (negative) charge alone.
    rule = _multi_row([{"field": "direction", "operator": "is", "value": "credit"}],
                      category_id="income", rule_id="c1")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "inc", description="SALARY", merchant_name="EMPLOYER",
             amount=Decimal("1500.00"), category=None),
        _row(SPENDING, "2026-07-01", "spend", description="UBER", merchant_name="UBER",
             amount=Decimal("-25.00"), category=None)]})
    _call(handler, repo, [rule], {"dryRun": False})
    assert _stored(repo, "inc")["category"] == "income"
    assert _stored(repo, "spend").get("category") is None


def test_inline_file_this_shop_is_still_single_condition(handler):
    # [G-a5] The merchant screen's "file this shop" path is untouched by WHIT-561: it mints a plain
    # `description contains` rule with NO conditions, even though the store now supports them.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="ALDI 1", category=None)]})
    rule_repo = FakeRuleRepo()
    body = {"dryRun": False, "rule": {"value": "ALDI", "categoryId": "groceries"}}
    handler.apply_rules_to_uncategorized(
        _apply_event(body), repo, FakeCategoryRepo(frozenset({"groceries"})), rule_repo)
    assert _stored(repo)["category"] == "groceries"
    assert len(rule_repo.minted) == 1
    assert "conditions" not in rule_repo.minted[0]      # single-condition, byte-identical to legacy
