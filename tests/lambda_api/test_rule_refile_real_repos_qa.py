"""WHIT-625 slice 2 QA — the re-file and undo tap-wins guards, on the real code.

Editing or deleting a rule re-files / undoes the charges it stamped (WHIT-540). Each write is
conditioned on the stamp still being the rule's, so a user who hand-files a charge between the
scan and the write keeps their choice. The migrated suites only race a tap against the sweep's
category write, so nothing drove these two stamp conditions through the real repository: loosening
either one left every suite green. These tests race a tap against each of them.
"""

import json

from _api_event import api_event
from _feed_fakes import SPENDING, FakeCategoryRepo, _row, on_write, real_repos, stored
from _rule_ingest_fakes import apply_rules_to_uncategorized

_CATEGORIES = frozenset({"groceries", "petrol", "eatingout"})


def _tap(category, transaction_id):
    """The user hand-files a charge: the category changes and the rule stamp goes (WHIT-536)."""
    def action(table):
        row = stored(table, transaction_id)
        row["category"] = category
        row.pop("filed_by_rule", None)
    return action


def _two_stamped_charges(value="coles"):
    table, transaction_repo, rule_repo = real_repos(
        rules=[{"field": "description", "operator": "contains", "value": value,
                "category_id": "groceries"}])
    rule_id = rule_repo.list_rules()[0]["id"]
    table.seed(
        _row(SPENDING, "2026-07-02", "a", description="COLES 1",
             category="groceries", filed_by_rule=rule_id),
        _row(SPENDING, "2026-07-01", "b", description="COLES 2",
             category="groceries", filed_by_rule=rule_id),
    )
    return table, transaction_repo, rule_repo, rule_id


def _put(handler, rule_repo, transaction_repo, rule_id, value, category_id):
    event = api_event(
        "PUT",
        f"/rules/{rule_id}",
        body={"value": value, "categoryId": category_id,
              "field": "description", "operator": "contains"},
        path_params={"id": rule_id},
    )
    resp = handler.update_rule_route(event, rule_repo, FakeCategoryRepo(_CATEGORIES),
                                     transaction_repo)
    return resp, json.loads(resp["body"])


def test_a_tap_mid_refile_keeps_the_users_category(handler):
    # [A4] Target-only edit (groceries -> petrol) re-files both charges; the user taps b to
    # "eatingout" while a is being written. The real stamp condition must refuse b's re-file.
    table, transaction_repo, rule_repo, rule_id = _two_stamped_charges()
    on_write(table, "a", _tap("eatingout", "b"))

    resp, body = _put(handler, rule_repo, transaction_repo, rule_id, "coles", "petrol")

    assert resp["statusCode"] == 200
    assert stored(table, "a")["category"] == "petrol"
    assert stored(table, "a")["filed_by_rule"] == body["id"]
    assert stored(table, "b")["category"] == "eatingout"
    assert "filed_by_rule" not in stored(table, "b")


def test_a_same_category_tap_mid_refile_is_not_moved(handler):
    # [A5] The user hand-files b to the SAME category the rule gave it. Only the stamp tells the
    # tap apart, so the re-file must still skip b rather than move it to the new target.
    table, transaction_repo, rule_repo, rule_id = _two_stamped_charges()
    on_write(table, "a", _tap("groceries", "b"))

    _put(handler, rule_repo, transaction_repo, rule_id, "coles", "petrol")

    assert stored(table, "a")["category"] == "petrol"
    assert stored(table, "b")["category"] == "groceries"
    assert "filed_by_rule" not in stored(table, "b")


def test_a_tap_mid_edit_undo_keeps_the_users_category(handler):
    # [A6] A value edit ("coles" -> "coles express") that neither charge matches clears both
    # fills; the user taps b mid-run. The real clear_rule_fill condition must refuse b's undo.
    table, transaction_repo, rule_repo, rule_id = _two_stamped_charges()
    on_write(table, "a", _tap("eatingout", "b"))

    resp, _ = _put(handler, rule_repo, transaction_repo, rule_id, "coles express", "petrol")

    assert resp["statusCode"] == 200
    assert "category" not in stored(table, "a")
    assert "filed_by_rule" not in stored(table, "a")
    assert stored(table, "b")["category"] == "eatingout"


def test_a_tap_mid_sweep_reconcile_keeps_the_users_category(handler):
    # [A7] The sweep's reconcile pass undoes fills stamped by a rule that no longer exists. The user
    # taps b while a's orphaned fill is being cleared; the real stamp condition must refuse b's undo.
    # One live rule, or the sweep skips the history scan (and the reconcile pass) entirely.
    table, transaction_repo, rule_repo = real_repos(
        rules=[{"field": "description", "operator": "contains", "value": "aldi",
                "category_id": "groceries"}])
    table.seed(
        _row(SPENDING, "2026-07-02", "a", description="COLES 1",
             category="groceries", filed_by_rule="deleted-rule"),
        _row(SPENDING, "2026-07-01", "b", description="COLES 2",
             category="groceries", filed_by_rule="deleted-rule"),
    )
    on_write(table, "a", _tap("eatingout", "b"))

    resp = apply_rules_to_uncategorized(
        handler,
        api_event("POST", "/transactions/uncategorized/apply-rules", body={"dryRun": False}),
        transaction_repo, FakeCategoryRepo(_CATEGORIES), rule_repo)

    assert resp["statusCode"] == 200
    assert "category" not in stored(table, "a")
    assert stored(table, "b")["category"] == "eatingout"
