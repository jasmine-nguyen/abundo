"""WHIT-296 — end-to-end proof that a user's `budget_excluded` override drops a
transaction from the READ rollups the client renders, not just the shared gate the
implementer unit-tested (tests/shared/test_spend_budget_excluded.py).

Every rollup here routes through summarise_transactions / summarise_uncategorized,
so honouring the override in `_spend_contribution` should make the excluded charge
vanish from:
  * GET /budgets      (list_budgets)         — the budget bars,
  * GET /breakdown    (list_category_breakdown) — the category breakdown,
  * POST /insights/ai (assemble_insight_input)  — the AI model input.

Fail-on-revert anchor for all four: drop `or transaction.get("budget_excluded")`
from shared/spend.py:114 and the excluded amount reappears in the total.

These reuse the direct-call + fake-repo pattern from test_budgets.py /
test_breakdown.py / test_insights_ai.py (handler fixture, no AWS).
"""

from datetime import date, timedelta
from decimal import Decimal


def _txn(category, amount, status="posted", counts=True, budget_excluded=None):
    row = {"category": category, "amount": Decimal(str(amount)), "status": status,
           "counts_to_budget": counts}
    if budget_excluded is not None:
        row["budget_excluded"] = budget_excluded
    return row


class _BudgetRepo:
    def __init__(self, budgets):
        self._b = budgets

    def list_budgets(self):
        return {k: dict(v) for k, v in self._b.items()}


class _CategoryRepo:
    def __init__(self, categories):
        self._c = categories

    def list_categories(self):
        return [dict(c) for c in self._c]


class _TxnRepo:
    """Single page of `transactions` for the FIRST account, empty after — so the
    _fetch_windowed_transactions per-account loop sums each row once. Ignores the
    date bounds (mirrors test_budgets.FakeTransactionRepo)."""

    def __init__(self, transactions):
        self._queue = [(list(transactions), None)]

    def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
        return self._queue.pop(0) if self._queue else ([], None)


class _PayCycleRepo:
    def __init__(self, length=14, last_pay_date="2024-01-03"):
        self._c = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._c)


# --- GET /budgets ------------------------------------------------------------


def test_list_budgets_drops_an_excluded_charge(handler):
    # WHIT-296 — [A-B1] two coffee charges, one marked "exclude"; only the kept one
    # feeds the bar. Without the gate the bar would read $150 posted.
    budget_repo = _BudgetRepo({"coffee": {"target": Decimal("100")}})
    txn_repo = _TxnRepo([
        _txn("coffee", -50, "posted"),
        _txn("coffee", -100, "posted", budget_excluded=True),  # excluded
    ])

    result = handler.list_budgets(budget_repo, txn_repo, _PayCycleRepo(),
                                  _CategoryRepo([{"id": "coffee", "bucket": "Lifestyle"}]))

    assert result == {"coffee": {"target": Decimal("100"),
                                 "posted": Decimal("50"), "pending": Decimal("0")}}


def test_list_budgets_excluded_pending_leaves_the_pending_bar(handler):
    # WHIT-296 — [A-B2] the override drops a PENDING charge from the pending portion of
    # the bar too (the gate is status-agnostic). Only the kept pending remains.
    budget_repo = _BudgetRepo({"coffee": {"target": Decimal("100")}})
    txn_repo = _TxnRepo([
        _txn("coffee", -12, "pending"),
        _txn("coffee", -40, "pending", budget_excluded=True),  # excluded
    ])

    result = handler.list_budgets(budget_repo, txn_repo, _PayCycleRepo(),
                                  _CategoryRepo([{"id": "coffee", "bucket": "Lifestyle"}]))

    assert result["coffee"]["pending"] == Decimal("12")
    assert result["coffee"]["posted"] == Decimal("0")


# --- GET /breakdown ----------------------------------------------------------


def test_breakdown_drops_an_excluded_categorised_charge(handler):
    # WHIT-296 — [A-K1] the excluded coffee charge leaves the coffee breakdown slice.
    cats = _CategoryRepo([{"id": "coffee", "name": "Coffee", "bucket": "Lifestyle"}])
    txns = _TxnRepo([
        _txn("coffee", -50, "posted"),
        _txn("coffee", -100, "posted", budget_excluded=True),  # excluded
    ])

    result = handler.list_category_breakdown(cats, txns, _PayCycleRepo())

    assert result == {"coffee": {"posted": Decimal("50"), "pending": Decimal("0")}}


def test_breakdown_excluded_uncategorized_charge_does_not_inflate_the_uncategorized_bucket(handler):
    # WHIT-296 — [A-K2] an excluded charge with a raw (un-mapped) category must NOT
    # land in __uncategorized__; a lone excluded charge yields no uncategorized row.
    cats = _CategoryRepo([{"id": "coffee", "name": "Coffee", "bucket": "Lifestyle"}])
    txns = _TxnRepo([_txn("MEDICAL", -20, "posted", budget_excluded=True)])

    result = handler.list_category_breakdown(cats, txns, _PayCycleRepo())

    assert result == {}  # nothing counts -> no coffee row and no __uncategorized__


# --- POST /insights/ai (model input) -----------------------------------------


class _InsightTxnRepo:
    """Serves a per-window transaction list for the FIRST account only (empty for the
    rest), keyed by (start, end) — mirrors test_insights_ai._FakeTxnRepo."""

    def __init__(self, by_window):
        self._by_window = by_window
        self._first_account = None

    def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
        if self._first_account is None:
            self._first_account = account_id
        if account_id != self._first_account:
            return [], None
        return self._by_window.get((start, end), []), None


def test_assemble_insight_input_omits_an_excluded_charge(handler):
    # WHIT-296 — [A-I1] the load-bearing insights gap: an excluded charge must NOT
    # reach the AI model input at all. Two groceries charges in the current window,
    # one excluded; the Groceries row shows only the kept spend and the excluded
    # figure appears NOWHERE in the payload. Fail-on-revert: drop the spend gate and
    # the row reads 600.0 (and 500 shows up in the blob).
    cycle = _PayCycleRepo().get_paycycle()
    start, end = handler.current_cycle_window(cycle["last_pay_date"], cycle["length"])
    prev_end = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
    prev_start = (date.fromisoformat(start) - timedelta(days=cycle["length"])).isoformat()

    txn_repo = _InsightTxnRepo({
        (start, end): [
            _txn("groceries", -100, "posted"),
            _txn("groceries", -500, "posted", budget_excluded=True),  # excluded
        ],
        (prev_start, prev_end): [],
    })

    model_input, _ = handler.assemble_insight_input(
        _CategoryRepo([{"id": "groceries", "name": "Groceries", "bucket": "Living"}]),
        _BudgetRepo({"groceries": {"target": Decimal("300")}}),
        txn_repo, _PayCycleRepo())

    rows = {r["name"]: r for r in model_input["categories"]}
    assert rows["Groceries"]["posted"] == 100.0     # only the kept charge
    import json
    assert "500" not in json.dumps(model_input)      # the excluded figure is nowhere


def test_assemble_insight_input_excluded_only_category_is_absent(handler):
    # WHIT-296 — [A-I2] a category whose ONLY charge this cycle is excluded produces no
    # row at all (summarise returns only contributors), so the model can't cite a
    # phantom $0 category or the excluded transfer.
    cycle = _PayCycleRepo().get_paycycle()
    start, end = handler.current_cycle_window(cycle["last_pay_date"], cycle["length"])
    prev_end = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
    prev_start = (date.fromisoformat(start) - timedelta(days=cycle["length"])).isoformat()

    txn_repo = _InsightTxnRepo({
        (start, end): [_txn("coffee", -80, "posted", budget_excluded=True)],
        (prev_start, prev_end): [],
    })

    model_input, _ = handler.assemble_insight_input(
        _CategoryRepo([{"id": "coffee", "name": "Coffee", "bucket": "Lifestyle"}]),
        _BudgetRepo({}), txn_repo, _PayCycleRepo())

    assert model_input["categories"] == []
    assert model_input["uncategorized"] is None
