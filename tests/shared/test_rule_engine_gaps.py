"""WHIT-527 ADVERSARIAL gap tests for shared/rule_engine.py.

Does NOT duplicate tests/shared/test_rule_engine.py (predicate, conflict rule, eligibility,
run-twice, specificity clash, by_rule sort) or tests/lambda_api/test_apply_rules_gaps.py ([A30]-[A36]:
non-string values, accents, prefix-equals, empty-string category). This file locks the pieces
those suites reach only THROUGH plan_rule_application:

  * decide() called DIRECTLY — the per-charge core WHIT-528's webhook will share.
  * the conflicted_samples cap + sorted-categoryIds shape (byte-identical to the deleted
    rule_apply.plan_rule_application).
  * the index-keyed by_rule split for TWO inline rules that both carry id=None.
  * the contains() primitive on its own, including the empty-value edge callers must guard.
  * rule_engine resolves to the SHARED copy (not a stale lambda_api shadow).
"""


def _rule(value, category_id="groceries", field="description", operator="contains", rule_id="r1"):
    return {"id": rule_id, "field": field, "operator": operator, "value": value,
            "categoryId": category_id}


def _txn(transaction_id, description="COLES 1234 RICHMOND", category=None):
    return {"transaction_id": transaction_id, "description": description, "category": category}


def _is_unfiled(taxonomy):
    return lambda category: category != "income" and category not in taxonomy


# --- decide() called directly -------------------------------------------------


def test_decide_returns_none_and_empty_on_zero_matches(rule_engine):
    # [G1] No rule matches: resolved None, no indices, empty set. The caller reads the empty
    # `categories` to tell "nothing matched" apart from "matched but conflicted".
    resolved, indices, categories = rule_engine.decide([_rule("woolworths")], _txn("t1", "COLES"))
    assert resolved is None
    assert indices == []
    assert categories == set()


def test_decide_returns_the_sole_category_on_a_single_match(rule_engine):
    # [G2] One agreeing category -> resolved is that id, and it is drawn from the set.
    resolved, indices, categories = rule_engine.decide([_rule("coles", "groceries")], _txn("t1"))
    assert resolved == "groceries"
    assert indices == [0]
    assert categories == {"groceries"}


def test_decide_returns_none_resolved_but_full_set_on_a_conflict(rule_engine):
    # [G3] FAIL-ON-REVERT for WHIT-355: a conflict must resolve to None (never silently pick
    # one) while STILL reporting every category so the caller can show what disagreed. If decide
    # returned `next(iter(categories))` unconditionally, this reddens.
    rules = [_rule("coles", "groceries", rule_id="a"), _rule("richmond", "coffee", rule_id="b")]
    resolved, indices, categories = rule_engine.decide(rules, _txn("t1", "COLES RICHMOND"))
    assert resolved is None
    assert indices == [0, 1]
    assert categories == {"groceries", "coffee"}


def test_decide_matched_indices_are_in_enumeration_order_skipping_non_matches(rule_engine):
    # [G4] indices are POSITIONS into the input list, in order, with gaps for non-matching rules.
    rules = [_rule("coles", "groceries", rule_id="0"),
             _rule("woolworths", "groceries", rule_id="1"),   # does not match
             _rule("richmond", "groceries", rule_id="2")]
    resolved, indices, categories = rule_engine.decide(rules, _txn("t1", "COLES RICHMOND"))
    assert indices == [0, 2]
    assert resolved == "groceries"           # all agree -> filed
    assert categories == {"groceries"}


def test_decide_keeps_two_inline_rules_with_id_none_separate_by_index(rule_engine):
    # [G5] Both rules carry id=None (an inline/minted rule has no id). decide keys on POSITION,
    # so both are reported, not collapsed. If decide ever keyed matches by id, one would vanish.
    rules = [_rule("coles", "groceries", rule_id=None),
             _rule("richmond", "groceries", rule_id=None)]
    resolved, indices, categories = rule_engine.decide(rules, _txn("t1", "COLES RICHMOND"))
    assert indices == [0, 1]
    assert resolved == "groceries"


# --- plan_rule_application: the byte-shape the deleted rule_apply produced -----


def test_two_id_none_rules_stay_separate_rows_in_by_rule(rule_engine):
    # [G6] The plan-level twin of [G5]: rule_hits is index-keyed, so two id=None rules matching
    # the same charge produce TWO by_rule rows (each count 1), never one merged row. An id-keyed
    # rule_hits would silently drop one inline rule from the preview.
    rules = [_rule("coles", "groceries", rule_id=None),
             _rule("richmond", "groceries", rule_id=None)]
    plan = rule_engine.plan_rule_application(rules, [_txn("t1", "COLES RICHMOND")],
                                             _is_unfiled({"groceries"}))
    none_rows = [entry for entry in plan["by_rule"] if entry["ruleId"] is None]
    assert len(none_rows) == 2
    assert all(entry["count"] == 1 for entry in none_rows)
    assert len(plan["matched"]) == 1          # agreed -> filed once, not twice


def test_conflicted_samples_are_capped_at_three_but_the_count_is_not(rule_engine):
    # [G7] FAIL-ON-REVERT for the _SAMPLES_PER_RULE cap: 5 conflicting charges -> conflicted is
    # the true 5, but only 3 examples are carried (a preview payload, not a dump).
    rules = [_rule("coles", "groceries", rule_id="a"), _rule("richmond", "coffee", rule_id="b")]
    rows = [_txn(f"t{i}", "COLES RICHMOND") for i in range(5)]
    plan = rule_engine.plan_rule_application(rules, rows, _is_unfiled({"groceries", "coffee"}))
    assert plan["conflicted"] == 5
    assert len(plan["conflicted_samples"]) == 3


def test_conflicted_sample_category_ids_are_sorted_deterministically(rule_engine):
    # [G8] Each sample's categoryIds are SORTED, not in set-iteration order — the client renders
    # them and set order is not stable across runs/versions. Categories chosen so sorted order
    # ("alpha","zeta") differs from insertion order (zeta rule first).
    plan = rule_engine.plan_rule_application([_rule("coles", "zeta", rule_id="a"),
                                              _rule("richmond", "alpha", rule_id="b")],
                                             [_txn("t1", "COLES RICHMOND")],
                                             _is_unfiled({"zeta", "alpha"}))
    assert plan["conflicted_samples"] == [
        {"description": "COLES RICHMOND", "categoryIds": ["alpha", "zeta"]}]


def test_plan_matches_a_hand_computed_decide_over_the_eligible_rows(rule_engine):
    # [G9] Cross-check: plan's matched/by_category are exactly what decide() yields per eligible
    # row. Ties the shared core to the plan wrapper, so a future rewrite of one that drifts from
    # the other reddens here rather than in production.
    rules = [_rule("coles", "groceries", rule_id="a"), _rule("aldi", "groceries", rule_id="b")]
    rows = [_txn("t1", "COLES 1"), _txn("t2", "ALDI 2"), _txn("t3", "WOOLWORTHS 3")]
    is_unfiled = _is_unfiled({"groceries"})
    plan = rule_engine.plan_rule_application(rules, rows, is_unfiled)

    expected = []
    for row in rows:
        if not is_unfiled(row["category"]):
            continue
        resolved, _idx, _cats = rule_engine.decide(rules, row)
        if resolved is not None:
            expected.append((row["transaction_id"], resolved))
    assert [(t["transaction_id"], c) for t, c, _ in plan["matched"]] == expected


# --- contains() primitive on its own ------------------------------------------


def test_contains_strips_the_value_but_tests_membership_in_already_normalised_text(rule_engine):
    # [G10] contains() strips+lowercases only the VALUE; the text is assumed already normalised
    # by the caller (rule_matches via _normalise, merchant_groups up front). Membership, not
    # equality.
    assert rule_engine.contains("  COLES  ", "coles 1234 richmond")
    assert not rule_engine.contains("woolworths", "coles 1234 richmond")


def test_contains_does_not_collapse_internal_whitespace(rule_engine):
    # [G11] FAIL-ON-REVERT for the strict (non-collapsing) semantics WHIT-527 shares with
    # merchant_groups: a single-spaced value must NOT match double-spaced text. A collapsing
    # matcher would overstate a merchant group's count one tap before a bulk write ([A17]).
    assert not rule_engine.contains("coles online", "coles  online 333")
    assert rule_engine.contains("coles online", "coles online 333")


def test_contains_with_an_empty_value_is_vacuously_true_so_callers_must_guard(rule_engine):
    # [G12] CHARACTERISATION: `"" in text` is always True, so contains() does NOT itself reject
    # an empty value — rule_matches guards `if not value` first, merchant_groups only feeds it a
    # safe (>= alphanumeric floor) value. Locked so a refactor that drops a caller's guard and
    # leans on contains() to reject empties is caught: contains() will NOT.
    assert rule_engine.contains("", "anything at all")
    assert rule_engine.contains("   ", "anything at all")   # stripped to "" -> still vacuous


# --- the module is the shared copy, not a lambda_api shadow -------------------


def test_rule_engine_is_the_shared_layer_module_with_no_constants_import(rule_engine):
    # [G13] WHIT-527 moved this OUT of lambda_api (where constants.py shadows the shared layer).
    # It must resolve to shared/ and stay constants-free, or the deployed API ImportErrors at
    # cold start. build_artifacts_test.sh + the bundle test guard the deploy; this guards the
    # import path the tests themselves exercise.
    import os
    assert rule_engine.__file__.replace(os.sep, "/").endswith("shared/rule_engine.py")
    import ast
    with open(rule_engine.__file__) as handle:
        tree = ast.parse(handle.read())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module)
    # No `constants` import (the docstring MENTIONS the phrase; only real imports count).
    assert "constants" not in imported
    # Stdlib only — re (matching) + hashlib (rule_id_for, WHIT-528) + decimal (amount comparison,
    # WHIT-541). Nothing from the shared layer or constants, so the module stays a pure,
    # deploy-safe leaf.
    assert imported <= {"re", "hashlib", "decimal"}
