"""Tests for the server-computed `available` on GET /budgets (WHIT-549).

The /budgets read now emits a per-row `available` — the spendable this cycle — computed
server-side from the unified Smoothing engine (`shared/spend.unified_available`) instead of
being re-summed on the client:

    available = target + (rollover ? live carryover : 0)

Bill spread was removed (ABU-91); saved entries may still carry its old fields until the
clean-up script runs, and the read ignores them.

Same deterministic grid as the rollover suites: monthly, cycle_start 2026-08-06,
payday grid from 2026-01-01. `current_cycle_window` is monkeypatched to a fixed window.
"""

from decimal import Decimal
from functools import partial

import pytest

from _budget_endpoint_fakes import CYCLE_START, LENGTH, PAYDATE, _FakeCategoryRepo, _FakePayCycleRepo
from _budget_fakes import recording_budget_repo
from _transaction_range_fakes import _QueuedTransactionRepo

pytestmark = pytest.mark.usefixtures("fixed_window")


BILL = Decimal("1390.91")   # an old saved spread amount


FakePayCycleRepo = partial(_FakePayCycleRepo, length=LENGTH, last_pay_date=PAYDATE)


def _txn(category, amount, date, status="posted"):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "date": date, "counts_to_budget": True}


def _list(handler, budget_repo, transactions=None, categories=None):
    cats = categories if categories is not None else [{"id": "cat", "bucket": "Living", "parent": None}]
    return handler.list_budgets(
        budget_repo, _QueuedTransactionRepo(transactions), FakePayCycleRepo(), _FakeCategoryRepo(cats))


# --- available = target + carryover ----------------------------------------------


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


def test_a_leftover_saved_spread_is_ignored_and_never_rewritten(handler):
    # ABU-91: bill spread is gone, but saved entries keep their old spread fields until the
    # clean-up script runs. The read ignores them: available is just the target, the reply has
    # no spread, and nothing is written back.
    entry = {"target": Decimal(250), "spread_amount": BILL, "spread_cycles": Decimal(4),
             "spread_from": CYCLE_START, "spread_len": Decimal(LENGTH), "spread_paydate": PAYDATE}
    budget_repo = recording_budget_repo({"cat": entry})
    result = _list(handler, budget_repo, [_txn("cat", -1390.91, "2026-08-07")])

    assert result["cat"]["available"] == Decimal(250)
    assert "spread" not in result["cat"]
    assert budget_repo._table.update_calls == []
    assert budget_repo._table.put_calls == []


def test_a_row_flagged_both_rollover_and_spread_never_sums_both_cushions(handler):
    # An old row can carry rollover AND leftover spread fields. Only the rollover carryover
    # counts — never target + carryover + the old spread amount.
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
