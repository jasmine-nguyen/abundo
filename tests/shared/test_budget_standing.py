"""WHIT-622 — "budget standing this cycle" worked out once, in shared/budget_standing.py.

Plain input → output tables: budget targets + pay cycle + categories + charges in → each
budget's row (target, posted, pending, carryover, spread, available) plus the settlements to
save. The same function feeds /budgets, the budget alerts and the chat, so these rows are
exactly the /budgets wire shape (key order included).
"""

import importlib
import sys
from datetime import date
from decimal import Decimal as D

import pytest


@pytest.fixture
def budget_standing(shared):
    sys.modules.pop("budget_standing", None)
    module = importlib.import_module("budget_standing")
    try:
        yield module
    finally:
        sys.modules.pop("budget_standing", None)


PAY_CYCLE = {"length": 14, "last_pay_date": "2026-09-17"}
TODAY = date(2026, 9, 20)  # current cycle = 2026-09-17..2026-09-20

CATEGORIES = [
    {"id": "groceries", "bucket": "Essentials", "parent": None},
    {"id": "salary", "bucket": "Income", "parent": None},
    {"id": "food", "bucket": "Lifestyle", "parent": None},
    {"id": "dining", "bucket": "Lifestyle", "parent": "food"},
    {"id": "coffee", "bucket": "Lifestyle", "parent": "food"},
    {"id": "fun", "bucket": "Lifestyle", "parent": None},
    {"id": "gifts", "bucket": "Lifestyle", "parent": None},
    {"id": "insurance", "bucket": "Essentials", "parent": None},
    {"id": "car", "bucket": "Essentials", "parent": None},
    {"id": "holiday", "bucket": "Savings", "parent": None},
]


def charge(category, day, amount, status="posted", counts_to_budget=True):
    return {
        "category": category, "date": day, "amount": D(amount),
        "status": status, "counts_to_budget": counts_to_budget,
    }


PLAIN_TARGETS = {
    "groceries": {"target": D("500")},
    "salary": {"target": D("3000")},
}

PLAIN_CHARGES = [
    charge("groceries", "2026-09-18", "-120"),
    charge("groceries", "2026-09-20", "-30", status="pending"),
    charge("groceries", "2026-09-19", "-500", counts_to_budget=False),
    charge("salary", "2026-09-17", "2500"),
    charge("salary", "2026-09-20", "100", status="pending"),
]

PLAIN_ROWS = {
    "groceries": {"target": D("500"), "posted": D("120"), "pending": D("30"), "available": D("500")},
    "salary": {"target": D("3000"), "posted": D("2500"), "pending": D("100"), "available": D("3000")},
}

MIXED_TARGETS = {
    **PLAIN_TARGETS,
    # Parent budget: its own charges + every sub-category's, a refund netting before the floor.
    "food": {"target": D("400")},
    # Rollover, aligned to the current pay cycle: two completed cycles to fold.
    "fun": {
        "target": D("200"), "rollover": True, "carryover": D("10"),
        "carryover_from": "2026-08-20", "carryover_len": D("14"), "carryover_paydate": "2026-09-17",
    },
    # Rollover with no anchor yet: re-anchored at the current cycle start, keeping its balance.
    "gifts": {"target": D("80"), "rollover": True, "carryover": D("25")},
    # Bill spread one cycle past its anchor: the first slice is taken back.
    "insurance": {
        "target": D("100"), "spread_amount": D("300"), "spread_cycles": D("3"),
        "spread_from": "2026-09-03", "spread_len": D("14"), "spread_paydate": "2026-09-17",
    },
    # Bill spread whose plan has run its course: nothing shown, cleared.
    "car": {
        "target": D("50"), "spread_amount": D("120"), "spread_cycles": D("2"),
        "spread_from": "2026-07-09", "spread_len": D("14"), "spread_paydate": "2026-09-17",
    },
    # Stale rollover flag on a category since moved to Savings: ignored.
    "holiday": {"target": D("300"), "rollover": True, "carryover": D("999")},
}

MIXED_CHARGES = PLAIN_CHARGES + [
    charge("groceries", "2026-09-10", "-999"),  # last cycle: not in this cycle's posted
    charge("dining", "2026-09-18", "-30"),
    charge("dining", "2026-09-19", "-15", status="pending"),
    charge("coffee", "2026-09-18", "50"),  # refund
    charge("food", "2026-09-19", "-40"),
    charge("fun", "2026-08-25", "-150"),  # cycle 08-20..09-02: leftover +50, sealed
    charge("fun", "2026-09-05", "-230"),  # cycle 09-03..09-16: leftover -30, not sealed yet
    charge("fun", "2026-09-18", "-40"),
    charge("holiday", "2026-09-19", "-100"),
]

MIXED_ROWS = {
    **PLAIN_ROWS,
    "food": {"target": D("400"), "posted": D("20"), "pending": D("15"), "available": D("400")},
    "fun": {
        "target": D("200"), "posted": D("40"), "pending": D("0"),
        "rollover": True, "carryover": D("30"),
        "carryover_cycles": [
            {"start": "2026-09-03", "end": "2026-09-16", "target": D("200"), "spent": D("230"),
             "leftover": D("-30"), "settling": True},
            {"start": "2026-08-20", "end": "2026-09-02", "target": D("200"), "spent": D("150"),
             "leftover": D("50"), "settling": False},
        ],
        "carryover_earlier": D("10"), "available": D("230"),
    },
    "gifts": {
        "target": D("80"), "posted": D("0"), "pending": D("0"),
        "rollover": True, "carryover": D("25"), "carryover_cycles": [], "carryover_earlier": D("25"),
        "available": D("105"),
    },
    "insurance": {
        "target": D("100"), "posted": D("0"), "pending": D("0"),
        "spread": {"amount": D("300"), "cycles": 3, "index": 1, "adjustment": D("-100")},
        "available": D("0"),
    },
    "car": {"target": D("50"), "posted": D("0"), "pending": D("0"), "available": D("50")},
    "holiday": {"target": D("300"), "posted": D("100"), "pending": D("0"), "available": D("300")},
}

NO_SETTLEMENTS = {"rollover": {}, "spread_finished": [], "spread_reanchored": {}}

MIXED_SETTLEMENTS = {
    "rollover": {
        "fun": {"carryover": D("60"), "carryover_from": "2026-09-03", "carryover_history": [
            {"start": "2026-08-20", "end": "2026-09-02", "target": D("200"), "spent": D("150"),
             "leftover": D("50")},
        ]},
        "gifts": {"carryover": D("25"), "carryover_from": "2026-09-17"},
    },
    "spread_finished": ["car"],
    "spread_reanchored": {},
}


@pytest.mark.parametrize("targets, charges, fetch_start, expected_rows, expected_settlements", [
    pytest.param(PLAIN_TARGETS, PLAIN_CHARGES, "2026-09-17", PLAIN_ROWS, NO_SETTLEMENTS,
                 id="plain spend + income budgets read only this cycle"),
    pytest.param(MIXED_TARGETS, MIXED_CHARGES, "2026-08-20", MIXED_ROWS, MIXED_SETTLEMENTS,
                 id="rollup, rollover, spread and a stale flag"),
])
def test_each_budget_standing_this_cycle_is_worked_out_from_targets_cycle_categories_and_charges(
    budget_standing, targets, charges, fetch_start, expected_rows, expected_settlements,
):
    window = budget_standing.standing_window(targets, PAY_CYCLE, today=TODAY)

    assert window.cycle_start == "2026-09-17"
    assert window.today == "2026-09-20"
    assert window.fetch_start == fetch_start

    rows, settlements = budget_standing.budget_standing(targets, window, CATEGORIES, charges)

    assert rows == expected_rows
    # /budgets must stay byte-identical: same budgets in the same order, same keys in the same order.
    assert [(cat_id, list(row)) for cat_id, row in rows.items()] == [
        (cat_id, list(row)) for cat_id, row in expected_rows.items()
    ]
    assert settlements == expected_settlements
