"""Shared fakes for the budget read-endpoint suites (list_budgets +
get_budget_transactions). The same repo stand-ins and row/event builders were
copy-defined in test_budget_transactions.py and its WHIT-362 gap file; this is the
single copy both import (WHIT-362). Kept data-free — each test supplies its own
categories/transactions locally.

On the pytest path via `pythonpath = tests/shared` (pytest.ini), same as
_goal_nudge_fakes.py. The suites that WRITE budgets use the real repository instead
(_budget_fakes.recording_budget_repo); ``_FakeBudgetRepo`` here is a read-only stub.
The transaction-range stand-ins live in _transaction_range_fakes.py (WHIT-767).
"""

from decimal import Decimal


class _FakePayCycleRepo:
    def __init__(self, length=30, last_pay_date="2026-07-01"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}
        self.get_calls = 0

    def get_paycycle(self):
        self.get_calls += 1
        return dict(self._cycle)


class _FakeCategoryRepo:
    def __init__(self, categories=(), error=None):
        self._categories = categories
        self._error = error
        self.list_calls = 0

    def list_categories(self):
        self.list_calls += 1
        if self._error:
            raise self._error
        return [dict(c) for c in self._categories]


def _spend_cat(cat_id="insurance", bucket="Living", parent=None):
    return [{"id": cat_id, "bucket": bucket, "parent": parent}]


class _SpendCategoryRepo(_FakeCategoryRepo):
    """The spread suites' taxonomy: one spendable `insurance` category unless told otherwise."""

    def __init__(self, categories=None):
        if categories is None:
            categories = _spend_cat()
        super().__init__(categories)


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


def pin_cycle_window(handler, monkeypatch, cycle_start, today):
    """Pin the budgets read's current cycle to (cycle_start, today) in the handler and
    budget_standing, so the cycle maths never reads the wall clock."""
    import budget_standing
    for module in (handler, budget_standing):
        monkeypatch.setattr(module, "current_cycle_window",
                            lambda last_pay_date, length, today_=None: (cycle_start, today))
