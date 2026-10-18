"""Tests for shared/repository_rule.py — our own rule store (WHIT-528).

Run against the real conftest FakeTable (which honours attribute_not_exists / attribute_exists
conditions), so the dedup guard, the clash, and the delete-twice safety are exercised for real
rather than mocked away. The id logic lives in rule_engine (tested there); here we test the
storage behaviour built on it.
"""

import pytest


def _make(rule_repo, value="COLES", category="groceries", field="description",
          operator="contains", **kwargs):
    return rule_repo.create_rule(field, operator, value, category, **kwargs)


# --- create: dedup + clash ----------------------------------------------------


def test_create_same_text_and_category_twice_is_one_row_created_false(rule_repo):
    first, created_first = _make(rule_repo)
    second, created_second = _make(rule_repo)
    assert created_first is True
    assert created_second is False
    assert second["id"] == first["id"]
    assert len(rule_repo.list_rules()) == 1


def test_create_same_text_different_category_clashes(rule_repo):
    # FAIL-ON-REVERT for the dedup guard: the second create is refused by the
    # attribute_not_exists(pk) condition, then read back and found to disagree on category.
    # Drop that ConditionExpression from create_rule and the second create silently OVERWRITES
    # the first instead of clashing — this reddens.
    first, _ = _make(rule_repo, category="groceries")
    from repository_errors import RuleClashError
    with pytest.raises(RuleClashError) as excinfo:
        _make(rule_repo, category="coffee")
    assert excinfo.value.existing["id"] == first["id"]
    assert excinfo.value.existing["category_id"] == "groceries"
    assert len(rule_repo.list_rules()) == 1     # the clashing write left nothing behind


def test_create_dedups_case_and_spacing_variants_onto_one_row(rule_repo):
    _make(rule_repo, value="coles online")
    _, created = _make(rule_repo, value="  COLES   ONLINE  ")   # same folded text
    assert created is False
    assert len(rule_repo.list_rules()) == 1


# --- get + list ---------------------------------------------------------------


def test_get_rule_round_trips_a_created_rule(rule_repo):
    rule, _ = _make(rule_repo)
    assert rule_repo.get_rule(rule["id"]) == rule


# --- update -------------------------------------------------------------------


def test_update_category_keeps_the_same_id_and_edits_in_place(rule_repo):
    original, _ = _make(rule_repo, value="COLES", category="groceries")
    updated = rule_repo.update_rule(original["id"], "description", "contains", "COLES", "coffee")
    assert updated["id"] == original["id"]
    assert updated["category_id"] == "coffee"
    assert rule_repo.get_rule(original["id"])["category_id"] == "coffee"
    assert len(rule_repo.list_rules()) == 1


def test_update_case_only_edit_keeps_the_id(rule_repo):
    original, _ = _make(rule_repo, value="coles")
    updated = rule_repo.update_rule(original["id"], "description", "contains", "COLES", "groceries")
    assert updated["id"] == original["id"]            # folded text unchanged -> same id
    assert updated["value"] == "COLES"                # but the stored value reflects the edit
    assert len(rule_repo.list_rules()) == 1


def test_update_to_free_text_moves_the_row_and_carries_created_at(rule_repo):
    original, _ = _make(rule_repo, value="COLE")
    updated = rule_repo.update_rule(original["id"], "description", "contains", "COLES", "groceries")

    assert updated["id"] != original["id"]
    assert rule_repo.get_rule(original["id"]) is None          # old row gone
    assert rule_repo.get_rule(updated["id"]) == updated        # new row present
    assert updated["created_at"] == original["created_at"]     # created_at carried over
    assert len(rule_repo.list_rules()) == 1


def test_update_onto_another_rules_text_clashes(rule_repo):
    _make(rule_repo, value="WOOLWORTHS", category="groceries")
    editable, _ = _make(rule_repo, value="COLES", category="groceries")

    from repository_errors import RuleClashError
    with pytest.raises(RuleClashError):
        rule_repo.update_rule(editable["id"], "description", "contains", "WOOLWORTHS", "groceries")
    # Nothing moved: both rules still there, editable unchanged.
    assert len(rule_repo.list_rules()) == 2
    assert rule_repo.get_rule(editable["id"])["value"] == "COLES"


def test_update_unknown_id_raises_not_found(rule_repo):
    from repository_errors import RuleNotFoundError
    with pytest.raises(RuleNotFoundError):
        rule_repo.update_rule("deadbeefdeadbeef", "description", "contains", "COLES", "groceries")


def test_update_move_keeps_new_rule_even_if_deleting_the_old_row_fails(rule_repo, client_error):
    # Put-new then delete-old: if the delete fails, we favour a duplicate over data loss —
    # return the NEW rule and log. Re-issuing the same edit is safe-to-run-twice and retries it.
    original, _ = _make(rule_repo, value="COLE")

    def boom(**kwargs):
        raise client_error("InternalServerError")
    rule_repo._table.delete_item = boom

    updated = rule_repo.update_rule(original["id"], "description", "contains", "COLES", "groceries")
    assert updated["id"] != original["id"]
    assert rule_repo.get_rule(updated["id"]) == updated        # new row written
    assert rule_repo.get_rule(original["id"]) is not None       # old row survived the failed delete


# --- delete -------------------------------------------------------------------


def test_delete_rule_removes_it_and_is_safe_to_run_twice(rule_repo):
    rule, _ = _make(rule_repo)
    rule_repo.delete_rule(rule["id"])
    assert rule_repo.get_rule(rule["id"]) is None
    rule_repo.delete_rule(rule["id"])                          # second delete is a no-op
    assert rule_repo.get_rule(rule["id"]) is None


def test_list_rules_reads_only_the_rule_partition_and_reports_failures_as_list_rules(
        rule_repo, client_error, database_error):
    rule_repo._table.seed(
        *({"pk": "RULE", "sk": f"RULE#{number}", "id": str(number)} for number in range(5)),
        {"pk": "JOB", "sk": "JOB#1", "id": "job"},
    )
    rule_repo._table.page_size = 2

    assert sorted(rule["id"] for rule in rule_repo.list_rules()) == ["0", "1", "2", "3", "4"]

    rule_repo._table.fail("query", client_error("InternalServerError", "down"))
    with pytest.raises(database_error):
        rule_repo.list_rules()


def test_create_persists_budget_excluded_and_round_trips(rule_repo):
    rule, created = _make(rule_repo, budget_excluded=True)
    assert created is True
    assert rule["budget_excluded"] is True
    assert rule_repo.get_rule(rule["id"])["budget_excluded"] is True
    assert rule_repo.list_rules()[0]["budget_excluded"] is True


def test_same_text_same_category_different_flag_clashes(rule_repo):
    # FAIL-ON-REVERT for the new clash dimension: drop
    # `bool(existing.get("budget_excluded")) != budget_excluded` from create_rule's clash test and
    # the second create returns created=False (silently keeping the first's flag) instead of clashing.
    from repository_errors import RuleClashError
    first, _ = _make(rule_repo, budget_excluded=False)
    with pytest.raises(RuleClashError) as excinfo:
        _make(rule_repo, budget_excluded=True)
    assert excinfo.value.existing["id"] == first["id"]
    assert len(rule_repo.list_rules()) == 1


def test_update_in_place_toggles_the_flag(rule_repo):
    created, _ = _make(rule_repo, budget_excluded=False)
    # Same text + same category, only the flag changes -> an in-place update.
    updated = rule_repo.update_rule(created["id"], "description", "contains", "COLES", "groceries",
                                    budget_excluded=True)
    assert updated["budget_excluded"] is True
    assert rule_repo.get_rule(created["id"])["budget_excluded"] is True
    rule_repo.update_rule(created["id"], "description", "contains", "COLES", "groceries",
                          budget_excluded=False)
    assert rule_repo.get_rule(created["id"])["budget_excluded"] is False


def test_update_in_place_conditional_check_failed_raises_not_found(rule_repo, client_error):
    # Row exists at the read, then is deleted before the conditional update_item lands:
    # attribute_exists(pk) fails -> RuleNotFoundError (not a silent success, not a DB fault).
    from repository_errors import RuleNotFoundError
    original, _ = _make(rule_repo, value="COLES", category="groceries")

    def refuse(**kwargs):
        raise client_error("ConditionalCheckFailedException")
    rule_repo._table.update_item = refuse
    with pytest.raises(RuleNotFoundError):
        rule_repo.update_rule(original["id"], "description", "contains", "COLES", "coffee")


def test_update_move_new_put_conditional_check_failed_raises_clash(rule_repo, client_error):
    # The move path checked get_rule(new_id) is None, then a CONCURRENT create landed the new_id
    # row before our put. The conditional put fails -> RuleClashError carrying the row that won.
    from repository_errors import RuleClashError
    original, _ = _make(rule_repo, value="COLE")

    def racing_put(Item=None, ConditionExpression=None):
        # simulate the concurrent writer landing between our check and our put
        rule_repo._table.store[(Item["pk"], Item["sk"])] = {**dict(Item), "category_id": "someone_else"}
        raise client_error("ConditionalCheckFailedException")
    rule_repo._table.put_item = racing_put

    with pytest.raises(RuleClashError) as excinfo:
        rule_repo.update_rule(original["id"], "description", "contains", "COLES", "groceries")
    assert excinfo.value.existing is not None
    assert excinfo.value.existing["category_id"] == "someone_else"
    # The old row was never touched (delete only runs after a successful put).
    assert rule_repo.get_rule(original["id"]) is not None


def _conditions():
    return [{"field": "merchant", "operator": "contains", "value": "uber"},
            {"field": "amount", "operator": "less_than", "value": "30"}]


def test_create_multi_condition_rule_round_trips(rule_repo):
    import rule_engine
    rule, created = rule_repo.create_rule("merchant", "contains", "uber", "transport",
                                          conditions=_conditions(), logic="all")
    assert created is True
    assert rule["conditions"] == _conditions()
    assert rule["logic"] == "all"
    assert rule["id"] == rule_engine.rule_id_for_conditions(_conditions(), "all")
    stored = rule_repo.get_rule(rule["id"])
    assert stored["conditions"] == _conditions() and stored["logic"] == "all"


def test_in_place_edit_of_a_multi_rule_preserves_its_conditions(rule_repo):
    # An in-place edit (same conditions -> same id, only the target category changes) must RE-WRITE
    # conditions/logic on the row, not drop them. FAIL-ON-REVERT: if _update_in_place stopped SETting
    # conditions on a multi rule, the stored row would keep the OLD category but could lose its
    # conditions, and decide's multi-rule guard would then read a lying (single-shaped) row.
    created, _ = rule_repo.create_rule("merchant", "contains", "uber", "transport",
                                       conditions=_conditions(), logic="all")
    rule_id = created["id"]
    updated = rule_repo.update_rule(rule_id, "merchant", "contains", "uber", "groceries",
                                    conditions=_conditions(), logic="all")
    assert updated["id"] == rule_id                         # in place: id unchanged
    assert updated["category_id"] == "groceries"
    assert updated["conditions"] == _conditions() and updated["logic"] == "all"
    stored = rule_repo.get_rule(rule_id)
    assert stored["conditions"] == _conditions() and stored["logic"] == "all"
    assert stored["category_id"] == "groceries"
    assert len(rule_repo.list_rules()) == 1                 # still one row, not a new id
