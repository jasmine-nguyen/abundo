"""WHIT-561: multi-condition rule matching (conditions + AND/OR) and the new match fields
(amount / merchant / account / direction), plus the load-bearing identity guarantees.

The single most important property: an existing SINGLE-condition rule keeps its exact id, so no
charge stamped `filed_by_rule=<id>` orphans. These lock that, the condition combination, the new
per-field primitives, and that `decide` never mis-files a disagreement involving a multi rule.
"""

import hashlib

from decimal import Decimal


def _txn(description="UBER TRIP", merchant_name="UBER", amount=Decimal("-25.00"),
         account_id="acct-1", category=None):
    return {"transaction_id": "t1", "description": description, "merchant_name": merchant_name,
            "amount": amount, "account_id": account_id, "category": category}


def _multi(conditions, logic="all", category_id="transport", rule_id="m1"):
    # Mirror how the store + mappers shape a multi rule: the flat field/operator/value carry the
    # FIRST condition (so a legacy reader has a shape), alongside conditions/logic. `decide` must
    # ignore those flat fields for a multi rule — this shape is what makes that guard load-bearing.
    first = conditions[0]
    return {"id": rule_id, "categoryId": category_id, "conditions": conditions, "logic": logic,
            "field": first["field"], "operator": first["operator"], "value": first["value"]}


# --- identity: existing single-condition ids are byte-stable (no history orphan) --------------


def test_rule_id_for_keeps_the_legacy_format(rule_engine):
    # FAIL-ON-REVERT against re-keying: the id is sha256("field|operator|folded value")[:16].
    # Change that input format and every existing rule (+ its filed_by_rule stamps) orphans.
    expected = hashlib.sha256("description|contains|coles".encode("utf-8")).hexdigest()[:16]
    assert rule_engine.rule_id_for("description", "contains", "COLES") == expected


def test_single_condition_collapses_to_the_legacy_id(rule_engine):
    # A 1-condition rule (built the new way) MUST hash to the exact legacy id, so it dedups against
    # the existing flat rule and keeps its history. FAIL-ON-REVERT: drop the len==1 collapse and a
    # one-condition rule gets a brand-new id, orphaning every charge it filed.
    legacy = rule_engine.rule_id_for("description", "contains", "COLES")
    collapsed = rule_engine.rule_id_for_conditions(
        [{"field": "description", "operator": "contains", "value": "COLES"}], "all")
    assert collapsed == legacy


def test_multi_condition_id_is_order_independent(rule_engine):
    a = {"field": "merchant", "operator": "contains", "value": "UBER"}
    b = {"field": "amount", "operator": "less_than", "value": "30"}
    assert (rule_engine.rule_id_for_conditions([a, b], "all")
            == rule_engine.rule_id_for_conditions([b, a], "all"))


def test_multi_condition_id_differs_by_logic_and_from_single(rule_engine):
    a = {"field": "merchant", "operator": "contains", "value": "UBER"}
    b = {"field": "amount", "operator": "less_than", "value": "30"}
    assert (rule_engine.rule_id_for_conditions([a, b], "all")
            != rule_engine.rule_id_for_conditions([a, b], "any"))
    # A multi id can never collide with a single-condition (legacy) id.
    assert (rule_engine.rule_id_for_conditions([a, b], "all")
            != rule_engine.rule_id_for("merchant", "contains", "UBER"))


# --- combination: AND / OR --------------------------------------------------------------------


def test_all_logic_requires_every_condition(rule_engine):
    rule = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                   {"field": "amount", "operator": "less_than", "value": "30"}], "all")
    assert rule_engine.rule_matches(rule, _txn(amount=Decimal("-25.00")))     # both hold
    assert not rule_engine.rule_matches(rule, _txn(amount=Decimal("-40.00")))  # amount fails


def test_any_logic_needs_only_one(rule_engine):
    rule = _multi([{"field": "merchant", "operator": "equals", "value": "uber"},
                   {"field": "amount", "operator": "greater_than", "value": "1000"}], "any")
    # merchant matches the raw description (WHIT-561 follow-up), so equals compares to it.
    assert rule_engine.rule_matches(rule, _txn(description="UBER", amount=Decimal("-25.00")))
    assert not rule_engine.rule_matches(rule, _txn(description="LYFT", amount=Decimal("-25.00")))


# --- the new per-field primitives -------------------------------------------------------------


def test_amount_matches_on_magnitude_not_sign(rule_engine):
    under = _multi([{"field": "amount", "operator": "less_than", "value": "30"}])
    assert rule_engine.rule_matches(under, _txn(amount=Decimal("-25.00")))   # spend stored negative
    assert not rule_engine.rule_matches(under, _txn(amount=Decimal("-30.00")))  # strict <
    over = _multi([{"field": "amount", "operator": "greater_than", "value": "30"}])
    assert rule_engine.rule_matches(over, _txn(amount=Decimal("-40.00")))


def test_amount_fails_closed_on_bad_or_missing_value(rule_engine):
    rule = _multi([{"field": "amount", "operator": "less_than", "value": "not-a-number"}])
    assert not rule_engine.rule_matches(rule, _txn(amount=Decimal("-25.00")))
    missing_amount = _multi([{"field": "amount", "operator": "less_than", "value": "30"}])
    assert not rule_engine.rule_matches(missing_amount, {"description": "x"})  # no amount key


def test_direction_debit_and_credit(rule_engine):
    debit = _multi([{"field": "direction", "operator": "is", "value": "debit"}])
    assert rule_engine.rule_matches(debit, _txn(amount=Decimal("-25.00")))
    assert not rule_engine.rule_matches(debit, _txn(amount=Decimal("25.00")))
    credit = _multi([{"field": "direction", "operator": "is", "value": "credit"}])
    assert rule_engine.rule_matches(credit, _txn(amount=Decimal("25.00")))


def test_merchant_and_account_fields(rule_engine):
    # merchant matches the raw description (WHIT-561 follow-up), not the cleaned merchant_name.
    merchant = _multi([{"field": "merchant", "operator": "equals", "value": "uber"}])
    assert rule_engine.rule_matches(merchant, _txn(description="UBER"))
    assert not rule_engine.rule_matches(merchant, _txn(description="UBER EATS"))  # equals, not contains
    account = _multi([{"field": "account", "operator": "equals", "value": "acct-1"}])
    assert rule_engine.rule_matches(account, _txn(account_id="acct-1"))
    assert not rule_engine.rule_matches(account, _txn(account_id="acct-2"))


# --- decide: a disagreement involving a multi rule is conflicted, never mis-filed -------------


def test_decide_conflicts_when_a_multi_rule_disagrees(rule_engine):
    # A single "uber -> transport" and a multi "uber AND under $30 -> food" both match a $25 UBER.
    # They disagree; the multi rule can't be ranked by single-value specificity -> conflicted (None),
    # never silently filed. FAIL-ON-REVERT: drop the `any(conditions)` guard in decide and this
    # could resolve to a wrong category.
    single = {"id": "s1", "categoryId": "transport", "field": "merchant",
              "operator": "contains", "value": "uber"}
    multi = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                    {"field": "amount", "operator": "less_than", "value": "30"}],
                   category_id="food", rule_id="m1")
    resolved, _matched, categories = rule_engine.decide([single, multi], _txn(amount=Decimal("-25.00")))
    assert resolved is None
    assert categories == {"transport", "food"}


def test_decide_does_not_let_a_specific_single_rule_dominate_a_multi_rule(rule_engine):
    # THE guard case: a multi rule "merchant contains uber AND under $30 -> food" is stored with its
    # flat value = the first condition ("uber"). A single "merchant contains uber express ->
    # transport" is MORE specific by containment. Without the `any(conditions)` guard, decide would
    # rank them by that single value and wrongly file the charge to transport. With it, the presence
    # of a multi rule in a disagreement -> conflicted (None). FAIL-ON-REVERT: drop the guard -> this
    # resolves to "transport" instead of None.
    multi = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                    {"field": "amount", "operator": "less_than", "value": "30"}],
                   category_id="food", rule_id="m1")
    specific_single = {"id": "s1", "categoryId": "transport", "field": "merchant",
                       "operator": "contains", "value": "uber express"}
    charge = _txn(description="UBER EXPRESS", amount=Decimal("-25.00"))
    resolved, _matched, _categories = rule_engine.decide([multi, specific_single], charge)
    assert resolved is None


def test_decide_files_a_lone_multi_rule(rule_engine):
    multi = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                    {"field": "amount", "operator": "less_than", "value": "30"}], category_id="food")
    resolved, matched, _categories = rule_engine.decide([multi], _txn(amount=Decimal("-25.00")))
    assert resolved == "food"
    assert matched == [0]


# --- WHIT-561 follow-up: merchant matches the raw description; amount <= / >= --------------------


def test_merchant_matches_the_raw_description_not_the_cleaned_merchant_name(rule_engine):
    # merchant is a friendlier label for the raw description (the field every other rule matches
    # and the one stable across pending/posted). It must READ description and IGNORE merchant_name.
    rule = _multi([{"field": "merchant", "operator": "contains", "value": "coles"}])
    # description holds the value, merchant_name does not -> matches (reads description).
    assert rule_engine.rule_matches(rule, _txn(description="COLES 123", merchant_name="WOOLIES"))
    # merchant_name holds it, description does not -> does NOT match.
    # FAIL-ON-REVERT: matching merchant_name (the old behaviour) makes this wrongly True.
    assert not rule_engine.rule_matches(rule, _txn(description="WOOLIES 456", merchant_name="COLES"))


def test_amount_or_equal_operators_include_the_exact_boundary(rule_engine):
    at_30 = _txn(amount=Decimal("-30.00"))
    lte = _multi([{"field": "amount", "operator": "less_than_or_equal", "value": "30"}])
    gte = _multi([{"field": "amount", "operator": "greater_than_or_equal", "value": "30"}])
    # FAIL-ON-REVERT: <= / >= match AT the exact magnitude (the strict forms, tested elsewhere, do not).
    assert rule_engine.rule_matches(lte, at_30)
    assert rule_engine.rule_matches(gte, at_30)
    # and away from the boundary they behave like the strict forms
    assert rule_engine.rule_matches(lte, _txn(amount=Decimal("-20.00")))
    assert not rule_engine.rule_matches(lte, _txn(amount=Decimal("-40.00")))
    assert rule_engine.rule_matches(gte, _txn(amount=Decimal("-40.00")))
    assert not rule_engine.rule_matches(gte, _txn(amount=Decimal("-20.00")))
