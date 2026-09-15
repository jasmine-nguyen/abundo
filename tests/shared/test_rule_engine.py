"""Tests for shared/rule_engine.py — the pure "which charges would my rules file?" logic.

The matching is LITERAL (what BankSync would do with the same leaf rule), not the client's fuzzy
merchant-similarity sweep. These lock the predicate, the conflict rule, and the two properties the
whole feature rests on: only unfiled charges are eligible, and filing one removes it from the
unfiled set (so a second run files nothing new).
"""


def _rule(value, category_id="groceries", field="description", operator="contains", rule_id="r1"):
    return {"id": rule_id, "field": field, "operator": operator, "value": value,
            "categoryId": category_id}


def _txn(transaction_id, description="COLES 1234 RICHMOND", category=None):
    return {"transaction_id": transaction_id, "description": description, "category": category,
            "pk": "ACCOUNT#a1", "sk": f"TXN#{transaction_id}"}


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


def test_unknown_field_or_operator_never_matches(rule_engine):
    assert not rule_engine.rule_matches(_rule("x", field="amount"), _txn("t1", "X"))
    assert not rule_engine.rule_matches(_rule("x", operator="regex"), _txn("t1", "X"))


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


def test_two_category_equals_rules_never_co_match_so_never_conflict(rule_engine):
    # A category-equals rule matches on EXACT category equality, so two of them to different values
    # can never both match one charge — only one matches, so it resolves via the fast path.
    rules = [_rule("FOOD", "petrol", field="category", operator="equals", rule_id="r-food"),
             _rule("FOOD_AND_DRINK", "groceries", field="category", operator="equals", rule_id="r-fad")]
    resolved, matched_indices, categories = rule_engine.decide(
        rules, _txn("t1", "anything", category="FOOD_AND_DRINK"))

    assert resolved == "groceries"
    assert categories == {"groceries"}
    assert [rules[i]["id"] for i in matched_indices] == ["r-fad"]


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


def test_desc_rule_that_would_swallow_a_category_rule_stays_conflicted(rule_engine):
    # The MIRROR of the case above: here the DESCRIPTION rule's folded value ("food and drink")
    # would swallow the CATEGORY rule's ("food"), so a field-agnostic tie-break would crown the
    # description rule. The field+operator guard says these are different KINDS, not nested
    # specificity, so the charge stays conflicted from this direction too.
    # FAIL-ON-REVERT: drop the `targets[other] == targets[position]` guard and this resolves.
    rules = [_rule("food and drink", "eating-out", field="description", operator="contains", rule_id="r-desc"),
             _rule("food", "groceries", field="category", operator="equals", rule_id="r-cat")]
    resolved, _, categories = rule_engine.decide(
        rules, _txn("t1", "FOOD AND DRINK STORE", category="FOOD"))

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


def test_a_single_condition_rule_is_applied_normally(rule_engine):
    single = _rule("uber", rule_id="r-single")
    plan = rule_engine.plan_rule_application(
        [single], [_txn("t1", "UBER TRIP")], _is_unfiled({"groceries"}))
    assert len(plan["matched"]) == 1


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


def test_no_rules_and_no_rows_plans_nothing(rule_engine):
    plan = rule_engine.plan_rule_application([], [], _is_unfiled({"groceries"}))
    assert plan == {"unfiled": 0, "matched": [], "conflicted": 0, "conflicted_samples": [],
                    "by_category": {}, "by_rule": [], "skipped_rules": [], "rules_considered": 0}


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


def test_specificity_check_is_false_when_either_value_is_empty(rule_engine):
    assert not rule_engine.existing_at_least_as_specific(_rule("   "), "description", "contains", "COLES")
    assert not rule_engine.existing_at_least_as_specific(_rule("COLES"), "description", "contains", "   ")


# --- rule_id_for: the stable dedup id -----------------------------------------


def test_rule_id_for_is_sixteen_lowercase_hex(rule_engine):
    rule_id = rule_engine.rule_id_for("description", "contains", "COLES")
    assert len(rule_id) == 16
    assert all(character in "0123456789abcdef" for character in rule_id)


def test_rule_id_for_folds_the_value_so_casing_and_spacing_variants_share_an_id(rule_engine):
    base = rule_engine.rule_id_for("description", "contains", "coles online")
    assert rule_engine.rule_id_for("description", "contains", "COLES ONLINE") == base
    assert rule_engine.rule_id_for("description", "contains", "  coles   online  ") == base


def test_rule_id_for_changes_with_field_operator_or_value(rule_engine):
    base = rule_engine.rule_id_for("description", "contains", "coles")
    assert rule_engine.rule_id_for("category", "contains", "coles") != base
    assert rule_engine.rule_id_for("description", "equals", "coles") != base
    assert rule_engine.rule_id_for("description", "contains", "woolworths") != base


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


# --- WHIT-561: multi-condition rules + new match primitives --------------------

from decimal import Decimal


def _cond(field, operator, value=None):
    return {"field": field, "operator": operator, "value": value}


def _multi(conditions, logic="all", category_id="groceries", rule_id="m1"):
    return {"id": rule_id, "conditions": conditions, "logic": logic, "categoryId": category_id}


def _charge(transaction_id="t1", description="COLES 1234 RICHMOND", category=None,
            amount=Decimal("-30.00"), account_id="acct-1"):
    return {"transaction_id": transaction_id, "description": description, "category": category,
            "amount": amount, "account_id": account_id, "pk": "ACCOUNT#a1", "sk": f"TXN#{transaction_id}"}


# amount matches on the charge's MAGNITUDE (spend is stored negative; users type plain dollars).
def test_amount_less_than_matches_on_magnitude(rule_engine):
    rule = _multi([_cond("amount", "<", "40")])
    assert rule_engine.rule_matches(rule, _charge(amount=Decimal("-30.00")))
    assert not rule_engine.rule_matches(rule, _charge(amount=Decimal("-50.00")))


def test_amount_all_four_comparators(rule_engine):
    charge = _charge(amount=Decimal("-30.00"))
    assert rule_engine.rule_matches(_multi([_cond("amount", "<=", "30")]), charge)
    assert rule_engine.rule_matches(_multi([_cond("amount", ">=", "30")]), charge)
    assert rule_engine.rule_matches(_multi([_cond("amount", ">", "29.99")]), charge)
    assert not rule_engine.rule_matches(_multi([_cond("amount", ">", "30")]), charge)


def test_amount_non_numeric_value_never_matches(rule_engine):
    assert not rule_engine.rule_matches(_multi([_cond("amount", "<", "abc")]), _charge())


def test_merchant_matches_the_charge_description(rule_engine):
    # 'merchant' is a friendlier label for the raw description (the proven matching path).
    assert rule_engine.rule_matches(_multi([_cond("merchant", "contains", "coles")]), _charge())
    assert rule_engine.rule_matches(
        _multi([_cond("merchant", "equals", "coles 1234 richmond")]), _charge())
    assert not rule_engine.rule_matches(_multi([_cond("merchant", "equals", "coles")]), _charge())


def test_account_equals_is_exact_and_case_sensitive(rule_engine):
    assert rule_engine.rule_matches(_multi([_cond("account", "equals", "acct-1")]), _charge())
    assert not rule_engine.rule_matches(_multi([_cond("account", "equals", "ACCT-1")]), _charge())
    assert not rule_engine.rule_matches(_multi([_cond("account", "equals", "acct-2")]), _charge())


def test_direction_is_debit_and_is_credit_read_the_sign(rule_engine):
    spend = _charge(amount=Decimal("-30.00"))
    income = _charge(amount=Decimal("42.00"))
    assert rule_engine.rule_matches(_multi([_cond("direction", "is_debit")]), spend)
    assert not rule_engine.rule_matches(_multi([_cond("direction", "is_debit")]), income)
    assert rule_engine.rule_matches(_multi([_cond("direction", "is_credit")]), income)
    assert not rule_engine.rule_matches(_multi([_cond("direction", "is_credit")]), spend)


def test_logic_all_requires_every_condition(rule_engine):
    rule = _multi([_cond("merchant", "contains", "coles"), _cond("amount", "<", "40")], logic="all")
    assert rule_engine.rule_matches(rule, _charge(description="COLES", amount=Decimal("-30.00")))
    assert not rule_engine.rule_matches(rule, _charge(description="COLES", amount=Decimal("-50.00")))
    assert not rule_engine.rule_matches(rule, _charge(description="WOOLIES", amount=Decimal("-30.00")))


def test_logic_any_requires_at_least_one(rule_engine):
    rule = _multi([_cond("merchant", "contains", "coles"), _cond("amount", "<", "40")], logic="any")
    assert rule_engine.rule_matches(rule, _charge(description="WOOLIES", amount=Decimal("-30.00")))
    assert rule_engine.rule_matches(rule, _charge(description="COLES", amount=Decimal("-50.00")))
    assert not rule_engine.rule_matches(rule, _charge(description="WOOLIES", amount=Decimal("-50.00")))


# decide: a disagreement involving a multi-condition rule can't be resolved by specificity, so it
# stays conflicted (never mis-filed) — the runtime-only clash guard.
def test_disagreeing_multi_condition_rules_stay_conflicted(rule_engine):
    # FAIL-ON-REVERT: the first conditions nest ("coles" ⊂ "coles express"), so without the
    # multi-condition guard the specificity logic would wrongly crown rule_a and resolve to
    # "shopping". The guard must return None (conflicted) — never mis-file a multi-condition clash.
    rule_a = _multi([_cond("description", "contains", "coles express"), _cond("amount", "<", "100")],
                    category_id="shopping", rule_id="a")
    rule_b = _multi([_cond("description", "contains", "coles"), _cond("direction", "is_debit")],
                    category_id="groceries", rule_id="b")
    charge = _charge(description="COLES EXPRESS RICHMOND", amount=Decimal("-30.00"))
    resolved, matched, categories = rule_engine.decide([rule_a, rule_b], charge)
    assert resolved is None
    assert set(matched) == {0, 1}
    assert categories == {"groceries", "shopping"}


def test_multi_vs_single_disagreement_stays_conflicted(rule_engine):
    # FAIL-ON-REVERT: the multi rule's first condition ("coles express") nests the single rule's
    # ("coles"); without the guard the multi rule would win by specificity and file to "shopping".
    single = _rule("coles", category_id="groceries", rule_id="s")
    multi = _multi([_cond("description", "contains", "coles express"), _cond("amount", "<", "100")],
                   category_id="shopping", rule_id="m")
    charge = _charge(description="COLES EXPRESS RICHMOND", amount=Decimal("-30.00"))
    resolved, _matched, categories = rule_engine.decide([single, multi], charge)
    assert resolved is None
    assert categories == {"groceries", "shopping"}


def test_agreeing_multi_condition_rule_files_the_charge(rule_engine):
    rule = _multi([_cond("merchant", "contains", "coles"), _cond("amount", "<", "100")])
    resolved, matched, _categories = rule_engine.decide([rule], _charge())
    assert resolved == "groceries"
    assert matched == [0]


# _skip_reason (via plan_rule_application): a valid multi rule runs; an unsupported pair is skipped;
# a direction condition carries no value and must NOT read as "empty".
def test_valid_multi_condition_rule_is_applied_not_skipped(rule_engine):
    rule = _multi([_cond("merchant", "contains", "coles"), _cond("direction", "is_debit")])
    plan = rule_engine.plan_rule_application([rule], [_charge()], _is_unfiled({"groceries"}))
    assert plan["skipped_rules"] == []
    assert len(plan["matched"]) == 1


def test_multi_rule_with_an_unsupported_pair_is_skipped(rule_engine):
    rule = _multi([_cond("merchant", "contains", "coles"), _cond("amount", "contains", "40")],
                  rule_id="bad")
    plan = rule_engine.plan_rule_application([rule], [_charge()], _is_unfiled({"groceries"}))
    assert plan["skipped_rules"] == [{"id": "bad", "value": None, "reason": "unsupported rule type"}]


# rule_id_for: id stability + canonicalisation.
def test_single_condition_id_equals_the_legacy_flat_id(rule_engine):
    # No-migration proof: a one-element conditions list hashes identically to the flat call, which
    # is byte-identical to the pre-WHIT-561 recipe (pinned by test_rule_id_for_pins_the_recipe).
    flat = rule_engine.rule_id_for("description", "contains", "COLES")
    listed = rule_engine.rule_id_for(conditions=[_cond("description", "contains", "COLES")])
    assert listed == flat == "e199355ab3c7aab5"


def test_multi_condition_id_is_order_independent(rule_engine):
    a = _cond("merchant", "contains", "coles")
    b = _cond("amount", "<", "40")
    assert rule_engine.rule_id_for(conditions=[a, b]) == rule_engine.rule_id_for(conditions=[b, a])


def test_multi_condition_id_depends_on_logic(rule_engine):
    conditions = [_cond("merchant", "contains", "coles"), _cond("amount", "<", "40")]
    assert (rule_engine.rule_id_for(conditions=conditions, logic="all")
            != rule_engine.rule_id_for(conditions=conditions, logic="any"))


def test_amount_id_collapses_equal_values_but_account_id_is_case_sensitive(rule_engine):
    assert (rule_engine.rule_id_for(conditions=[_cond("amount", "<", "50")])
            == rule_engine.rule_id_for(conditions=[_cond("amount", "<", "50.0")]))
    assert (rule_engine.rule_id_for(conditions=[_cond("account", "equals", "ABC")])
            != rule_engine.rule_id_for(conditions=[_cond("account", "equals", "abc")]))
