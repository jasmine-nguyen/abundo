"""WHIT-622 QA — the budget_standing branches the main input → output table doesn't reach.

Same pinned cycle as test_budget_standing.py: 14-day cycle, payday 2026-09-17, today
2026-09-20 → current cycle 2026-09-17..2026-09-20.
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
TODAY = date(2026, 9, 20)

ALIGNED_ROLLOVER = {
    "rollover": True, "carryover": D("0"), "carryover_from": "2026-09-03",
    "carryover_len": D("14"), "carryover_paydate": "2026-09-17",
}


def spread(amount, cycles, spread_from, spread_len=14, spread_paydate="2026-09-17"):
    return {
        "spread_amount": D(amount), "spread_cycles": D(cycles), "spread_from": spread_from,
        "spread_len": D(spread_len), "spread_paydate": spread_paydate,
    }


def charge(category, day, amount):
    return {"category": category, "date": day, "amount": D(amount),
            "status": "posted", "counts_to_budget": True}


def standing(module, targets, categories, charges):
    window = module.standing_window(targets, PAY_CYCLE, today=TODAY)
    return module.budget_standing(targets, window, categories, charges)


def test_rollover_wins_when_a_corrupt_row_has_both_cushions(budget_standing):
    # [A1] (P0) Rollover + an anchor-cycle spread on one row: `spread` is still shown, but
    # available = target + carryover only — never both cushions summed.
    targets = {"fun": {"target": D("100"), **ALIGNED_ROLLOVER, **spread("300", "3", "2026-09-17")}}
    cats = [{"id": "fun", "bucket": "Lifestyle", "parent": None}]
    rows, _ = standing(budget_standing, targets, cats, [charge("fun", "2026-09-10", "-60")])

    assert rows["fun"]["carryover"] == D("40")
    assert rows["fun"]["spread"]["adjustment"] == D("300")
    assert rows["fun"]["available"] == D("140")


def test_spread_settles_after_a_pay_cycle_change(budget_standing):
    # [A2] (P0) The plan was laid under a 7-day cycle; the cycle is now 14 days. The spread is
    # settled into a one-cycle plan: returned for saving AND shown on the row.
    targets = {"insurance": {"target": D("100"),
                             **spread("300", "3", "2026-09-10", spread_len=7, spread_paydate="2026-09-10")}}
    cats = [{"id": "insurance", "bucket": "Living", "parent": None}]
    rows, settlements = standing(budget_standing, targets, cats, [])

    assert list(settlements["spread_reanchored"]) == ["insurance"]
    assert settlements["spread_finished"] == []
    assert "spread" in rows["insurance"]
    assert rows["insurance"]["available"] == D("100") + rows["insurance"]["spread"]["adjustment"]


def test_stale_spread_on_an_income_category_is_ignored(budget_standing):
    # [A3] (P1) A spread left on a category since moved to Income: no `spread` key, available is
    # the plain target, nothing to save.
    targets = {"salary": {"target": D("3000"), **spread("300", "3", "2026-09-17")}}
    cats = [{"id": "salary", "bucket": "Income", "parent": None}]
    rows, settlements = standing(budget_standing, targets, cats, [charge("salary", "2026-09-18", "2500")])

    assert rows == {"salary": {"target": D("3000"), "posted": D("2500"), "pending": D("0"),
                               "available": D("3000")}}
    assert settlements == {"rollover": {}, "spread_finished": [], "spread_reanchored": {}}


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


def test_no_budgets_gives_no_rows_and_nothing_to_save(budget_standing):
    # [A5] (P2) Empty input → empty output, no crash on the empty subtree union.
    window = budget_standing.standing_window({}, PAY_CYCLE, today=TODAY)
    assert window.fetch_start == window.cycle_start == "2026-09-17"
    assert budget_standing.budget_standing({}, window, [], [charge("x", "2026-09-18", "-1")]) == (
        {}, {"rollover": {}, "spread_finished": [], "spread_reanchored": {}})


def test_window_widens_only_for_rollover_and_stops_at_the_12_cycle_cap(budget_standing):
    # [A6] (P1) A spread-only budget reads just this cycle; a rollover anchored years ago reads
    # back exactly 12 cycles (168 days), not to the anchor.
    spread_only = budget_standing.standing_window(
        {"insurance": {"target": D("100"), **spread("300", "3", "2026-09-03")}}, PAY_CYCLE, today=TODAY)
    assert spread_only.fetch_start == "2026-09-17"
    assert spread_only.windows_by_id == {}

    ancient = {**ALIGNED_ROLLOVER, "carryover_from": "2024-10-31"}
    capped = budget_standing.standing_window({"fun": {"target": D("100"), **ancient}}, PAY_CYCLE, today=TODAY)
    assert capped.fetch_start == "2026-04-02"
    assert len(capped.windows_by_id["fun"]) == 12
