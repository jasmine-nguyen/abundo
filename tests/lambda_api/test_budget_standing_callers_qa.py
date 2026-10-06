"""WHIT-622 QA (round 2) — the callers of budget_standing hand it the right rows.

/budgets and the chat read transactions differently (the chat reads back a year; /budgets
reads back to the oldest rollover cycle), so each must slice what it passes in. A
date-honouring fake read, like the real date-index query.
Cycle: 14 days, payday 2026-09-10, today 2026-09-20 → current cycle 2026-09-10..2026-09-20.
"""

from datetime import date
from decimal import Decimal as D
from functools import partial

import pytest

from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _transaction_range_fakes import _AccountTransactionRepo

TODAY = date(2026, 9, 20)
PAY_CYCLE = {"length": 14, "last_pay_date": "2026-09-10"}

CATEGORIES = [
    {"id": "groceries", "name": "Groceries", "bucket": "Living", "parent": None},
    {"id": "food", "name": "Food", "bucket": "Lifestyle", "parent": None},
    {"id": "dining", "name": "Dining", "bucket": "Lifestyle", "parent": "food"},
    {"id": "coffee", "name": "Coffee", "bucket": "Lifestyle", "parent": "food"},
    {"id": "fun", "name": "Fun", "bucket": "Lifestyle", "parent": None},
    {"id": "insurance", "name": "Insurance", "bucket": "Living", "parent": None},
    {"id": "salary", "name": "Salary", "bucket": "Income", "parent": None},
]

# Aligned to the current pay cycle, anchored two completed cycles back:
# 2026-08-13..08-26 and 2026-08-27..09-09.
ALIGNED_ROLLOVER = {
    "rollover": True, "carryover": D("0"), "carryover_from": "2026-08-13",
    "carryover_len": D("14"), "carryover_paydate": "2026-09-10",
}

BUDGETS = {
    "groceries": {"target": D("500")},
    "food": {"target": D("300")},
    "fun": {"target": D("200"), **ALIGNED_ROLLOVER},
    "insurance": {"target": D("100"), "spread_amount": D("300"), "spread_cycles": D("3"),
                  "spread_from": "2026-08-27", "spread_len": D("14"), "spread_paydate": "2026-09-10"},
    # A rollover flag left on a category since moved to Income. It widens the read.
    "salary": {"target": D("3000"), **ALIGNED_ROLLOVER},
}


def _row(txn_id, category, amount, day, status="posted"):
    return {"transaction_id": txn_id, "account_id": "up-spending", "category": category,
            "amount": D(amount), "status": status, "counts_to_budget": True, "date": day}


ROWS = [
    _row("g-old", "groceries", "-900", "2026-09-01"),
    _row("g-now", "groceries", "-120", "2026-09-12"),
    _row("g-pend", "groceries", "-30", "2026-09-19", status="pending"),
    _row("d-now", "dining", "-80", "2026-09-15"),
    _row("c-refund", "coffee", "25", "2026-09-16"),
    _row("f-c1", "fun", "-150", "2026-08-20"),
    _row("f-c2", "fun", "-260", "2026-09-05"),
    _row("f-now", "fun", "-40", "2026-09-18"),
    _row("s-old", "salary", "2800", "2026-08-28"),
    _row("s-now", "salary", "2800", "2026-09-11"),
]


class _Budgets:
    def __init__(self, budgets):
        self.budgets = budgets
        self.writes = []

    def list_budgets(self):
        return {k: dict(v) for k, v in self.budgets.items()}

    def settle_carryover(self, *args):
        self.writes.append(("settle_carryover", args))

    def clear_spread(self, *args):
        self.writes.append(("clear_spread", args))

    def set_spread(self, *args):
        self.writes.append(("set_spread", args))


_PayCycle = partial(_FakePayCycleRepo, **PAY_CYCLE)


_Categories = partial(_FakeCategoryRepo, CATEGORIES)


@pytest.fixture
def pinned_today(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: TODAY)


def test_budgets_screen_and_chat_show_the_same_rows(handler, pinned_today):
    # [B1] (P0) Same stored data → the chat's budget rows equal GET /budgets' rows exactly
    # (rollover carryover, spread cushion, parent refund netting, stale Income flag).
    import ai_chat

    screen = handler.list_budgets(_Budgets(BUDGETS), _AccountTransactionRepo(ROWS), _PayCycle(), _Categories())
    chat = ai_chat.load_chat_data(_AccountTransactionRepo(ROWS), _Categories(), _Budgets(BUDGETS), _PayCycle())

    assert chat.budgets == screen
    assert screen["fun"]["carryover"] == D("-10")  # +50 then -60
    assert screen["fun"]["available"] == D("190")
    assert screen["food"]["posted"] == D("55")  # 80 dining - 25 coffee refund


def test_stale_rollover_flag_on_income_widens_the_read_but_not_the_earnings(handler, pinned_today):
    # [B2] (P0) The stale Income flag makes /budgets read back to 2026-08-13. Salary must still
    # show only this cycle's pay ($2,800, not $5,600), with no rollover keys and nothing saved
    # for it. Groceries likewise shows only this cycle ($120 + $30 pending, not + $900).
    budget_repo = _Budgets({"groceries": BUDGETS["groceries"], "salary": BUDGETS["salary"]})
    transaction_repo = _AccountTransactionRepo(ROWS)

    rows = handler.list_budgets(budget_repo, transaction_repo, _PayCycle(), _Categories())

    assert [(c[1], c[2]) for c in transaction_repo.calls if c[0] == "up-spending"] == [("2026-08-13", "2026-09-20")]
    assert rows == {
        "groceries": {"target": D("500"), "posted": D("120"), "pending": D("30"), "available": D("500")},
        "salary": {"target": D("3000"), "posted": D("2800"), "pending": D("0"), "available": D("3000")},
    }
    assert budget_repo.writes == []


def test_chat_with_no_budgets_still_loads_its_transactions(handler, pinned_today):
    # [B3] (P2) No budgets → empty budget rows, no crash; the chat still gets every
    # transaction back to its floor.
    import ai_chat

    data = ai_chat.load_chat_data(_AccountTransactionRepo(ROWS), _Categories(), _Budgets({}), _PayCycle())

    assert data.budgets == {}
    assert {t["transaction_id"] for t in data.transactions} == {r["transaction_id"] for r in ROWS}
