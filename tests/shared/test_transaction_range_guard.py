"""WHIT-767: the guard catches transaction-range copies; the moved suites keep none."""

import pathlib

from test_repo_fakes_by_behaviour import _local_copies

_TESTS = pathlib.Path(__file__).resolve().parents[1]

_MOVED_FILES = {
    "lambda_api/test_breakdown.py": set(),
    "lambda_api/test_breakdown_lookback.py": set(),
    "lambda_api/test_budgets.py": set(),
    "lambda_api/test_category_transactions.py": {"_PerAccountTransactionRepo"},
    "lambda_api/test_cycle_budgets.py": set(),
    "lambda_api/test_cycle_transactions.py": set(),
    "lambda_api/test_cycle_budgets_qa.py": set(),
    "lambda_api/test_ai_chat.py": set(),
    "lambda_api/test_budgets_available.py": set(),
    "lambda_api/test_budgets_available_gaps.py": set(),
    "lambda_api/test_budgets_rollover.py": set(),
    "lambda_api/test_budgets_rollover_gaps.py": set(),
    "lambda_api/test_budgets_spread.py": set(),
    "lambda_api/test_budgets_spread_gaps.py": set(),
    "lambda_api/test_whit474_e2e_gaps.py": set(),
    "lambda_api/test_budget_excluded_rollups.py": {"_InsightTxnRepo"},
}


def test_the_guard_catches_transaction_range_copies_and_the_moved_suites_have_none():
    nested = (
        "def test_x():\n"
        "    class _Renamed:\n"
        "        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):\n"
        "            return [], None\n"
    )
    assert _local_copies(nested) == [(2, "_Renamed")]

    leftovers = []
    for relative, still_pending in _MOVED_FILES.items():
        for lineno, name in _local_copies((_TESTS / relative).read_text()):
            if name not in still_pending:
                leftovers.append(f"{relative}:{lineno} class {name}")
    assert not leftovers, "\n".join(leftovers)
