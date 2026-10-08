"""WHIT-625 slice 2 — the rule sweep and the rule re-file run on the REAL repositories.

The apply-rules / refile suites used to drive hand-written fakes (WritableFeedRepo, FakeRuleRepo)
that copied the database rules: the "only if unchanged" write, the rule stamp, rule ids and dedup.
These tests build the real TransactionRepository and RuleRepository over one FakeTable through
`_feed_fakes.real_repos`, so the conditions that protect a user's tap are the production ones.

A tap mid-run is simulated with the table's own `before_write` hook — a concurrent writer editing
the stored row — not by a fake deciding the outcome.
"""

import json

from _api_event import api_event
from _feed_fakes import SPENDING, FakeCategoryRepo, _row, real_repos
from _rule_ingest_fakes import apply_rules_to_uncategorized


def _stored(table, transaction_id, account=SPENDING):
    return table.store[(f"ACCOUNT#{account}", f"TXN#{transaction_id}")]


def _tap(table, transaction_id, category, account=SPENDING):
    """The user hand-files a charge: the category changes and the rule stamp goes (WHIT-536)."""
    row = _stored(table, transaction_id, account)
    row["category"] = category
    row.pop("filed_by_rule", None)


def test_apply_rules_files_through_the_real_repositories_and_a_mid_run_tap_wins(handler):
    table, transaction_repo, rule_repo = real_repos(
        rows_by_account={SPENDING: [
            _row(SPENDING, "2026-07-02", "t1", description="COLES 1"),
            _row(SPENDING, "2026-07-01", "t2", description="COLES 2"),
        ]},
        rules=[{"field": "description", "operator": "contains", "value": "coles",
                "category_id": "groceries"}],
    )
    [rule] = rule_repo.list_rules()

    # The user taps "coffee" on t2 while the run is writing t1.
    table.before_write(
        lambda key, tbl: _tap(tbl, "t2", "coffee") if key["sk"] == "TXN#t1" else None)

    resp = apply_rules_to_uncategorized(
        handler,
        api_event("POST", "/transactions/uncategorized/apply-rules", body={"dryRun": False}),
        transaction_repo, FakeCategoryRepo(("groceries", "coffee")), rule_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["filed"] == [{"id": "t1", "category": "groceries"}]
    assert body["alreadyFiled"] == ["t2"]
    assert _stored(table, "t1")["category"] == "groceries"
    assert _stored(table, "t1")["filed_by_rule"] == rule["id"]   # the id production minted
    assert _stored(table, "t2")["category"] == "coffee"           # the real condition refused
    assert "filed_by_rule" not in _stored(table, "t2")


def test_deleting_a_rule_undoes_its_fills_through_the_real_repositories(handler):
    table, transaction_repo, rule_repo = real_repos(
        rows_by_account={},
        rules=[{"field": "description", "operator": "contains", "value": "coles",
                "category_id": "groceries"}],
    )
    [rule] = rule_repo.list_rules()
    rule_id = rule["id"]
    table.seed(
        _row(SPENDING, "2026-07-03", "a", description="COLES 1",
             category="groceries", filed_by_rule=rule_id),
        _row(SPENDING, "2026-07-02", "b", description="COLES 2",
             category="groceries", filed_by_rule=rule_id),
        _row(SPENDING, "2026-07-01", "other", description="ALDI",
             category="groceries", filed_by_rule="other-rule"),
    )
    # The user hand-files "b" while the undo is clearing "a".
    table.before_write(
        lambda key, tbl: _tap(tbl, "b", "coffee") if key["sk"] == "TXN#a" else None)

    resp = handler.delete_rule_route(
        api_event("DELETE", f"/rules/{rule_id}", path_params={"id": rule_id}),
        rule_repo, transaction_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body == {"id": rule_id, "remaining": 0}
    assert rule_repo.list_rules() == []
    assert "category" not in _stored(table, "a") and "filed_by_rule" not in _stored(table, "a")
    assert _stored(table, "b")["category"] == "coffee"                  # the tap stands
    assert _stored(table, "other")["filed_by_rule"] == "other-rule"     # not this rule's
