"""WHIT-558 gap — the "forward only" guarantee, pinned.

Editing a rule's budget flag must NOT retroactively change charges the rule ALREADY filed: the
WHIT-540 re-file path re-keys category + stamp only (refile_rule_fill), never budget_excluded. So
turning a rule's "keep out of budget" ON and saving re-files its charges to the new target but
leaves their budget_excluded untouched — a charge already counting keeps counting until it is filed
fresh. This is the accepted, deliberate gap; this test pins the ACTUAL behaviour so a later change
that quietly starts (or stops) carrying the flag on re-file is caught.

Same handler + WritableFeedRepo/FakeRuleRepo harness as test_rule_refile.py.
"""

import json

from _feed_fakes import SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo

_CATEGORIES = ("groceries", "petrol", "coffee")


def _rule(value, category_id="groceries", *, budget_excluded=False):
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id, "budget_excluded": budget_excluded}


def _put_event(rule_id, value, category_id, budget_excluded):
    return {
        "rawPath": f"/rules/{rule_id}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"id": rule_id},
        "body": json.dumps({"value": value, "categoryId": category_id,
                            "field": "description", "operator": "contains",
                            "budgetExcluded": budget_excluded}),
    }


def _row_at(repo, txn_id):
    return repo._find_row(f"ACCOUNT#{SPENDING}", f"TXN#{txn_id}")


def test_turning_a_rules_flag_on_does_not_exclude_already_filed_charges(handler):
    # A rule (flag OFF) already filed a charge into groceries. The user edits the rule target and
    # turns "keep out of budget" ON. The charge is re-filed (category moves) but its budget_excluded
    # must stay ABSENT — forward only. FAIL-ON-REVERT if the re-file path ever starts carrying the
    # flag: this row would gain budget_excluded and the assertion reddens.
    rule_repo = FakeRuleRepo(rules=[_rule("coles", "groceries", budget_excluded=False)])
    rid = rule_repo.list_rules()[0]["id"]
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "a", description="COLES 1",
             category="groceries", filed_by_rule=rid),
    ]})

    resp = handler.update_rule_route(
        _put_event(rid, "coles", "petrol", True), rule_repo,
        FakeCategoryRepo(_CATEGORIES), repo)

    assert resp["statusCode"] == 200
    # The rule row DID take the flag (forward, for future fills)…
    assert rule_repo.get_rule(rid)["budget_excluded"] is True
    row = _row_at(repo, "a")
    assert row["category"] == "petrol"              # re-filed to the new target
    assert "budget_excluded" not in row             # …but the OLD charge is untouched (forward only)
