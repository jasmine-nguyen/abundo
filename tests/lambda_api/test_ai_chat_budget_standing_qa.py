"""WHIT-622 QA — the chat works its budget rows out from ONE read that reaches back a year.

That read is far wider than the current cycle, so the chat must hand budget_standing only
the rows from the rollover fetch start — or a plain budget sums a year of spending.
Cycle: 14 days, payday 2026-09-10, today 2026-09-20 → current cycle 2026-09-10..2026-09-20.
"""

from datetime import date
from decimal import Decimal
from functools import partial

from _budget_endpoint_fakes import _FakeCategoryRepo

CATEGORIES = [{"id": "groceries", "name": "Groceries", "bucket": "Living", "parent": None, "colorSlot": 11}]


class _PayCycle:
    def get_paycycle(self):
        return {"length": 14, "last_pay_date": "2026-09-10"}


_Categories = partial(_FakeCategoryRepo, CATEGORIES)


class _Budgets:
    def __init__(self, budgets):
        self.budgets = budgets

    def list_budgets(self):
        return self.budgets


class _DateRangeRepo:
    def __init__(self, rows):
        self.rows = rows

    def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
        if account_id != "up-spending":
            return [], None
        return [r for r in self.rows if start <= r["date"] <= end], None


def _row(txn_id, amount, day):
    return {"transaction_id": txn_id, "account_id": "up-spending", "category": "groceries",
            "amount": Decimal(amount), "status": "posted", "counts_to_budget": True, "date": day}


def _load(ai_chat, monkeypatch, budgets, rows):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2026, 9, 20))
    return ai_chat.load_chat_data(_DateRangeRepo(rows), _Categories(), _Budgets(budgets), _PayCycle())


def test_plain_budget_in_the_chat_counts_only_this_cycle(ai_chat, monkeypatch):
    # [A7] (P0) No rollover → the chat's year-long read must not leak into posted. Last month's
    # $500 is in the chat's transactions but not in the Groceries budget row.
    rows = [_row("old", "-500", "2026-08-15"), _row("now", "-25", "2026-09-15")]
    data = _load(ai_chat, monkeypatch, {"groceries": {"target": Decimal("100")}}, rows)

    assert data.budgets == {"groceries": {"target": Decimal("100"), "posted": Decimal("25"),
                                          "pending": Decimal("0"), "available": Decimal("100")}}
    assert {t["transaction_id"] for t in data.transactions} == {"old", "now"}


def test_rollover_history_older_than_the_chat_floor_still_counts(ai_chat, monkeypatch):
    # [A8] (P1) The safety net: if the chat's floor ever sits later than the rollover read start,
    # the read still reaches back for the carryover, but the chat's own transactions stop at
    # the floor. Prior cycle 2026-08-27..09-09 spent $60 of $100 → carryover $40.
    monkeypatch.setattr(ai_chat, "lookback_floor", lambda cycle_start, length, today: cycle_start)
    budget = {"target": Decimal("100"), "rollover": True, "carryover": Decimal("0"),
              "carryover_from": "2026-08-27", "carryover_len": Decimal("14"),
              "carryover_paydate": "2026-09-10"}
    rows = [_row("prior", "-60", "2026-08-30"), _row("now", "-25", "2026-09-15")]
    data = _load(ai_chat, monkeypatch, {"groceries": budget}, rows)

    assert data.floor == "2026-09-10"
    assert data.budgets["groceries"]["carryover"] == Decimal("40")
    assert data.budgets["groceries"]["available"] == Decimal("140")
    assert [t["transaction_id"] for t in data.transactions] == ["now"]
