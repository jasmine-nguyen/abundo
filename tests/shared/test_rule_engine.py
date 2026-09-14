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


def test_a_multi_condition_rule_is_skipped_not_applied_broadened(rule_engine):
    # We only read a rule's FIRST condition, so "description contains UBER AND amount > 50"
    # arrives as the far broader "contains UBER". Applying that to history would mis-file every
    # Uber charge — the dropped condition was exactly what kept it in check.
    broad = _rule("uber", rule_id="r-multi")
    broad["conditionCount"] = 2
    plan = rule_engine.plan_rule_application(
        [broad], [_txn("t1", "UBER TRIP")], _is_unfiled({"groceries"}))

    assert plan["matched"] == []
    assert plan["skipped_rules"][0]["reason"] == "rule has more than one condition"


def test_a_single_condition_rule_is_applied_normally(rule_engine):
    # The counterpart: conditionCount 1 (or absent, for a rule built before the field existed)
    # applies as usual, so the guard can't accidentally block every rule.
    single = _rule("uber", rule_id="r-single")
    single["conditionCount"] = 1
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


# --- overlaps: would two rules fight over the same charges? -------------------


def test_overlaps_is_true_when_either_value_contains_the_other(rule_engine):
    # Nesting is the damaging case: every "COLES EXPRESS" charge also matches "COLES".
    coles = _rule("COLES")
    assert rule_engine.overlaps(coles, "description", "contains", "COLES EXPRESS")
    assert rule_engine.overlaps(_rule("COLES EXPRESS"), "description", "contains", "coles")
    # Values that only CAN co-occur (not nested) are not detectable from the values alone.
    assert not rule_engine.overlaps(coles, "description", "contains", "RICHMOND")


def test_overlaps_needs_the_same_field_and_operator(rule_engine):
    # A description rule and a category rule target different text, so they never overlap.
    rule = _rule("COLES", field="description", operator="contains")
    assert not rule_engine.overlaps(rule, "category", "contains", "COLES")
    assert not rule_engine.overlaps(rule, "description", "equals", "COLES")


def test_overlaps_is_false_when_either_value_is_empty(rule_engine):
    assert not rule_engine.overlaps(_rule("   "), "description", "contains", "COLES")
    assert not rule_engine.overlaps(_rule("COLES"), "description", "contains", "   ")


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
