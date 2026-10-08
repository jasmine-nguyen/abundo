"""WHIT-561: the "apply my rules" sweep files stored charges by a multi-condition rule. Runs the
real TransactionRepository and RuleRepository over one FakeTable, like test_apply_rules.py."""

import json

from decimal import Decimal

from _feed_fakes import apply_rules_event, SPENDING, FakeCategoryRepo, real_repos, _row, stored
from _rule_ingest_fakes import apply_rules_to_uncategorized


def _multi_rule(conditions, logic="all", category_id="transport"):
    # The kwargs of one real RuleRepository.create_rule call.
    first = conditions[0]
    return {"field": first["field"], "operator": first["operator"], "value": first["value"],
            "category_id": category_id, "conditions": conditions, "logic": logic}


def _call(handler, charge, rules, body, categories=frozenset({"transport", "groceries"})):
    """Run the sweep over one stored charge; returns (body, table)."""
    table, repo, rule_repo = real_repos({SPENDING: [charge]}, rules=rules)
    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event(body), repo, FakeCategoryRepo(categories), rule_repo)
    return json.loads(resp["body"]), table


_UNDER_30 = [{"field": "merchant", "operator": "contains", "value": "uber"},
             {"field": "amount", "operator": "less_than", "value": "30"}]


def _charge(txn_id="t1", merchant_name="UBER", amount=Decimal("-25.00")):
    return _row(SPENDING, "2026-07-01", txn_id, description="UBER TRIP",
                merchant_name=merchant_name, amount=amount)


def test_sweep_files_a_charge_matching_every_condition(handler):
    _, table = _call(handler, _charge(amount=Decimal("-25.00")), [_multi_rule(_UNDER_30)],
                     {"dryRun": False})
    assert stored(table, "t1")["category"] == "transport"


def test_sweep_skips_a_charge_that_misses_an_and_condition(handler):
    body, table = _call(handler, _charge(amount=Decimal("-40.00")),   # amount too big
                        [_multi_rule(_UNDER_30)], {"dryRun": False})
    assert stored(table, "t1").get("category") is None
    assert body["matched"] == 0


def test_sweep_preview_counts_a_multi_condition_match(handler):
    body, table = _call(handler, _charge(amount=Decimal("-25.00")), [_multi_rule(_UNDER_30)],
                        {"dryRun": True})
    assert body["matched"] == 1
    assert table.update_calls == []
