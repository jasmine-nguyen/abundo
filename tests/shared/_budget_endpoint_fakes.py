"""Shared fakes for the budget read-endpoint suites (list_budgets +
get_budget_transactions). The same repo stand-ins and row/event builders were
copy-defined in test_budget_transactions.py and its WHIT-362 gap file; this is the
single copy both import (WHIT-362). Kept data-free — each test supplies its own
categories/transactions locally.

On the pytest path via `pythonpath = tests/shared` (pytest.ini), same as
_goal_nudge_fakes.py. NOTE: test_budgets.py keeps its own older FakeBudgetRepo /
_transaction ecosystem and is intentionally not migrated here.
"""

from decimal import Decimal


class _DateFilteringTransactionRepo:
    """Honours the date bounds like DynamoDB `between` (inclusive both ends over
    YYYY-MM-DD strings), so a test proves the endpoint pulls the WHOLE cycle — not a
    7-day slice. Serves the pool once (then empty) so the per-account loop counts each
    transaction a single time."""

    def __init__(self, transactions):
        self._txns = list(transactions)
        self._served = False
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        if self._served:
            return [], None
        self._served = True
        page = [t for t in self._txns if start_date <= t["date"] <= end_date]
        return page, None


class _FakePayCycleRepo:
    def __init__(self, length=30, last_pay_date="2026-07-01"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


class _FakeCategoryRepo:
    def __init__(self, categories):
        self._categories = categories

    def list_categories(self):
        return [dict(c) for c in self._categories]


class _FakeBudgetRepo:
    def __init__(self, budgets):
        self._budgets = budgets

    def list_budgets(self):
        return {k: dict(v) for k, v in self._budgets.items()}


def _txn(txn_id, category, amount, date_str, status="posted", counts=True, excluded=False):
    row = {
        "transaction_id": txn_id,
        "category": category,
        "amount": Decimal(str(amount)),
        "status": status,
        "counts_to_budget": counts,
        "date": date_str,
        "pk": "ACCT#up-spending",
        "sk": f"TXN#{txn_id}",
    }
    if excluded:
        row["budget_excluded"] = True
    return row


def _event(category="coffee"):
    return {
        "rawPath": f"/budgets/{category}/transactions",
        "requestContext": {"http": {"method": "GET"}},
        "pathParameters": {"category": category},
    }
