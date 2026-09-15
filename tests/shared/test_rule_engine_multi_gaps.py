"""WHIT-561 (PR1) ADVERSARIAL gap tests for shared/rule_engine.py multi-condition matching.

Does NOT duplicate the implementer's WHIT-561 cases in tests/shared/test_rule_engine.py
(each primitive happy path, four comparators, non-numeric amount, merchant contains/equals,
account exact+case, direction both signs, logic all/any, disagreeing-multi->conflicted,
multi-vs-single, agreeing-multi files, valid-multi not skipped, unsupported pair skipped,
single==flat id, order-independent id, logic-sensitive id, 50==50.0 id, account case id)
nor the WHIT-527 gaps in test_rule_engine_gaps.py.

Locks the BOUNDARIES + type/whitespace canonicalisation + malformed-shape behaviour those
suites leave open. Uses the shared `rule_engine` fixture (tests/shared/conftest.py).
"""

from decimal import Decimal


def _cond(field, operator, value=None):
    return {"field": field, "operator": operator, "value": value}


def _multi(conditions, logic="all", category_id="groceries", rule_id="m1"):
    return {"id": rule_id, "conditions": conditions, "logic": logic, "categoryId": category_id}


def _rule(value, category_id="groceries", field="description", operator="contains", rule_id="r1"):
    return {"id": rule_id, "field": field, "operator": operator, "value": value,
            "categoryId": category_id}


def _charge(transaction_id="t1", description="COLES 1234 RICHMOND", category=None,
            amount=Decimal("-30.00"), account_id="acct-1"):
    charge = {"transaction_id": transaction_id, "description": description, "category": category,
              "amount": amount, "account_id": account_id, "pk": "ACCOUNT#a1",
              "sk": f"TXN#{transaction_id}"}
    return charge


def _is_unfiled(taxonomy):
    return lambda category: category != "income" and category not in taxonomy


# --- amount: the off-by-one boundary each comparator draws (magnitude 30, limit 30) ------
# The implementer proved <= "30" and >= "30" match and > "30" does not. The open edges are
# < "30" (must NOT match — the strict-less boundary) and >= "30" as the mirror of > "30".


def test_amount_strict_less_than_is_false_at_exact_equal_magnitude(rule_engine):
    # [G20] |−30| < 30 is False — the off-by-one the implementer's < test (30 vs 40) never pins.
    charge = _charge(amount=Decimal("-30.00"))
    assert not rule_engine.rule_matches(_multi([_cond("amount", "<", "30")]), charge)
    assert rule_engine.rule_matches(_multi([_cond("amount", "<", "30.01")]), charge)


def test_amount_strict_greater_than_is_false_at_exact_equal_magnitude(rule_engine):
    # [G21] |−30| > 30 is False; >= 30 True. Pins the pair the implementer split across values.
    charge = _charge(amount=Decimal("-30.00"))
    assert not rule_engine.rule_matches(_multi([_cond("amount", ">", "30")]), charge)
    assert rule_engine.rule_matches(_multi([_cond("amount", ">=", "30")]), charge)


def test_amount_value_zero_is_a_valid_limit_not_treated_as_empty(rule_engine):
    # [G22] "0" is a real numeric limit: > 0 matches any non-zero magnitude, < 0 matches nothing,
    # and the rule is NOT skipped as "empty rule value" (Decimal("0") is not None).
    charge = _charge(amount=Decimal("-30.00"))
    assert rule_engine.rule_matches(_multi([_cond("amount", ">", "0")]), charge)
    assert not rule_engine.rule_matches(_multi([_cond("amount", "<", "0")]), charge)
    plan = rule_engine.plan_rule_application(
        [_multi([_cond("amount", ">", "0")])], [charge], _is_unfiled({"groceries"}))
    assert plan["skipped_rules"] == []
    assert len(plan["matched"]) == 1


def test_amount_matches_on_magnitude_so_a_positive_refund_still_matches(rule_engine):
    # [G23] amount ignores sign (matches MAGNITUDE): a +30 refund matches "< 40" just like a −30
    # spend. Callers who mean "only spend" must AND a direction:is_debit condition.
    refund = _charge(amount=Decimal("30.00"))
    assert rule_engine.rule_matches(_multi([_cond("amount", "<", "40")]), refund)
    both = _multi([_cond("amount", "<", "40"), _cond("direction", "is_debit")], logic="all")
    assert not rule_engine.rule_matches(both, refund)


def test_amount_value_with_surrounding_whitespace_is_accepted_but_broken_decimal_is_not(rule_engine):
    # [G24] Decimal() strips surrounding whitespace, so " 40 " is a valid limit; ". 0" (internal
    # space) is not a number -> the condition is False and the rule is skipped as empty.
    charge = _charge(amount=Decimal("-30.00"))
    assert rule_engine.rule_matches(_multi([_cond("amount", "<", " 40 ")]), charge)
    assert not rule_engine.rule_matches(_multi([_cond("amount", "<", ". 0")]), charge)
    plan = rule_engine.plan_rule_application(
        [_multi([_cond("amount", "<", ". 0")], rule_id="bad")], [charge], _is_unfiled({"groceries"}))
    assert plan["skipped_rules"] == [{"id": "bad", "value": None, "reason": "empty rule value"}]


def test_amount_same_numeric_across_value_types_shares_id_and_match(rule_engine):
    # [G25] int 40, float 40.0, str "40" and Decimal("40") canonicalise to the same amount, so
    # equal rules SHARE an id (dedup key) AND match identically. Widens the implementer's
    # str-only "50"=="50.0".
    ids = {rule_engine.rule_id_for(conditions=[_cond("amount", "<", v)])
           for v in (40, 40.0, "40", Decimal("40"))}
    assert len(ids) == 1
    charge = _charge(amount=Decimal("-30.00"))
    for v in (40, 40.0, "40", Decimal("40")):
        assert rule_engine.rule_matches(_multi([_cond("amount", "<", v)]), charge)


# --- direction: valueless, sign boundary --------------------------------------


def test_direction_ignores_a_stray_value_in_both_matching_and_skip_and_id(rule_engine):
    # [G26] direction carries its meaning in the operator; a stray non-null value must be ignored
    # by matching, NOT flagged "empty rule value" by _skip_reason, and NOT change the id (valueless
    # canonicalisation). Otherwise a client bug that leaks a value would fork the dedup key.
    spend = _charge(amount=Decimal("-30.00"))
    assert rule_engine.rule_matches(_multi([_cond("direction", "is_debit", "junk")]), spend)
    plan = rule_engine.plan_rule_application(
        [_multi([_cond("direction", "is_debit", "junk")])], [spend], _is_unfiled({"groceries"}))
    assert plan["skipped_rules"] == []
    assert (rule_engine.rule_id_for(conditions=[_cond("direction", "is_debit", "junk")])
            == rule_engine.rule_id_for(conditions=[_cond("direction", "is_debit")]))


def test_direction_zero_amount_is_credit_not_debit(rule_engine):
    # [G27] The sign boundary: amount 0 -> is_credit True (>= 0), is_debit False (< 0).
    zero = _charge(amount=Decimal("0"))
    assert rule_engine.rule_matches(_multi([_cond("direction", "is_credit")]), zero)
    assert not rule_engine.rule_matches(_multi([_cond("direction", "is_debit")]), zero)


# --- account: whitespace trim + missing field ---------------------------------


def test_account_value_is_trimmed_both_in_match_and_in_id(rule_engine):
    # [G28] account is trimmed (but case-preserving) on both sides: " acct-1 " matches "acct-1"
    # and shares its id, so a stray space in the stored rule can't fork the dedup key or miss.
    assert rule_engine.rule_matches(_multi([_cond("account", "equals", " acct-1 ")]), _charge())
    assert (rule_engine.rule_id_for(conditions=[_cond("account", "equals", " acct-1 ")])
            == rule_engine.rule_id_for(conditions=[_cond("account", "equals", "acct-1")]))


def test_account_condition_with_missing_charge_account_id_does_not_crash_or_false_match(rule_engine):
    # [G29] A charge without account_id must not crash and must not match an account rule.
    charge = _charge()
    del charge["account_id"]
    assert not rule_engine.rule_matches(_multi([_cond("account", "equals", "acct-1")]), charge)


# --- merchant vs description on one charge; merchant/equals uses _normalise not fold ------


def test_description_and_merchant_conditions_both_target_the_description(rule_engine):
    # [G30] Both fields read the charge DESCRIPTION, so an AND of one description + one merchant
    # condition is satisfiable by a single description containing both tokens.
    rule = _multi([_cond("description", "contains", "coles"),
                   _cond("merchant", "contains", "richmond")], logic="all")
    assert rule_engine.rule_matches(rule, _charge(description="COLES 1234 RICHMOND"))
    assert not rule_engine.rule_matches(rule, _charge(description="COLES 1234 FITZROY"))


def test_merchant_equals_uses_normalise_and_does_not_collapse_internal_whitespace(rule_engine):
    # [G31] FAIL-ON-REVERT: merchant/equals normalises (trim+lower) but must NOT collapse internal
    # whitespace (that is `fold`, the dedup latitude). A single-spaced value must not equal a
    # double-spaced description, or equals would silently match text it doesn't literally hold.
    charge = _charge(description="COLES  ONLINE")   # double space
    assert rule_engine.rule_matches(_multi([_cond("merchant", "equals", "coles  online")]), charge)
    assert not rule_engine.rule_matches(_multi([_cond("merchant", "equals", "coles online")]), charge)


# --- rule id stability edges --------------------------------------------------


def test_single_element_conditions_list_id_ignores_logic(rule_engine):
    # [G32] IMPORTANT id-stability edge: a one-condition rule hashes the flat recipe REGARDLESS of
    # logic, so logic="any" on a single condition must not fork the id away from the legacy flat id
    # (else the same rule authored two ways lands on two rows).
    flat = rule_engine.rule_id_for("description", "contains", "COLES")
    assert rule_engine.rule_id_for(conditions=[_cond("description", "contains", "COLES")],
                                   logic="any") == flat == "e199355ab3c7aab5"
    assert rule_engine.rule_id_for(conditions=[_cond("description", "contains", "COLES")],
                                   logic="all") == flat


def test_duplicate_identical_conditions_give_a_stable_id_and_match_like_the_single(rule_engine):
    # [G33] Two byte-identical conditions is a degenerate multi (len==2 -> multi id path). The id
    # must be deterministic across calls, and matching (AND of a condition with itself) equals the
    # single condition's match. It is NOT expected to equal the single-condition id (len differs).
    dup = [_cond("merchant", "contains", "coles"), _cond("merchant", "contains", "coles")]
    id_a = rule_engine.rule_id_for(conditions=dup)
    id_b = rule_engine.rule_id_for(conditions=list(dup))
    assert id_a == id_b
    assert id_a != rule_engine.rule_id_for("merchant", "contains", "coles")
    assert rule_engine.rule_matches(_multi(dup), _charge(description="COLES 1"))
    assert not rule_engine.rule_matches(_multi(dup), _charge(description="ALDI 1"))


# --- _conditions_of: empty list + flat-vs-conditions precedence ----------------


def test_empty_conditions_list_never_matches_and_is_skipped(rule_engine):
    # [G34] CHARACTERISATION: conditions=[] is falsy, so _conditions_of falls back to the legacy
    # flat (all-None) condition -> rule_matches False, and _skip_reason reports "unsupported rule
    # type" (the None field/operator pair), NOT "empty rule value". Pins the actual reason so a
    # refactor that changes it is caught.
    empty = {"id": "empty", "conditions": [], "logic": "all", "categoryId": "groceries"}
    assert not rule_engine.rule_matches(empty, _charge())
    plan = rule_engine.plan_rule_application([empty], [_charge()], _is_unfiled({"groceries"}))
    assert plan["skipped_rules"] == [{"id": "empty", "value": None, "reason": "unsupported rule type"}]


def test_conditions_list_wins_over_legacy_flat_fields_on_the_same_rule(rule_engine):
    # [G35] When a rule carries BOTH a non-empty conditions list AND legacy flat fields, the
    # conditions list is authoritative — the flat fields are ignored.
    rule = {"id": "mixed", "field": "description", "operator": "contains", "value": "woolworths",
            "conditions": [_cond("merchant", "contains", "coles")], "logic": "all",
            "categoryId": "groceries"}
    assert rule_engine.rule_matches(rule, _charge(description="COLES 1"))       # conditions win
    assert not rule_engine.rule_matches(rule, _charge(description="WOOLWORTHS 1"))  # flat ignored


# --- decide: multi present but all AGREE resolves on the fast path -------------


def test_multiple_multi_rules_that_agree_file_the_charge_not_conflicted(rule_engine):
    # [G36] The multi-condition conflict guard only fires on DISAGREEMENT (>1 category). Two
    # agreeing multi rules plus a single all naming one category resolve on the fast path and FILE
    # — multi presence alone does not force conflicted.
    multi_a = _multi([_cond("merchant", "contains", "coles"), _cond("amount", "<", "100")],
                     category_id="groceries", rule_id="a")
    multi_b = _multi([_cond("direction", "is_debit"), _cond("amount", ">", "0")],
                     category_id="groceries", rule_id="b")
    single = _rule("coles", category_id="groceries", rule_id="s")
    charge = _charge(description="COLES 1", amount=Decimal("-30.00"))
    resolved, indices, categories = rule_engine.decide([multi_a, multi_b, single], charge)
    assert resolved == "groceries"
    assert set(indices) == {0, 1, 2}
    assert categories == {"groceries"}


# --- plan_rule_application end-to-end with a multi rule (value is None) --------


def test_plan_with_a_multi_rule_reports_none_value_without_crashing(rule_engine):
    # [G37] A multi rule has no flat "value" key, so plan reads .get("value") -> None in both
    # by_rule and (when skipped) skipped_rules. Confirm the end-to-end shape: it files, stamps the
    # winning rule id, and the by_rule row carries value=None with the real count — no crash, no
    # KeyError on categoryId.
    rule = _multi([_cond("merchant", "contains", "coles"), _cond("amount", "<", "100")],
                  category_id="groceries", rule_id="m-1")
    rows = [_charge("t1", "COLES 1"), _charge("t2", "COLES 2")]
    plan = rule_engine.plan_rule_application([rule], rows, _is_unfiled({"groceries"}))
    assert [rid for _, _, rid in plan["matched"]] == ["m-1", "m-1"]
    assert plan["by_category"] == {"groceries": 2}
    assert plan["by_rule"] == [
        {"ruleId": "m-1", "value": None, "categoryId": "groceries", "count": 2,
         "samples": ["COLES 1", "COLES 2"]}]


def test_direction_condition_with_a_missing_amount_does_not_crash_or_match(rule_engine):
    # [G38] A direction rule against a charge whose amount is missing/unparseable must not crash
    # (Decimal coercion returns None) and must not match either sign.
    charge = _charge()
    del charge["amount"]
    assert not rule_engine.rule_matches(_multi([_cond("direction", "is_debit")]), charge)
    assert not rule_engine.rule_matches(_multi([_cond("direction", "is_credit")]), charge)
