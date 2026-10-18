"""WHIT-622 — "budget standing this cycle" worked out once, in shared/budget_standing.py.

Plain input → output tables: budget targets + pay cycle + categories + charges in → each
budget's row (target, posted, pending, carryover, available) plus the settlements to
save. The same function feeds /budgets, the budget alerts and the chat, so these rows are
exactly the /budgets wire shape (key order included).
"""

import importlib
import sys
from datetime import date
from decimal import Decimal as D

import pytest

from _category_fakes import transfer_tree


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
    "holiday": {"target": D("300"), "posted": D("100"), "pending": D("0"), "available": D("300")},
}

NO_SETTLEMENTS = {"rollover": {}}

MIXED_SETTLEMENTS = {
    "rollover": {
        "fun": {"carryover": D("60"), "carryover_from": "2026-09-03", "carryover_history": [
            {"start": "2026-08-20", "end": "2026-09-02", "target": D("200"), "spent": D("150"),
             "leftover": D("50")},
        ]},
        "gifts": {"carryover": D("25"), "carryover_from": "2026-09-17"},
    },
}


@pytest.mark.parametrize("targets, charges, fetch_start, expected_rows, expected_settlements", [
    pytest.param(PLAIN_TARGETS, PLAIN_CHARGES, "2026-09-17", PLAIN_ROWS, NO_SETTLEMENTS,
                 id="plain spend + income budgets read only this cycle"),
    pytest.param(MIXED_TARGETS, MIXED_CHARGES, "2026-08-20", MIXED_ROWS, MIXED_SETTLEMENTS,
                 id="rollup, rollover and a stale flag"),
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


ALIGNED_ROLLOVER = {
    "rollover": True, "carryover": D("0"), "carryover_from": "2026-09-03",
    "carryover_len": D("14"), "carryover_paydate": "2026-09-17",
}


def standing(module, targets, categories, charges):
    window = module.standing_window(targets, PAY_CYCLE, today=TODAY)
    return module.budget_standing(targets, window, categories, charges)


def test_orphan_rollover_budget_still_rolls_over_like_before(budget_standing):
    # [A4] (P1) A budget whose category was deleted has no bucket. /budgets has always treated it
    # as spend (rollover applies); the alerts drop it separately. Keep that.
    targets = {"gone": {"target": D("100"), **ALIGNED_ROLLOVER}}
    rows, settlements = standing(budget_standing, targets, [], [charge("gone", "2026-09-10", "-60"),
                                                                charge("gone", "2026-09-18", "-5")])

    assert rows["gone"] == {"target": D("100"), "posted": D("5"), "pending": D("0"),
                            "rollover": True, "carryover": D("40"),
                            "carryover_cycles": [{"start": "2026-09-03", "end": "2026-09-16", "target": D("100"),
                                                  "spent": D("60"), "leftover": D("40"), "settling": True}],
                            "carryover_earlier": D("0"), "available": D("140")}
    assert settlements["rollover"] == {}


def test_window_widens_only_for_rollover_and_stops_at_the_12_cycle_cap(budget_standing):
    # [A6] (P1) A plain budget reads just this cycle; a rollover anchored years ago reads
    # back exactly 12 cycles (168 days), not to the anchor.
    plain = budget_standing.standing_window({"insurance": {"target": D("100")}}, PAY_CYCLE, today=TODAY)
    assert plain.fetch_start == "2026-09-17"
    assert plain.windows_by_id == {}

    ancient = {**ALIGNED_ROLLOVER, "carryover_from": "2024-10-31"}
    capped = budget_standing.standing_window({"fun": {"target": D("100"), **ancient}}, PAY_CYCLE, today=TODAY)
    assert capped.fetch_start == "2026-04-02"
    assert len(capped.windows_by_id["fun"]) == 12


def test_a_transfer_sub_category_does_not_count_toward_its_budgeted_parent(budget_standing):
    # ABU-83: a card repayment filed in a "Transfer, not spending" sub-category counts
    # (counts_to_budget=True after filing) but isn't spending. Rent paid by transfer still counts.
    cats = transfer_tree()
    targets = {"living": {"target": D("2000")}, "rent": {"target": D("500")}}
    charges = [charge("card-payment", "2026-09-18", "-900"), charge("rent", "2026-09-18", "-500")]

    rows, _ = standing(budget_standing, targets, cats, charges)

    assert rows["living"]["posted"] == D("500")
    assert rows["rent"]["posted"] == D("500")
    assert budget_standing.budget_spend(targets, cats, charges)["living"]["posted"] == D("500")
