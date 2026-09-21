"""WHIT-540 — the reconcile sweep's `not is_unfiled(target)` guard.

A live rule can point at a category the user has since DELETED from their taxonomy. A charge that
rule already filed still carries the rule's stamp, so the drift branch of the sweep would otherwise
"heal" it onto that dead category. The guard skips it instead: don't churn a charge onto a category
that no longer exists, and don't clear it either (the rule is still live, so it isn't an orphan).

Drives the plain "Apply my rules" route directly with WritableFeedRepo + FakeRuleRepo +
FakeCategoryRepo, like test_apply_rules_orphan_sweep.py. NOT a duplicate of the drift-reconcile /
onTarget cases there: those keep the rule's target IN the taxonomy; this one deletes it.
"""

import json

from _feed_fakes import SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _rule(value, category_id="groceries", field="description", operator="contains"):
    return {"field": field, "operator": operator, "value": value, "category_id": category_id}


def _apply(handler, repo, rule_repo, body, categories):
    event = {"rawPath": "/transactions/uncategorized/apply-rules",
             "requestContext": {"http": {"method": "POST"}}, "body": json.dumps(body)}
    resp = handler.apply_rules_to_uncategorized(
        event, repo, FakeCategoryRepo(categories), rule_repo)
    return resp, json.loads(resp["body"])


def _row_at(repo, txn_id, account=SPENDING):
    return repo._find_row(f"ACCOUNT#{account}", f"TXN#{txn_id}")


def test_sweep_leaves_a_charge_whose_live_rule_points_at_a_deleted_category(handler):
    # Rule "coles" -> "petrol" is LIVE, but "petrol" has been deleted from the taxonomy (only
    # "groceries" remains). "stuck" was filed to groceries by that rule (stamp = live id) and now
    # sits off the rule's current target. The drift branch WOULD move it to "petrol"; the
    # `not is_unfiled(target)` guard skips it so the charge is neither churned onto a dead category
    # nor cleared (the rule still exists). FAIL-ON-REVERT: drop `not is_unfiled(target) and` from
    # the elif and the charge is re-filed onto the deleted "petrol" and repo.writes is non-empty.
    rule_repo = FakeRuleRepo(rules=[_rule("coles", "petrol")])
    live = rule_repo.list_rules()[0]["id"]
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "stuck", description="COLES",
             category="groceries", filed_by_rule=live),
    ]})

    _, body = _apply(handler, repo, rule_repo, {"dryRun": False}, categories={"groceries"})

    row = _row_at(repo, "stuck")
    assert row["category"] == "groceries"       # not churned onto the deleted "petrol"
    assert row["filed_by_rule"] == live         # not cleared — the rule is still live
    assert repo.writes == []                    # the sweep wrote nothing at all this run
