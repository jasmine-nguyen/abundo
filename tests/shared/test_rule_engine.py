"""Tests for shared/rule_engine.py — the pure "which charges would my rules file?" logic.

The matching is LITERAL (what BankSync would do with the same leaf rule), not the client's fuzzy
merchant-similarity sweep. These lock the predicate, the conflict rule, and the two properties the
whole feature rests on: only unfiled charges are eligible, and filing one removes it from the
unfiled set (so a second run files nothing new).
"""

import pathlib
from decimal import Decimal

import pytest
from _ast_bindings import _top_level_binding_list
from _rule_pairs import PAIR_VALUE, RULE_PAIRS

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHARED_DIR = ROOT / "shared"
_RULE_VOCAB_NAMES = {"RULE_FIELD_OPERATORS", "RULE_FIELDS", "RULE_OPERATORS", "RULE_LOGIC",
                     "RULE_DIRECTIONS", "_FIELD_OPERATORS", "_LOGIC"}


def _rule(value, category_id="groceries", field="description", operator="contains", rule_id="r1"):
    return {"id": rule_id, "field": field, "operator": operator, "value": value,
            "categoryId": category_id}


def _txn(transaction_id="t1", description="COLES 1234 RICHMOND", category=None,
         amount=Decimal("-25.00"), account_id="acct-1", merchant_name=None):
    return {"transaction_id": transaction_id, "description": description, "category": category,
            "amount": amount, "account_id": account_id, "merchant_name": merchant_name,
            "pk": "ACCOUNT#a1", "sk": f"TXN#{transaction_id}"}


def _multi(conditions, logic="all", category_id="transport", rule_id="m1"):
    # Mirror how the store + mappers shape a multi rule: the flat field/operator/value carry the
    # FIRST condition (so a legacy reader has a shape), alongside conditions/logic. `decide` must
    # ignore those flat fields for a multi rule — this shape is what makes that guard load-bearing.
    first = conditions[0]
    return {"id": rule_id, "categoryId": category_id, "conditions": conditions, "logic": logic,
            "field": first["field"], "operator": first["operator"], "value": first["value"]}


def _is_unfiled(taxonomy):
    """The handler's predicate: unfiled = not income and not a real category id."""
    return lambda category: category != "income" and category not in taxonomy


# --- description contains -----------------------------------------------------


def test_description_contains_is_case_insensitive(rule_engine):
    assert rule_engine.rule_matches(_rule("coles"), _txn("t1", "COLES 1234 RICHMOND"))
    assert rule_engine.rule_matches(_rule("COLES"), _txn("t1", "coles 1234 richmond"))


def test_description_contains_keeps_punctuation_so_it_cannot_over_match(rule_engine):
    # FAIL-ON-REVERT: stripping non-alphanumerics (the client's normaliseMatch) turns
    # NICOLE'S CAFE into "nicolescafe", which contains "coles". It must not match.
    assert not rule_engine.rule_matches(_rule("coles"), _txn("t1", "NICOLE'S CAFE"))
    assert rule_engine.rule_matches(_rule("kkv international"), _txn("t2", "KKV INTERNATIONAL PTY"))


def test_rule_value_is_trimmed_but_internal_spacing_is_respected(rule_engine):
    assert rule_engine.rule_matches(_rule("  coles  "), _txn("t1", "COLES 1234"))
    assert rule_engine.rule_matches(_rule("coles  online"), _txn("t2", "COLES  ONLINE"))
    # FAIL-ON-REVERT for using trim+lower rather than the whitespace-COLLAPSING fold: with
    # collapsing, this single-spaced value would match a double-spaced description — text the
    # rule does not literally contain.
    assert not rule_engine.rule_matches(_rule("coles online"), _txn("t3", "COLES  ONLINE"))


def test_empty_or_whitespace_rule_value_matches_nothing(rule_engine):
    assert not rule_engine.rule_matches(_rule(""), _txn("t1"))
    assert not rule_engine.rule_matches(_rule("   "), _txn("t1"))


def test_missing_description_does_not_crash(rule_engine):
    assert not rule_engine.rule_matches(_rule("coles"), {"transaction_id": "t1"})


# --- category equals ----------------------------------------------------------


def test_category_equals_matches_a_raw_enum_exactly(rule_engine):
    rule = _rule("FOOD_AND_DRINK", field="category", operator="equals")
    assert rule_engine.rule_matches(rule, _txn("t1", category="FOOD_AND_DRINK"))
    assert not rule_engine.rule_matches(rule, _txn("t2", category="TRANSPORT"))


# --- the plan: eligibility, conflicts, skipped rules --------------------------


def test_only_unfiled_charges_are_eligible(rule_engine):
    taxonomy = {"groceries", "coffee"}
    rows = [
        _txn("unfiled", "COLES 1", category=None),
        _txn("filed", "COLES 2", category="coffee"),      # already filed -> ineligible
        _txn("income", "COLES 3", category="income"),      # income -> filed -> ineligible
        _txn("rawenum", "COLES 4", category="FOOD_AND_DRINK"),  # raw enum -> unfiled
    ]
    plan = rule_engine.plan_rule_application([_rule("coles")], rows, _is_unfiled(taxonomy))

    assert plan["unfiled"] == 2
    assert sorted(t["transaction_id"] for t, _, _ in plan["matched"]) == ["rawenum", "unfiled"]


def test_an_excluded_transfer_is_still_eligible(rule_engine):
    # FAIL-ON-REVERT: the badge counts excluded transfers (WHIT-330), so the apply pass must too.
    # Adding a contributes_to_budget gate would drop this row.
    row = _txn("transfer", "COLES TRANSFER", category=None)
    row.update(counts_to_budget=False, budget_excluded=True)
    plan = rule_engine.plan_rule_application([_rule("coles")], [row], _is_unfiled({"groceries"}))
    assert len(plan["matched"]) == 1


def test_rules_that_disagree_leave_the_charge_alone(rule_engine):
    rules = [_rule("coles", "groceries", rule_id="r1"), _rule("richmond", "coffee", rule_id="r2")]
    rows = [_txn("t1", "COLES RICHMOND", category=None)]
    plan = rule_engine.plan_rule_application(rules, rows, _is_unfiled({"groceries", "coffee"}))

    assert plan["matched"] == []          # never guessed
    assert plan["conflicted"] == 1


def test_rules_that_agree_file_the_charge_once(rule_engine):
    rules = [_rule("coles", "groceries", rule_id="r1"), _rule("richmond", "groceries", rule_id="r2")]
    plan = rule_engine.plan_rule_application(
        rules, [_txn("t1", "COLES RICHMOND")], _is_unfiled({"groceries"}))

    assert [t["transaction_id"] for t, _, _ in plan["matched"]] == ["t1"]
    # WHIT-536: matched carries the WINNING rule's id — the first match (index 0), the same
    # choice rule_ingest makes — so the on-demand path stamps filed_by_rule consistently.
    assert [rule_id for _, _, rule_id in plan["matched"]] == ["r1"]
    assert plan["by_category"] == {"groceries": 1}
    assert plan["conflicted"] == 0


# --- WHIT-518: the more specific rule wins ------------------------------------


def test_the_more_specific_rule_wins_when_matches_disagree(rule_engine):
    # "COLES EXPRESS" contains "COLES", so it is the most specific match and its category wins.
    rules = [_rule("COLES", "groceries", rule_id="r-coles"),
             _rule("COLES EXPRESS", "petrol", rule_id="r-express")]
    resolved, matched_indices, categories = rule_engine.decide(rules, _txn("t1", "COLES EXPRESS 1123"))

    assert resolved == "petrol"
    assert categories == {"groceries", "petrol"}
    # The winner is floated to index 0, so both stamp sites name the specific rule.
    assert rules[matched_indices[0]]["id"] == "r-express"


def test_plan_files_a_nested_disagreement_to_the_specific_rule(rule_engine):
    rules = [_rule("COLES", "groceries", rule_id="r-coles"),
             _rule("COLES EXPRESS", "petrol", rule_id="r-express")]
    plan = rule_engine.plan_rule_application(
        rules, [_txn("t1", "COLES EXPRESS 1123", category=None)], _is_unfiled({"groceries", "petrol"}))

    assert [category for _, category, _ in plan["matched"]] == ["petrol"]
    assert [rule_id for _, _, rule_id in plan["matched"]] == ["r-express"]   # stamped with the winner
    assert plan["conflicted"] == 0
    # by_rule still counts COLES's hit on the EXPRESS charge — a per-rule signal, not a total.
    assert {entry["ruleId"] for entry in plan["by_rule"]} == {"r-coles", "r-express"}


def test_a_strictly_nested_three_way_resolves_to_the_longest(rule_engine):
    # COLES ⊂ COLES EXPRESS ⊂ COLES EXPRESS 1123 — the deepest contains all the others, so it wins.
    # (Locks against encoding the wrong "nested three-way -> conflicted".)
    rules = [_rule("COLES", "groceries", rule_id="r1"),
             _rule("COLES EXPRESS", "petrol", rule_id="r2"),
             _rule("COLES EXPRESS 1123", "coffee", rule_id="r3")]
    resolved, matched_indices, _ = rule_engine.decide(rules, _txn("t1", "COLES EXPRESS 1123"))

    assert resolved == "coffee"
    assert rules[matched_indices[0]]["id"] == "r3"


def test_two_non_nested_matches_stay_conflicted(rule_engine):
    # "COLES EXPRESS" and "COLES METRO" — neither contains the other, so there is no single most-
    # specific winner: the charge stays conflicted.
    rules = [_rule("COLES EXPRESS", "petrol", rule_id="r1"),
             _rule("COLES METRO", "coffee", rule_id="r2")]
    resolved, _, categories = rule_engine.decide(rules, _txn("t1", "COLES EXPRESS AND COLES METRO"))

    assert resolved is None
    assert categories == {"petrol", "coffee"}


def test_dominant_rules_that_agree_resolve_over_a_shorter_disagreeing_rule(rule_engine):
    # Two fold-equal "COLES EXPRESS" rules (single vs double space) both -> petrol dominate the
    # shorter, disagreeing "COLES" -> groceries. Among the DOMINANT rules only petrol is named, so
    # it resolves even though the full match set names two categories.
    rules = [_rule("COLES", "groceries", rule_id="r1"),
             _rule("COLES EXPRESS", "petrol", rule_id="r2"),
             _rule("COLES  EXPRESS", "petrol", rule_id="r3")]
    resolved, _, categories = rule_engine.decide(rules, _txn("t1", "COLES EXPRESS COLES  EXPRESS"))

    assert resolved == "petrol"
    assert categories == {"groceries", "petrol"}


def test_fold_equal_rules_that_disagree_stay_conflicted(rule_engine):
    # The tie-break folds text, so "COLES EXPRESS" and "COLES  EXPRESS" are equally specific. Sent
    # to DIFFERENT categories they can't be told apart, so the charge stays conflicted — the same
    # answer the store's exact-clash guard gives.
    rules = [_rule("COLES EXPRESS", "petrol", rule_id="r2"),
             _rule("COLES  EXPRESS", "coffee", rule_id="r3")]
    resolved, _, categories = rule_engine.decide(rules, _txn("t1", "COLES EXPRESS COLES  EXPRESS"))

    assert resolved is None
    assert categories == {"petrol", "coffee"}


def test_winner_floats_to_index0_when_non_matching_rules_sit_before_it(rule_engine):
    # The reorder pops by POSITION-in-matched (then reads the rule index); with non-matching rules
    # interleaved the two differ, so a pop-by-rule-index bug would float the WRONG rule.
    rules = [_rule("WOOLWORTHS", "shopping", rule_id="r-nomatch1"),
             _rule("COLES", "groceries", rule_id="r-coles"),
             _rule("ALDI", "shopping", rule_id="r-nomatch2"),
             _rule("COLES EXPRESS", "petrol", rule_id="r-express")]
    resolved, matched_indices, categories = rule_engine.decide(rules, _txn("t1", "COLES EXPRESS 1123"))

    assert resolved == "petrol"
    assert categories == {"groceries", "petrol"}
    assert matched_indices[0] == 3 and rules[matched_indices[0]]["id"] == "r-express"
    assert sorted(matched_indices) == [1, 3]


def test_cross_field_nested_fold_stays_conflicted(rule_engine):
    # A description rule ("food") and a category rule ("food_and_drink") can BOTH match one charge,
    # and "food_and_drink" folds to CONTAIN "food" — but that is a coincidence across rule KINDS,
    # not real specificity. The tie-break is scoped to the same field+operator, so this stays
    # conflicted rather than silently filing to the category rule.
    # FAIL-ON-REVERT: drop the `targets[other] == targets[position]` guard and this resolves.
    rules = [_rule("food", "eating-out", field="description", operator="contains", rule_id="r-desc"),
             _rule("FOOD_AND_DRINK", "groceries", field="category", operator="equals", rule_id="r-cat")]
    resolved, _, categories = rule_engine.decide(
        rules, _txn("t1", "FOOD TRUCK 42", category="FOOD_AND_DRINK"))

    assert resolved is None
    assert categories == {"eating-out", "groceries"}


def test_a_rule_targeting_a_deleted_category_is_skipped(rule_engine):
    # Load-bearing for run-twice: filing to a dangling id would leave the row unfiled, so the
    # next run would file it again, forever.
    plan = rule_engine.plan_rule_application(
        [_rule("coles", "deleted-cat")], [_txn("t1")], _is_unfiled({"groceries"}))

    assert plan["matched"] == []
    assert plan["skipped_rules"][0]["reason"] == "category no longer exists"


def test_a_rule_targeting_income_is_applied_not_skipped(rule_engine):
    # `income` is filed but is not a taxonomy id — using the same predicate for both sides
    # keeps it valid, where a plain "is it in the taxonomy?" test would wrongly skip it.
    plan = rule_engine.plan_rule_application(
        [_rule("salary", "income")], [_txn("t1", "ACME SALARY")], _is_unfiled({"groceries"}))

    assert [c for _, c, _ in plan["matched"]] == ["income"]
    assert plan["skipped_rules"] == []


def test_unsupported_and_empty_rules_are_reported(rule_engine):
    rules = [_rule("x", field="amount", rule_id="bad"), _rule("  ", rule_id="empty")]
    plan = rule_engine.plan_rule_application(rules, [_txn("t1")], _is_unfiled({"groceries"}))

    reasons = {entry["id"]: entry["reason"] for entry in plan["skipped_rules"]}
    assert reasons == {"bad": "unsupported rule type", "empty": "empty rule value"}
    assert plan["rules_considered"] == 2


# --- the preview breakdown ----------------------------------------------------


def test_by_rule_shows_each_rule_its_count_and_samples(rule_engine):
    # The over-eager-rule signal: "ALDI" also hits VIVALDI, and the preview must show it.
    rows = [_txn(f"t{i}", "VIVALDI CAFE") for i in range(4)] + [_txn("real", "ALDI SUPERMARKET")]
    plan = rule_engine.plan_rule_application(
        [_rule("aldi", rule_id="r-aldi")], rows, _is_unfiled({"groceries"}))

    entry = plan["by_rule"][0]
    assert entry["ruleId"] == "r-aldi"
    assert entry["count"] == 5
    assert len(entry["samples"]) == 3          # capped
    assert "VIVALDI CAFE" in entry["samples"]


def test_by_rule_is_sorted_biggest_first_and_omits_rules_that_hit_nothing(rule_engine):
    rules = [_rule("coles", rule_id="small"), _rule("woolworths", rule_id="big"),
             _rule("zzz", rule_id="none")]
    rows = [_txn("c1", "COLES")] + [_txn(f"w{i}", "WOOLWORTHS") for i in range(3)]
    plan = rule_engine.plan_rule_application(rules, rows, _is_unfiled({"groceries"}))

    assert [entry["ruleId"] for entry in plan["by_rule"]] == ["big", "small"]


# --- existing_at_least_as_specific: is minting `value` unsafe against this existing rule? ------
# WHIT-518 made the clash ONE-DIRECTIONAL: minting a candidate that is more GENERAL than (or equal
# to) a disagreeing existing rule is refused (it would steamroll the specific rule under the "file
# this shop" narrowing); minting a STRICTLY more-specific candidate is allowed.


def test_more_general_or_equal_candidate_is_a_clash(rule_engine):
    # Candidate "COLES" is a substring of the existing "COLES EXPRESS" -> candidate is more general
    # -> clash (True). Exact-equal is also more-general-or-equal -> clash.
    assert rule_engine.existing_at_least_as_specific(
        _rule("COLES EXPRESS"), "description", "contains", "COLES")
    assert rule_engine.existing_at_least_as_specific(
        _rule("COLES"), "description", "contains", "coles")


def test_strictly_more_specific_candidate_is_allowed(rule_engine):
    # Candidate "COLES EXPRESS" contains the existing "COLES" -> candidate is strictly more specific
    # -> NOT a clash (WHIT-518 lets it win its own charges).
    assert not rule_engine.existing_at_least_as_specific(
        _rule("COLES"), "description", "contains", "COLES EXPRESS")
    # Non-nested values only CAN co-occur — not decidable from the values alone, so not a clash.
    assert not rule_engine.existing_at_least_as_specific(
        _rule("COLES"), "description", "contains", "RICHMOND")


def test_specificity_check_needs_the_same_field_and_operator(rule_engine):
    # A description rule and a category rule target different text, so neither constrains the other.
    rule = _rule("COLES", field="description", operator="contains")
    assert not rule_engine.existing_at_least_as_specific(rule, "category", "contains", "COLES")
    assert not rule_engine.existing_at_least_as_specific(rule, "description", "equals", "COLES")


# --- rule_id_for: the stable dedup id -----------------------------------------


def test_rule_id_for_folds_the_value_so_casing_and_spacing_variants_share_an_id(rule_engine):
    base = rule_engine.rule_id_for("description", "contains", "coles online")
    assert rule_engine.rule_id_for("description", "contains", "COLES ONLINE") == base
    assert rule_engine.rule_id_for("description", "contains", "  coles   online  ") == base


def test_rule_id_for_pins_the_recipe(rule_engine):
    # FAIL-ON-REVERT: a hardcoded expected value locks the "field|operator|folded value" recipe —
    # reordering the parts, dropping the fold, or changing the "|" separator all redden here.
    assert rule_engine.rule_id_for("description", "contains", "COLES") == "e199355ab3c7aab5"
    assert rule_engine.rule_id_for("category", "equals", "COLES") == "888b3f0ebce53244"


# --- the run-twice property ---------------------------------------------------


def test_filing_removes_a_charge_from_the_unfiled_set(rule_engine):
    # The safe-to-run-twice guarantee, at the logic level: apply the plan to the rows, re-plan,
    # and nothing is left to file.
    taxonomy = {"groceries"}
    rows = [_txn("t1", "COLES"), _txn("t2", "COLES")]
    first = rule_engine.plan_rule_application([_rule("coles")], rows, _is_unfiled(taxonomy))
    assert len(first["matched"]) == 2

    for transaction, category_id, _ in first["matched"]:
        transaction["category"] = category_id      # what the handler's write does

    second = rule_engine.plan_rule_application([_rule("coles")], rows, _is_unfiled(taxonomy))
    assert second["matched"] == []
    assert second["unfiled"] == 0


# --- crash safety and matcher edges -------------------------------------------


@pytest.mark.parametrize("value,description,expected", [
    (1234, "COLES 1234", True),          # an int rule value is stringified, not crashed on
    (1234, "COLES 9999", False),
    (0, "PAYMENT 0", False),             # 0 is falsy -> treated as an empty value, matches nothing
    (None, "ANYTHING", False),
    (False, "FALSE ALARM", False),
    ("1234", 12345, True),               # a numeric description is stringified
    ("1234", None, False),
    ("1234", "", False),
    ("1234", 0, False),
])
def test_a_non_string_rule_value_or_description_never_crashes(
        rule_engine, value, description, expected):
    # `value` reaches us from BankSync and a stored description isn't guaranteed a string either.
    # Neither may raise — an exception here would 500 the whole run.
    assert rule_engine.rule_matches(_rule(value), _txn("t1", description)) is expected


def test_a_rule_with_no_category_id_is_skipped_rather_than_crashing_the_run(rule_engine):
    # [A34] A rule missing `categoryId` entirely (a hand-made or half-migrated BankSync rule).
    # _skip_reason must catch it BEFORE the planner reaches rule["categoryId"] — that subscript
    # would raise KeyError and 500 the whole run, taking every other rule with it. The reason
    # names the real problem rather than blaming a deleted category.
    rule = {"id": "no-cat", "field": "description", "operator": "contains", "value": "coles"}
    plan = rule_engine.plan_rule_application([rule], [_txn("t1")], _is_unfiled({"groceries"}))

    assert plan["matched"] == []
    assert plan["skipped_rules"] == [
        {"id": "no-cat", "value": "coles", "reason": "rule has no category"}]


def test_category_equals_does_not_match_a_prefix_of_the_stored_category(rule_engine):
    # `equals` is not `contains`: a FOOD rule must not sweep up every FOOD_AND_DRINK charge.
    rule = _rule("FOOD", field="category", operator="equals")
    assert not rule_engine.rule_matches(rule, _txn("t1", category="FOOD_AND_DRINK"))


def test_a_charge_whose_category_is_an_empty_string_is_eligible_and_filable(rule_engine):
    # "" is neither income nor a taxonomy id, so the badge counts it — the apply pass must
    # be able to file it too, or those rows are permanently stuck.
    plan = rule_engine.plan_rule_application(
        [_rule("coles")], [_txn("t1", "COLES", category="")], _is_unfiled({"groceries"}))

    assert plan["unfiled"] == 1
    assert [t["transaction_id"] for t, _, _ in plan["matched"]] == ["t1"]


def test_amount_match_is_identical_across_spellings(rule_engine):
    # -25 is under $30 regardless of how the threshold was written; -40 is not. The stored
    # spelling must not shift the boundary.
    for spelling in ["30", "30.0", "30.00", "3e1", "30.000"]:
        rule = _rule(spelling, field="amount", operator="less_than")
        assert rule_engine.rule_matches(rule, _txn(amount=Decimal("-25.00"))) is True, spelling
        assert rule_engine.rule_matches(rule, _txn(amount=Decimal("-40.00"))) is False, spelling


# --- multi-condition identity: existing single-condition ids are byte-stable ---


def test_single_condition_collapses_to_the_legacy_id(rule_engine):
    # A 1-condition rule (built the new way) MUST hash to the exact legacy id, so it dedups against
    # the existing flat rule and keeps its history. FAIL-ON-REVERT: drop the len==1 collapse and a
    # one-condition rule gets a brand-new id, orphaning every charge it filed.
    legacy = rule_engine.rule_id_for("description", "contains", "COLES")
    collapsed = rule_engine.rule_id_for_conditions(
        [{"field": "description", "operator": "contains", "value": "COLES"}], "all")
    assert collapsed == legacy


def test_empty_conditions_list_falls_back_to_the_legacy_id(rule_engine):
    # An app that sends `conditions: []` must not mint a different id from the flat rule.
    assert (rule_engine.rule_identity("description", "contains", "COLES", [], "all")
            == rule_engine.rule_id_for("description", "contains", "COLES"))


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


# --- multi-condition combination: AND / OR -------------------------------------


def test_all_logic_requires_every_condition(rule_engine):
    rule = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                   {"field": "amount", "operator": "less_than", "value": "30"}], "all")
    assert rule_engine.rule_matches(rule, _txn(description="UBER TRIP", amount=Decimal("-25.00")))
    assert not rule_engine.rule_matches(rule, _txn(description="UBER TRIP", amount=Decimal("-40.00")))


def test_any_logic_needs_only_one(rule_engine):
    rule = _multi([{"field": "merchant", "operator": "equals", "value": "uber"},
                   {"field": "amount", "operator": "greater_than", "value": "1000"}], "any")
    # merchant matches the raw description (WHIT-561 follow-up), so equals compares to it.
    assert rule_engine.rule_matches(rule, _txn(description="UBER", amount=Decimal("-25.00")))
    assert not rule_engine.rule_matches(rule, _txn(description="LYFT", amount=Decimal("-25.00")))


# --- the per-field primitives ---------------------------------------------------


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


def test_direction_debit_and_credit(rule_engine):
    debit = _multi([{"field": "direction", "operator": "is", "value": "debit"}])
    assert rule_engine.rule_matches(debit, _txn(amount=Decimal("-25.00")))
    assert not rule_engine.rule_matches(debit, _txn(amount=Decimal("25.00")))
    credit = _multi([{"field": "direction", "operator": "is", "value": "credit"}])
    assert rule_engine.rule_matches(credit, _txn(amount=Decimal("25.00")))


def test_direction_zero_amount_matches_neither(rule_engine):
    # A $0.00 charge is neither debit (<0) nor credit (>0).
    debit = _multi([{"field": "direction", "operator": "is", "value": "debit"}])
    credit = _multi([{"field": "direction", "operator": "is", "value": "credit"}])
    assert not rule_engine.rule_matches(debit, _txn(amount=Decimal("0")))
    assert not rule_engine.rule_matches(credit, _txn(amount=Decimal("0")))


def test_merchant_and_account_fields(rule_engine):
    # merchant matches the raw description (WHIT-561 follow-up), not the cleaned merchant_name.
    merchant = _multi([{"field": "merchant", "operator": "equals", "value": "uber"}])
    assert rule_engine.rule_matches(merchant, _txn(description="UBER"))
    assert not rule_engine.rule_matches(merchant, _txn(description="UBER EATS"))  # equals, not contains
    account = _multi([{"field": "account", "operator": "equals", "value": "acct-1"}])
    assert rule_engine.rule_matches(account, _txn(account_id="acct-1"))
    assert not rule_engine.rule_matches(account, _txn(account_id="acct-2"))


def test_merchant_matches_the_raw_description_not_the_cleaned_merchant_name(rule_engine):
    # merchant is a friendlier label for the raw description (the field every other rule matches
    # and the one stable across pending/posted). It must READ description and IGNORE merchant_name.
    rule = _multi([{"field": "merchant", "operator": "contains", "value": "coles"}])
    # description holds the value, merchant_name does not -> matches (reads description).
    assert rule_engine.rule_matches(rule, _txn(description="COLES 123", merchant_name="WOOLIES"))
    # merchant_name holds it, description does not -> does NOT match.
    # FAIL-ON-REVERT: matching merchant_name (the old behaviour) makes this wrongly True.
    assert not rule_engine.rule_matches(rule, _txn(description="WOOLIES 456", merchant_name="COLES"))


# --- decide: a disagreement involving a multi rule is conflicted, never mis-filed ---


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
    resolved, _matched, categories = rule_engine.decide(
        [single, multi], _txn(description="UBER TRIP", amount=Decimal("-25.00")))
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


def test_decide_two_multi_rules_agreeing_resolve_cleanly(rule_engine):
    # The `any(conditions)` conflict guard is reached ONLY when the matched categories DISAGREE
    # (len > 1). Two multi rules that both name "food" agree -> one category -> filed, NOT dropped
    # as conflicted. FAIL-ON-REVERT: if the guard were hoisted above the len(categories)<=1 check,
    # agreeing multis would wrongly resolve to None.
    a = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                {"field": "amount", "operator": "less_than", "value": "30"}],
               category_id="food", rule_id="a")
    b = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                {"field": "direction", "operator": "is", "value": "debit"}],
               category_id="food", rule_id="b")
    resolved, matched, categories = rule_engine.decide(
        [a, b], _txn(description="UBER TRIP", amount=Decimal("-25.00")))
    assert resolved == "food"
    assert matched == [0, 1]
    assert categories == {"food"}


# --- _skip_reason and the one shared rule vocabulary ------------------------------


def test_skip_reason_flags_an_unsupported_condition_in_a_multi_rule(rule_engine):
    # One good condition + one with a field the engine can't evaluate -> the whole rule is skipped
    # as unsupported (never silently matches nothing).
    rule = _multi([{"field": "merchant", "operator": "contains", "value": "uber"},
                   {"field": "postcode", "operator": "equals", "value": "3000"}])
    assert rule_engine._skip_reason(rule, lambda _id: False) == "unsupported rule type"


def test_skip_reason_empty_text_condition_in_a_multi_rule(rule_engine):
    # A text condition whose value normalises to empty -> "empty rule value" (would match nothing
    # or everything). amount + direction carry no text value and are exempt.
    rule = _multi([{"field": "merchant", "operator": "contains", "value": "   "},
                   {"field": "amount", "operator": "less_than", "value": "30"}])
    assert rule_engine._skip_reason(rule, lambda _id: False) == "empty rule value"


def _pair_rule(field, operator):
    return _rule(PAIR_VALUE.get(field, "UBER"), "transport", field, operator)


def test_no_other_server_file_keeps_a_copy_of_the_rule_vocabulary():
    server_files = [path for folder in ROOT.glob("lambda*/") for path in folder.glob("*.py")]
    server_files += [path for path in SHARED_DIR.glob("*.py") if path.name != "constants.py"]
    copies = [f"{path.relative_to(ROOT)}: {name}" for path in sorted(server_files)
              for name in sorted(set(_top_level_binding_list(path)) & _RULE_VOCAB_NAMES)]
    assert copies == [], f"import the rule vocabulary from constants instead: {copies}"


def test_engine_accepts_every_supported_pair(rule_engine):
    skipped = {pair: rule_engine._skip_reason(_pair_rule(*pair), lambda _id: False)
               for pair in RULE_PAIRS}
    assert {pair: reason for pair, reason in skipped.items() if reason} == {}


def test_engine_refuses_pairs_outside_the_vocabulary(rule_engine):
    for field, operator in [("amount", "contains"), ("category", "contains"), ("direction", "equals"),
                            ("account", "contains"), ("merchant", "is"), ("payee", "equals")]:
        reason = rule_engine._skip_reason(_pair_rule(field, operator), lambda _id: False)
        assert reason == "unsupported rule type", (field, operator, reason)


def test_engine_logic_any_is_or_and_unknown_falls_back_to_all(rule_engine):
    conditions = [{"field": "description", "operator": "contains", "value": "UBER"},
                  {"field": "description", "operator": "contains", "value": "NOPE"}]
    transaction = {"description": "UBER TRIP", "amount": -10}
    assert rule_engine.rule_matches({"conditions": conditions, "logic": "any"}, transaction) is True
    assert rule_engine.rule_matches({"conditions": conditions, "logic": "all"}, transaction) is False
    assert rule_engine.rule_matches({"conditions": conditions, "logic": "xor"}, transaction) is False
