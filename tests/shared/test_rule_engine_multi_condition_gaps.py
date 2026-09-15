"""WHIT-561 GAP tests (adversarial) for shared/rule_engine.py multi-condition matching + decide.

Complements test_rule_engine_multi_condition.py (the implementer's happy path). Probes:
  * category-equals (raw enum) inside an AND alongside amount
  * decide when two multi rules AGREE -> resolves cleanly (guard only fires on DISAGREEMENT)
  * decide when a multi and a single AGREE -> resolves (agreement short-circuits before the guard)
  * _skip_reason over conditions: unsupported field/operator, deleted category, no category
  * direction on a ZERO-amount charge matches neither debit nor credit
  * OR (any) short-circuit when the FIRST condition is unsupported
"""

from decimal import Decimal


def _txn(description="UBER TRIP", merchant_name="UBER", amount=Decimal("-25.00"),
         account_id="acct-1", category=None):
    return {"transaction_id": "t1", "description": description, "merchant_name": merchant_name,
            "amount": amount, "account_id": account_id, "category": category}


def _multi(conditions, logic="all", category_id="transport", rule_id="m1"):
    first = conditions[0]
    return {"id": rule_id, "categoryId": category_id, "conditions": conditions, "logic": logic,
            "field": first["field"], "operator": first["operator"], "value": first["value"]}


# --- category-equals (raw enum) alongside amount, inside one AND ------------------------------


def test_category_equals_and_amount_match_together(rule_engine):
    # [G-eng1] A rule made outside the app can carry a raw-enum `category equals FOOD_AND_DRINK`
    # AND `amount < 30`. Both must hold. The category field folds/normalises like other text.
    rule = _multi([{"field": "category", "operator": "equals", "value": "FOOD_AND_DRINK"},
                   {"field": "amount", "operator": "less_than", "value": "30"}], "all",
                  category_id="groceries")
    assert rule_engine.rule_matches(rule, _txn(category="food_and_drink", amount=Decimal("-25.00")))
    # amount misses -> whole AND fails
    assert not rule_engine.rule_matches(rule, _txn(category="food_and_drink", amount=Decimal("-40.00")))
    # category misses -> whole AND fails
    assert not rule_engine.rule_matches(rule, _txn(category="transport", amount=Decimal("-25.00")))


# --- decide: agreement resolves; only a DISAGREEMENT with a multi is conflicted ---------------


def test_decide_two_multi_rules_agreeing_resolve_cleanly(rule_engine):
    # [G-eng2] The `any(conditions)` conflict guard is reached ONLY when the matched categories
    # DISAGREE (len > 1). Two multi rules that both name "food" agree -> one category -> filed,
    # NOT dropped as conflicted. FAIL-ON-REVERT: if the guard were hoisted above the
    # len(categories)<=1 check, agreeing multis would wrongly resolve to None.
    a = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                {"field": "amount", "operator": "less_than", "value": "30"}],
               category_id="food", rule_id="a")
    b = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                {"field": "direction", "operator": "is", "value": "debit"}],
               category_id="food", rule_id="b")
    resolved, matched, categories = rule_engine.decide([a, b], _txn(amount=Decimal("-25.00")))
    assert resolved == "food"
    assert matched == [0, 1]
    assert categories == {"food"}


def test_decide_multi_and_single_agreeing_resolve_cleanly(rule_engine):
    # [G-eng3] A single "uber -> food" and a multi "uber AND under $30 -> food" AGREE. len==1,
    # so decide resolves before the specificity ranking (and before the multi guard) -> "food".
    single = {"id": "s1", "categoryId": "food", "field": "merchant",
              "operator": "contains", "value": "uber"}
    multi = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                    {"field": "amount", "operator": "less_than", "value": "30"}],
                   category_id="food", rule_id="m1")
    resolved, _matched, categories = rule_engine.decide([single, multi], _txn(amount=Decimal("-25.00")))
    assert resolved == "food"
    assert categories == {"food"}


# --- _skip_reason walks every condition -------------------------------------------------------


def _unfiled_none(_category):        # nothing is "unfiled" -> category check passes
    return False


def test_skip_reason_flags_an_unsupported_condition_in_a_multi_rule(rule_engine):
    # [G-eng4] One good condition + one with a field the engine can't evaluate -> the whole rule
    # is skipped as unsupported (never silently matches nothing).
    rule = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                   {"field": "postcode", "operator": "equals", "value": "3000"}])
    assert rule_engine._skip_reason(rule, _unfiled_none) == "unsupported rule type"


def test_skip_reason_flags_a_bad_operator_for_a_field(rule_engine):
    # [G-eng4b] amount only supports less_than/greater_than; `equals` on amount is unsupported.
    rule = _multi([{"field": "amount", "operator": "equals", "value": "30"}])
    assert rule_engine._skip_reason(rule, _unfiled_none) == "unsupported rule type"


def test_skip_reason_flags_a_deleted_category_on_a_multi_rule(rule_engine):
    # [G-eng5] A valid multi rule whose target category no longer exists -> skipped, so the sweep
    # can't file a charge to a dead category (which would leave it unfiled and re-file forever).
    rule = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                   {"field": "amount", "operator": "less_than", "value": "30"}],
                  category_id="ghost")
    assert rule_engine._skip_reason(rule, lambda c: c == "ghost") == "category no longer exists"


def test_skip_reason_flags_a_multi_rule_with_no_category(rule_engine):
    # [G-eng5b] categoryId missing -> distinct "rule has no category" reason.
    rule = {"id": "m1", "conditions": [{"field": "merchant", "operator": "contains", "value": "uber"},
                                       {"field": "amount", "operator": "less_than", "value": "30"}],
            "logic": "all"}
    assert rule_engine._skip_reason(rule, _unfiled_none) == "rule has no category"


def test_skip_reason_empty_text_condition_in_a_multi_rule(rule_engine):
    # [G-eng6] A text condition whose value normalises to empty -> "empty rule value" (would match
    # nothing / everything). amount + direction carry no text value and are exempt.
    rule = _multi([{"field": "merchant", "operator": "contains", "value": "   "},
                   {"field": "amount", "operator": "less_than", "value": "30"}])
    assert rule_engine._skip_reason(rule, _unfiled_none) == "empty rule value"


# --- direction edges --------------------------------------------------------------------------


def test_direction_zero_amount_matches_neither(rule_engine):
    # [G-eng7] A $0.00 charge is neither debit (<0) nor credit (>0).
    debit = _multi([{"field": "direction", "operator": "is", "value": "debit"}])
    credit = _multi([{"field": "direction", "operator": "is", "value": "credit"}])
    assert not rule_engine.rule_matches(debit, _txn(amount=Decimal("0")))
    assert not rule_engine.rule_matches(credit, _txn(amount=Decimal("0")))


def test_any_logic_ignores_an_unsupported_condition_but_matches_on_a_good_one(rule_engine):
    # [G-eng8] Under OR, an unsupported condition is just False (rule_matches), so a good sibling
    # still fires. (skip_reason would still flag the rule; this isolates the matcher's own OR.)
    rule = _multi([{"field": "postcode", "operator": "equals", "value": "3000"},
                   {"field": "merchant", "operator": "equals", "value": "uber"}], logic="any")
    assert rule_engine.rule_matches(rule, _txn(merchant_name="UBER"))
    assert not rule_engine.rule_matches(rule, _txn(merchant_name="LYFT"))
