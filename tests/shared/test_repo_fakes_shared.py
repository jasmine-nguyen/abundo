"""WHIT-755 slice 2: one shared pay-cycle stand-in and one shared category stand-in.

  * the shared fakes gain a read counter and an optional "fail on purpose" error;
  * the budgets, breakdown, alerts, rules and mirror suites drop their own copies.
"""

import ast
import pathlib

import pytest

_TESTS = pathlib.Path(__file__).resolve().parents[1]                 # tests/

# file → the local copies the plan deletes. A subclass of the shared fake (it has a
# base class) is allowed: it keeps only its real extra behaviour.
_COPIES = {
    "lambda_api/test_category_transactions.py": {"_FakePayCycleRepo", "_FakeCategoryRepo"},
    "lambda_api/test_cycle_transactions.py": {"_FakePayCycleRepo"},
    "lambda_api/test_cycle_transactions_qa.py": {"_FakePayCycleRepo"},
    "lambda_api/test_cycle_budgets.py": {"_FakePayCycleRepo", "_FakeCategoryRepo"},
    "lambda_api/test_cycle_budgets_qa.py": {"_FakePayCycleRepo"},
    "lambda_api/test_budgets_spread.py": {"FakePayCycleRepo", "FakeCategoryRepo"},
    "lambda_api/test_budgets_spread_gaps.py": {"FakePayCycleRepo", "FakeCategoryRepo"},
    "lambda_api/test_budgets_rollover.py": {"FakePayCycleRepo", "FakeCategoryRepo"},
    "lambda_api/test_budgets_rollover_gaps.py": {"FakePayCycleRepo", "FakeCategoryRepo"},
    "lambda_api/test_budgets_available.py": {"FakePayCycleRepo", "FakeCategoryRepo"},
    "lambda_api/test_budgets_available_gaps.py": {"FakePayCycleRepo", "FakeCategoryRepo"},
    "lambda_api/test_whit474_e2e_gaps.py": {"FakePayCycleRepo"},
    "lambda_api/test_budgets.py": {"FakePayCycleRepo", "FakeCategoryRepo"},
    "lambda_api/test_breakdown.py": {"FakePayCycleRepo", "FakeCategoryRepo"},
    "lambda_api/test_breakdown_lookback.py": {"FakePayCycleRepo", "FakeCategoryRepo"},
    "lambda_api/test_insights_ai.py": {"_FakePayCycleRepo", "_FakeCategoryRepo"},
    "lambda_api/test_shortfall_seam.py": {"_FakePayCycleRepo", "_FakeCategoryRepo"},
    "lambda_api/test_ai_chat_budget_standing_qa.py": {"_Categories"},
    "lambda_api/test_budget_standing_callers_qa.py": {"_Categories"},
    "shared/test_migration_backfill_rollover_history_qa.py": {"_Categories"},
    "lambda/test_budget_alerts.py": {"FakeCategoryRepo"},
    "lambda/test_budget_alerts_plan_qa.py": {"_Categories"},
    "lambda/test_budget_alerts_standing_qa.py": {"_Categories"},
    "lambda/test_budget_alerts_window_read_qa.py": {"_Categories"},
    "lambda/test_zero_amount_skip.py": {"_Categories"},
    "lambda/test_zero_amount_skip_qa.py": {"_Categories"},
    "lambda/test_deleted_transaction_resend.py": {"_Categories"},
    "lambda/test_deleted_transaction_resend_qa.py": {"_Categories"},
    "sync_trigger/test_pending_mirror.py": {"_Categories"},
    "sync_trigger/test_pending_mirror_qa.py": {"_Categories"},
    "sync_trigger/test_pending_mirror_carry_qa.py": {"_Categories"},
    "lambda/test_rule_ingest.py": {"FakeCategoryRepo"},
    "lambda/test_rule_ingest_gaps.py": {"FakeCategoryRepo"},
    "lambda/test_rule_ingest_spread.py": {"FakeCategoryRepo"},
    "lambda/test_rule_ingest_spread_gaps.py": {"FakeCategoryRepo"},
    "lambda/test_rule_ingest_legacy_rows.py": {"_FakeCategoryRepo"},
    "lambda/test_reprocess.py": {"_FakeCategoryRepo"},
    "lambda/test_age_out.py": {"_FakeCategoryRepo"},
}


def test_shared_pay_cycle_and_category_fakes_count_reads_and_can_fail_on_purpose():
    from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo, _spend_cat
    from _feed_fakes import FakeCategoryRepo

    pay_cycle = _FakePayCycleRepo()
    assert pay_cycle.get_calls == 0
    assert pay_cycle.get_paycycle() == {"length": 30, "last_pay_date": "2026-07-01"}
    assert pay_cycle.get_paycycle() == {"length": 30, "last_pay_date": "2026-07-01"}
    assert pay_cycle.get_calls == 2
    assert _FakePayCycleRepo(length=14, last_pay_date="2024-01-03").get_paycycle() == {
        "length": 14, "last_pay_date": "2024-01-03"}

    empty = _FakeCategoryRepo()
    assert empty.list_calls == 0
    assert empty.list_categories() == []
    assert empty.list_calls == 1

    categories = _FakeCategoryRepo([{"id": "coffee", "bucket": "Lifestyle"}])
    first = categories.list_categories()
    first[0]["bucket"] = "changed"
    assert categories.list_categories() == [{"id": "coffee", "bucket": "Lifestyle"}]
    assert categories.list_calls == 2

    down = RuntimeError("down")
    failing = _FakeCategoryRepo(error=down)
    with pytest.raises(RuntimeError) as raised:
        failing.list_categories()
    assert raised.value is down

    assert _spend_cat() == [{"id": "insurance", "bucket": "Living", "parent": None}]
    assert _spend_cat("rent", bucket="Bills") == [{"id": "rent", "bucket": "Bills", "parent": None}]

    taxonomy = FakeCategoryRepo(["groceries"])
    assert taxonomy.list_calls == 0
    assert taxonomy.list_categories() == [{"id": "groceries"}]
    assert taxonomy.list_calls == 1

    boom = RuntimeError("taxonomy read boom")
    with pytest.raises(RuntimeError) as raised:
        FakeCategoryRepo(["groceries"], error=boom).list_categories()
    assert raised.value is boom


def test_budget_alert_rule_and_mirror_suites_keep_no_copy_of_the_repo_fakes():
    copies = []
    for relative, names in _COPIES.items():
        path = _TESTS / relative
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.ClassDef) and node.name in names and not node.bases:
                copies.append(f"{relative}:{node.lineno} class {node.name}")
    assert not copies, (
        "import _FakePayCycleRepo / _FakeCategoryRepo (_budget_endpoint_fakes) or "
        "FakeCategoryRepo (_feed_fakes) instead:\n" + "\n".join(copies))
