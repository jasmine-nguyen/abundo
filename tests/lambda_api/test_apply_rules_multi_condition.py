"""WHIT-561: the "apply my rules" sweep files stored charges by a multi-condition rule. Reuses the
realistic WritableFeedRepo + FakeRuleRepo, like test_apply_rules.py."""

import json

from decimal import Decimal

from _feed_fakes import SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _multi_row(conditions, logic="all", category_id="transport", rule_id="m1"):
    first = conditions[0]
    return {"id": rule_id, "field": first["field"], "operator": first["operator"],
            "value": first["value"], "category_id": category_id,
            "conditions": conditions, "logic": logic}


def _apply_event(body):
    return {"rawPath": "/transactions/uncategorized/apply-rules",
            "requestContext": {"http": {"method": "POST"}}, "body": json.dumps(body)}


def _call(handler, repo, rules, body, categories=frozenset({"transport", "groceries"})):
    resp = handler.apply_rules_to_uncategorized(
        _apply_event(body), repo, FakeCategoryRepo(categories), FakeRuleRepo(rules=rules))
    return resp, json.loads(resp["body"])


_UNDER_30 = [{"field": "merchant", "operator": "contains", "value": "uber"},
             {"field": "amount", "operator": "less_than", "value": "30"}]


def _charge(txn_id="t1", merchant_name="UBER", amount=Decimal("-25.00")):
    return _row(SPENDING, "2026-07-01", txn_id, description="UBER TRIP",
                merchant_name=merchant_name, amount=amount, category=None)


def test_sweep_files_a_charge_matching_every_condition(handler):
    repo = WritableFeedRepo({SPENDING: [_charge(amount=Decimal("-25.00"))]})
    _call(handler, repo, [_multi_row(_UNDER_30)], {"dryRun": False})
    row = repo._find_row(f"ACCOUNT#{SPENDING}", "TXN#t1")
    assert row["category"] == "transport"


def test_sweep_skips_a_charge_that_misses_an_and_condition(handler):
    repo = WritableFeedRepo({SPENDING: [_charge(amount=Decimal("-40.00"))]})   # amount too big
    _resp, body = _call(handler, repo, [_multi_row(_UNDER_30)], {"dryRun": False})
    row = repo._find_row(f"ACCOUNT#{SPENDING}", "TXN#t1")
    assert row.get("category") is None
    assert body["matched"] == 0


def test_sweep_preview_counts_a_multi_condition_match(handler):
    repo = WritableFeedRepo({SPENDING: [_charge(amount=Decimal("-25.00"))]})
    _resp, body = _call(handler, repo, [_multi_row(_UNDER_30)], {"dryRun": True})
    assert body["matched"] == 1
    assert repo.writes == []
