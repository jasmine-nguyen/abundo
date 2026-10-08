"""Tests for the server-computed `available` on GET /budgets (WHIT-549).

The /budgets read now emits a per-row `available` — the spendable this cycle — computed
server-side from the unified Smoothing engine (`shared/spend.unified_available`) instead of
being re-summed on the client. It must reproduce the client's old formula byte-for-byte:

    available = target + (rollover ? live carryover : 0) + spread adjustment

A category is rollover OR spread, never both, so exactly one cushion is ever non-zero. The
one exception these tests pin is a CORRUPT row wrongly flagged both ways: rollover wins, so
`available` never sums two cushions.

Same deterministic grid as the rollover/spread suites: monthly, cycle_start 2026-08-06,
payday grid from 2026-01-01. `current_cycle_window` is monkeypatched to a fixed window.
"""

from decimal import Decimal
from functools import partial

import pytest

from _budget_endpoint_fakes import CYCLE_START, LENGTH, PAYDATE, _FakeCategoryRepo, _FakePayCycleRepo
from _budget_fakes import recording_budget_repo
from _transaction_range_fakes import _QueuedTransactionRepo

pytestmark = pytest.mark.usefixtures("fixed_window")


BILL = Decimal("1390.91")   # over 4 cycles: index 0 shows the full +BILL cushion


FakePayCycleRepo = partial(_FakePayCycleRepo, length=LENGTH, last_pay_date=PAYDATE)


def _txn(category, amount, date, status="posted"):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "date": date, "counts_to_budget": True}


def _list(handler, budget_repo, transactions=None, categories=None):
    cats = categories if categories is not None else [{"id": "cat", "bucket": "Living", "parent": None}]
    return handler.list_budgets(
        budget_repo, _QueuedTransactionRepo(transactions), FakePayCycleRepo(), _FakeCategoryRepo(cats))


# --- the four normal cases: available reproduces the client's old parts-sum ----


def test_plain_budget_available_is_just_the_target(handler):
    # No rollover, no spread: both cushions 0, so available == target.
    budget_repo = recording_budget_repo({"cat": {"target": Decimal(250)}})
    result = _list(handler, budget_repo)

    assert result["cat"]["available"] == Decimal(250)


def test_income_earn_target_available_is_the_target(handler):
    # Income is excluded from both rollover and spread, so available == target (earnings show
    # in posted/pending, not in the cushion). FAIL-ON-REVERT: dropping the available line KeyErrors.
    cats = [{"id": "salary", "bucket": "Income", "parent": None}]
    budget_repo = recording_budget_repo({"salary": {"target": Decimal(5000)}})
    result = _list(handler, budget_repo, [_txn("salary", 5000, "2026-08-08")], cats)

    assert result["salary"]["available"] == Decimal(5000)


def test_rollover_available_is_target_plus_live_carryover(handler):
    # 3 empty prior cycles at target 100 build a live buffer of 300 (matches the rollover suite's
    # sinking-fund case). available = 100 + 300 = 400 — and it uses the LIVE carryover the row
    # reports, not the stored (sealed-only) mirror.
    cats = [{"id": "sink", "bucket": "Lifestyle", "parent": None}]
    entry = {"target": Decimal(100), "rollover": True, "carryover": Decimal(0),
             "carryover_from": "2026-05-08", "carryover_len": Decimal(LENGTH), "carryover_paydate": PAYDATE}
    budget_repo = recording_budget_repo({"sink": entry})
    result = _list(handler, budget_repo, categories=cats)

    assert result["sink"]["carryover"] == Decimal(300)
    assert result["sink"]["available"] == Decimal(400)


def test_spread_available_is_target_plus_adjustment(handler):
    # A bill spread anchored this cycle shows the full +BILL cushion at index 0. available =
    # target + BILL, so the bill doesn't read as "over budget".
    entry = {"target": Decimal(250), "spread_amount": BILL, "spread_cycles": Decimal(4),
             "spread_from": CYCLE_START, "spread_len": Decimal(LENGTH), "spread_paydate": PAYDATE}
    budget_repo = recording_budget_repo({"cat": entry})
    result = _list(handler, budget_repo, [_txn("cat", -1390.91, "2026-08-07")])

    assert result["cat"]["spread"]["adjustment"] == BILL
    assert result["cat"]["available"] == Decimal(250) + BILL


# --- the corrupt-both-flags guard: rollover wins, never the sum -----------------


def test_a_row_flagged_both_rollover_and_spread_never_sums_both_cushions(handler):
    # Data says rollover OR spread, never both (set_budget strips spread when rollover turns on).
    # A future migration bug could store both. available must pick ONE cushion (rollover) — never
    # target + carryover + adjustment. FAIL-ON-REVERT for the `not in rollover_ids` precedence guard.
    cats = [{"id": "both", "bucket": "Lifestyle", "parent": None}]
    entry = {
        "target": Decimal(100), "rollover": True, "carryover": Decimal(0),
        "carryover_from": "2026-05-08", "carryover_len": Decimal(LENGTH), "carryover_paydate": PAYDATE,
        "spread_amount": BILL, "spread_cycles": Decimal(4), "spread_from": CYCLE_START,
        "spread_len": Decimal(LENGTH), "spread_paydate": PAYDATE,
    }
    budget_repo = recording_budget_repo({"both": entry})
    result = _list(handler, budget_repo, categories=cats)

    # Rollover cushion only: 100 + 300 == 400. Summing both would be 400 + BILL — never that.
    assert result["both"]["available"] == Decimal(400)
    assert result["both"]["available"] != Decimal(400) + BILL
