"""Tests for shared/repository_rule.py — our own rule store (WHIT-528).

Run against the real conftest FakeTable (which honours attribute_not_exists / attribute_exists
conditions), so the dedup guard, the clash, and the delete-twice safety are exercised for real
rather than mocked away. The id logic lives in rule_engine (tested there); here we test the
storage behaviour built on it.
"""

import pathlib

import pytest


def _make(rule_repo, value="COLES", category="groceries", field="description",
          operator="contains", **kwargs):
    return rule_repo.create_rule(field, operator, value, category, **kwargs)


# --- create: dedup + clash ----------------------------------------------------


def test_create_returns_the_row_and_created_true(rule_repo):
    rule, created = _make(rule_repo)
    assert created is True
    assert rule["id"] and rule["pk"] == "RULE" and rule["sk"] == f"RULE#{rule['id']}"
    assert rule["field"] == "description" and rule["value"] == "COLES"
    assert rule["category_id"] == "groceries" and rule["source"] == "app"
    assert rule["created_at"] and rule["updated_at"] == rule["created_at"]


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


def test_get_rule_returns_none_for_a_missing_id(rule_repo):
    assert rule_repo.get_rule("deadbeefdeadbeef") is None


def test_get_rule_round_trips_a_created_rule(rule_repo):
    rule, _ = _make(rule_repo)
    assert rule_repo.get_rule(rule["id"]) == rule


def test_list_rules_returns_every_rule(rule_repo):
    _make(rule_repo, value="COLES")
    _make(rule_repo, value="WOOLWORTHS")
    _make(rule_repo, value="ALDI")
    assert len(rule_repo.list_rules()) == 3


def test_list_rules_pages_through_every_partition_page(rule_repo):
    # The loop that makes "no 100 cap" real: a single Query returns one page, so list_rules must
    # follow LastEvaluatedKey. A stub table hands back two pages; all rows must come through.
    class _TwoPageTable:
        def __init__(self):
            self.rows = [{"pk": "RULE", "sk": f"RULE#{i}", "id": str(i)} for i in range(3)]
            self.query_calls = 0

        def query(self, **kwargs):
            self.query_calls += 1
            if "ExclusiveStartKey" not in kwargs:
                return {"Items": self.rows[:2],
                        "LastEvaluatedKey": {"pk": "RULE", "sk": self.rows[1]["sk"]}}
            return {"Items": self.rows[2:]}

    rule_repo._table = _TwoPageTable()
    rules = rule_repo.list_rules()
    assert [r["id"] for r in rules] == ["0", "1", "2"]
    assert rule_repo._table.query_calls == 2


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


def test_delete_calls_delete_item_with_key_only(rule_repo):
    # The delete is a bare no-op-on-missing call; the recording stub asserts no ConditionExpression
    # rides along (the pk is a literal "RULE", the value the IAM DeleteItem grant pins).
    rule, _ = _make(rule_repo)
    seen = {}

    def record(Key, **kwargs):
        seen["Key"] = Key
        seen["kwargs"] = kwargs
    rule_repo._table.delete_item = record
    rule_repo.delete_rule(rule["id"])
    assert seen["Key"] == {"pk": "RULE", "sk": f"RULE#{rule['id']}"}
    assert seen["kwargs"] == {}


# --- the constants-free landmine ----------------------------------------------


def test_repository_rule_imports_no_constants():
    # The shared layer is shadowed by lambda_api/constants.py at runtime, so a
    # `from constants import` here would 500 the deployed API. test_constants_sync guards the
    # whole layer; this pins the new module explicitly (fail-on-revert for the landmine).
    source = (pathlib.Path(__file__).resolve().parents[2] / "shared" / "repository_rule.py").read_text()
    assert "from constants import" not in source
    assert "import constants" not in source


# --- smooth action (WHIT-559): the second action flag + its captured bill ----------------------

from decimal import Decimal  # noqa: E402


def test_create_smooth_stores_the_flag_and_the_captured_bill(rule_repo):
    rule, created = _make(rule_repo, smooth=True, smooth_amount=Decimal("42.50"), smooth_gap_days=30)
    assert created is True
    assert rule["smooth"] is True
    assert rule["smooth_amount"] == Decimal("42.50")
    assert rule["smooth_gap_days"] == 30
    assert rule["smooth_seeded"] is False   # armed, not yet seeded


def test_create_non_smooth_carries_only_the_flag(rule_repo):
    rule, _ = _make(rule_repo)
    assert rule["smooth"] is False
    assert "smooth_amount" not in rule and "smooth_gap_days" not in rule and "smooth_seeded" not in rule


def test_same_text_different_smooth_flag_clashes_never_a_second_row(rule_repo):
    # FAIL-ON-REVERT: smooth is a clash dimension like budget_excluded, NOT part of the id — the same
    # text with a different smooth flag must 409, not mint a second row. Drop the smooth check from
    # create_rule's clash compare and this reddens (it would return the existing row as created=False).
    _make(rule_repo, smooth=False)
    from repository_errors import RuleClashError
    with pytest.raises(RuleClashError):
        _make(rule_repo, smooth=True, smooth_amount=Decimal("42.50"), smooth_gap_days=30)
    assert len(rule_repo.list_rules()) == 1


def test_update_in_place_turning_smooth_on_arms_seeded_false(rule_repo):
    rule, _ = _make(rule_repo, category="groceries")
    updated = rule_repo.update_rule(rule["id"], "description", "contains", "COLES", "groceries",
                                    smooth=True, smooth_amount=Decimal("80.00"), smooth_gap_days=14)
    assert updated["smooth"] is True
    assert updated["smooth_amount"] == Decimal("80.00") and updated["smooth_gap_days"] == 14
    assert rule_repo.get_rule(rule["id"])["smooth_seeded"] is False


def test_update_in_place_editing_a_seeded_smooth_rule_keeps_it_dismissed(rule_repo):
    # FAIL-ON-REVERT for "stay dismissed": a rule already seeded (its plan created, then perhaps
    # deleted by the user) must NOT re-arm on an unrelated edit. Reset smooth_seeded to False on every
    # in-place edit and this reddens.
    rule, _ = _make(rule_repo, smooth=True, smooth_amount=Decimal("42.50"), smooth_gap_days=30)
    seeded = {**rule_repo.get_rule(rule["id"]), "smooth_seeded": True}
    rule_repo._table.put_item(Item=seeded)   # simulate the apply path having seeded the plan

    rule_repo.update_rule(rule["id"], "description", "contains", "COLES", "coffee",
                          smooth=True, smooth_amount=Decimal("42.50"), smooth_gap_days=30)

    assert rule_repo.get_rule(rule["id"])["smooth_seeded"] is True   # still dismissed


def test_update_in_place_turning_smooth_off_sheds_the_captured_bill(rule_repo):
    rule, _ = _make(rule_repo, smooth=True, smooth_amount=Decimal("42.50"), smooth_gap_days=30)
    rule_repo.update_rule(rule["id"], "description", "contains", "COLES", "groceries", smooth=False)
    stored = rule_repo.get_rule(rule["id"])
    assert stored["smooth"] is False
    assert "smooth_amount" not in stored and "smooth_gap_days" not in stored
    assert "smooth_seeded" not in stored


def test_text_edit_moves_a_smooth_rule_and_rearms_seeded_false(rule_repo):
    rule, _ = _make(rule_repo, value="COLES", smooth=True,
                    smooth_amount=Decimal("42.50"), smooth_gap_days=30)
    seeded = {**rule_repo.get_rule(rule["id"]), "smooth_seeded": True}
    rule_repo._table.put_item(Item=seeded)

    moved = rule_repo.update_rule(rule["id"], "description", "contains", "WOOLWORTHS", "groceries",
                                  smooth=True, smooth_amount=Decimal("42.50"), smooth_gap_days=30)

    # A text edit is a fresh row under a new id — the old one retired — so the marker re-arms.
    assert moved["id"] != rule["id"]
    assert moved["smooth_seeded"] is False
    assert rule_repo.get_rule(rule["id"]) is None
