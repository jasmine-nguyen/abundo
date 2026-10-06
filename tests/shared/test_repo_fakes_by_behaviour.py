"""WHIT-766 / WHIT-767: no test file keeps its own repo stand-in, under any name.

A copy is found by what it does (a class with no base that defines
``list_categories``, ``get_paycycle`` or ``get_transactions_by_date_range``), not by
its name, so renamed copies are caught too. The shared fakes in
``tests/shared/_*_fakes.py`` are the one home; the transaction read's is
``_transaction_range_fakes.py``.
"""

import ast
import pathlib

_TESTS = pathlib.Path(__file__).resolve().parents[1]                 # tests/

_REPO_METHODS = {"list_categories", "get_paycycle", "get_transactions_by_date_range"}

# The full create/update/delete category fake, not a read-only stand-in.
_ALLOWED = {"lambda_api/test_categories.py": {"FakeCategoryRepo"}}

# Moved by WHIT-768 / WHIT-769 — delete entries as they go.
_PENDING_TRANSACTION_COPIES = {
    "balance_poller/test_feed_stall.py": {"_FakeTransactionRepo"},
    "balance_poller/test_feed_stall_read_bounds_qa.py": {"_Recorder"},
    "balance_poller/test_repayment_miss.py": {"_FakeTxnRepo"},
    "balance_poller/test_repayment_miss_precise.py": {"_FakeTxnRepo"},
    "lambda/test_budget_alerts.py": {"FakeWindowRepo", "_CursorWindowRepo", "ExplodingWindowRepo", "_NeverEnds"},
    "lambda/test_budget_alerts_plan_qa.py": {"_Window"},
    "lambda/test_budget_alerts_standing_qa.py": {"_DateRangeRepo"},
    "lambda/test_budget_alerts_window_read_qa.py": {"_DateRangeRepo"},
    "lambda/test_reconcile_merchant_match.py": {"_FakeWindowRepo"},
    "lambda/test_whit329_qa.py": {"_WindowRepo"},
    "lambda_api/test_ai_chat_budget_standing_qa.py": {"_DateRangeRepo"},
    "lambda_api/test_budget_standing_callers_qa.py": {"_DateRangeRepo"},
    "lambda_api/test_budget_excluded_rollups.py": {"_InsightTxnRepo"},
    "lambda_api/test_category_transactions.py": {"_PerAccountTransactionRepo"},
    "lambda_api/test_cycle_transactions_qa.py": {"_PerAccountRepo"},
    "lambda_api/test_handler.py": {"FakeRecentFeedRepo"},
    "lambda_api/test_insights_ai.py": {"_FakeTxnRepo"},
    "lambda_api/test_shortfall_seam.py": {"_FakeTxnRepo"},
    "lambda_api/test_repayment.py": {"FakeTransactionRepo"},
    "lambda_api/test_transactions_feed.py": {"_QueuedPagesRepo"},
    "lambda_api/test_uncategorized_count.py": {"_NeverEndsRepo"},
    "lambda_api/test_uncategorized_merchants.py": {"_NeverEndsRepo"},
    "lambda_api/test_uncategorized_merchants_gaps.py": {"_FailsOnSecondPage"},
    "lambda_api/test_windowed_read_routes_qa.py": {"_EndlessRepo", "_TwoPagesPerAccountRepo"},
    "shared/test_read_date_range_pages_qa.py": {"_PagedRepo", "_Endless", "_Repo"},
    "shared/test_repository_transaction.py": {"_EndlessRepo"},
}


def _local_copies(source):
    found = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.ClassDef) or node.bases:
            continue
        methods = {item.name for item in node.body if isinstance(item, ast.FunctionDef)}
        if methods & _REPO_METHODS:
            found.append((node.lineno, node.name))
    return found


def _is_shared_fake_module(relative):
    return relative.startswith("shared/_") and relative.endswith("_fakes.py") and "/" not in relative[len("shared/"):]


def test_no_test_file_defines_its_own_repo_stand_in():
    nested = (
        "def test_x():\n"
        "    class _Renamed:\n"
        "        def get_paycycle(self):\n"
        "            return {}\n"
    )
    assert _local_copies(nested) == [(2, "_Renamed")]
    nested_transaction_read = (
        "def test_x():\n"
        "    class _Renamed:\n"
        "        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):\n"
        "            return [], None\n"
    )
    assert _local_copies(nested_transaction_read) == [(2, "_Renamed")]

    copies = []
    for path in sorted(_TESTS.rglob("*.py")):
        relative = path.relative_to(_TESTS).as_posix()
        if _is_shared_fake_module(relative):
            continue
        allowed = _ALLOWED.get(relative, set()) | _PENDING_TRANSACTION_COPIES.get(relative, set())
        for lineno, name in _local_copies(path.read_text()):
            if name in allowed:
                continue
            copies.append(f"{relative}:{lineno} class {name}")
    assert not copies, (
        "import _FakePayCycleRepo / _FakeCategoryRepo (_budget_endpoint_fakes), "
        "FakeCategoryRepo (_feed_fakes) or a transaction stand-in (_transaction_range_fakes) "
        "instead:\n" + "\n".join(copies))
