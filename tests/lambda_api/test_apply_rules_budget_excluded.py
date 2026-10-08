"""WHIT-558: the "Apply my rules" sweep and the inline "file this shop" mint keep a charge out of
the budget when the winning rule says so — set in the SAME conditional write as the category, so it
never lands on a row the tap-wins guard rejected, and never overwrites a user's hand-set choice.

Runs the real TransactionRepository and RuleRepository over one FakeTable, like test_apply_rules.py.
"""

import json

from _feed_fakes import apply_rules_event, SPENDING, FakeCategoryRepo, real_repos, _row, stored
from _rule_ingest_fakes import apply_rules_to_uncategorized


def _rule(value, category_id="groceries", *, budget_excluded=False):
    # The kwargs of one real RuleRepository.create_rule call.
    return {"field": "description", "operator": "contains",
            "value": value, "category_id": category_id, "budget_excluded": budget_excluded}


def _call(handler, row, rules, body, categories=frozenset({"groceries", "coffee"})):
    """Run the sweep over one stored charge; returns (resp, body, table)."""
    table, repo, rule_repo = real_repos({SPENDING: [row]}, rules=rules)
    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event(body), repo, FakeCategoryRepo(categories), rule_repo)
    return resp, json.loads(resp["body"]), table


def test_sweep_sets_budget_excluded_from_the_winning_rule(handler):
    row = _row(SPENDING, "2026-07-01", "t1", description="COLES 1")
    _, _, table = _call(handler, row, [_rule("coles", budget_excluded=True)], {"dryRun": False})
    row = stored(table, "t1")
    assert row["category"] == "groceries"
    assert row["budget_excluded"] is True


def test_sweep_does_not_exclude_when_the_rule_flag_is_off(handler):
    # FAIL-ON-REVERT: passing budget_excluded unconditionally (or defaulting it True) would exclude
    # a charge whose rule never asked to.
    row = _row(SPENDING, "2026-07-01", "t1", description="COLES 1")
    _, _, table = _call(handler, row, [_rule("coles", budget_excluded=False)], {"dryRun": False})
    row = stored(table, "t1")
    assert row["category"] == "groceries"
    assert "budget_excluded" not in row


def test_inline_file_this_shop_excludes_when_requested(handler):
    row = _row(SPENDING, "2026-07-01", "t1", description="ALDI 1")
    body = {"dryRun": False,
            "rule": {"value": "ALDI", "categoryId": "groceries", "budgetExcluded": True}}
    _, _, table = _call(handler, row, [], body)
    row = stored(table, "t1")
    assert row["category"] == "groceries"
    assert row["budget_excluded"] is True


def test_inline_file_this_shop_without_flag_does_not_exclude(handler):
    row = _row(SPENDING, "2026-07-01", "t1", description="ALDI 1")
    body = {"dryRun": False, "rule": {"value": "ALDI", "categoryId": "groceries"}}
    _, _, table = _call(handler, row, [], body)
    row = stored(table, "t1")
    assert row["category"] == "groceries"
    assert "budget_excluded" not in row


def test_user_hand_set_exclusion_survives_a_non_excluding_rule(handler):
    # The user hand-excluded an UNFILED charge (budget_excluded=True already present). A rule with the
    # flag OFF then files it: the category lands, but the user's exclusion must SURVIVE — a rule never
    # writes False, so their tap always wins.
    row = _row(SPENDING, "2026-07-01", "t1", description="COLES 1", budget_excluded=True)
    _, _, table = _call(handler, row, [_rule("coles", budget_excluded=False)], {"dryRun": False})
    row = stored(table, "t1")
    assert row["category"] == "groceries"
    assert row["budget_excluded"] is True


def test_inline_mint_clashing_only_on_the_flag_is_refused_in_the_preview(handler):
    # WHIT-558 coherence: an existing "ALDI -> groceries" (not excluded); the inline mint wants
    # "ALDI -> groceries + keep out of budget". create_rule would clash on the differing flag, so the
    # DRY-RUN preview must report the clash too — else it promises a filing the commit then 409s.
    # FAIL-ON-REVERT: drop `_rule_that_would_clash_on_exclusion` from the pre-scan and the preview
    # returns 200 "would file" instead of 409. The existing rule carries its REAL derived id (no
    # hardcoded id) so the pre-scan's id match is exercised.
    existing = {"field": "description", "operator": "contains", "value": "ALDI",
                "category_id": "groceries", "budget_excluded": False}
    row = _row(SPENDING, "2026-07-01", "t1", description="ALDI 1")
    body = {"dryRun": True,
            "rule": {"value": "ALDI", "categoryId": "groceries", "budgetExcluded": True}}
    resp, _, table = _call(handler, row, [existing], body)
    assert resp["statusCode"] == 409
    assert table.update_calls == []


def test_inline_rule_rejects_a_non_boolean_budget_excluded(handler):
    row = _row(SPENDING, "2026-07-01", "t1", description="ALDI 1")
    body = {"dryRun": False,
            "rule": {"value": "ALDI", "categoryId": "groceries", "budgetExcluded": "yes"}}
    resp, _, table = _call(handler, row, [], body)
    assert resp["statusCode"] == 400
    assert table.update_calls == []


def test_validate_rule_body_rejects_a_non_boolean_budget_excluded(handler):
    event = {"body": json.dumps({"value": "COLES", "categoryId": "groceries",
                                 "budgetExcluded": "yes"})}
    parsed, error = handler._validate_rule_body(event)
    assert parsed is None
    assert error["statusCode"] == 400
