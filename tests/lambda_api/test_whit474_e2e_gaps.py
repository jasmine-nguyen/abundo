"""WHIT-474 — adversarial GAP coverage for the rollover-clear cascade.

The implementer tested the PIECES (clear_rollover at the repo, the cascade fires at the
handler) but never the true regression: the REAL BudgetRepository's clear feeding the REAL
list_budgets fold. These attack that seam and the error/edge paths the piece-tests miss.

Complements (does NOT duplicate):
  * tests/shared/test_repository_budget.py  — clear_rollover unit behaviour
  * tests/lambda_api/test_categories.py     — cascade fires / best-effort swallow (mocked repo)

`handler.current_cycle_window` is pinned per test so the cycle math is deterministic.
Uses the REAL handler.BudgetRepository over the shared FakeTable so a clear actually strips
fields that a later list_budgets read must honour.
"""

from decimal import Decimal
from functools import partial

import pytest

from _api_event import api_event
from _budget_endpoint_fakes import LENGTH, PAYDATE, _FakePayCycleRepo
from _category_fakes import _cat
from _dynamo_fakes import FakeTable
from _transaction_range_fakes import _QueuedTransactionRepo

pytestmark = pytest.mark.usefixtures("fixed_window")


_KEY = ("BUDGETS", "BUDGETS")


def _config_table(items, version=1):
    """The shared FakeTable holding the ONE budgets config item (pk=sk="BUDGETS")."""
    table = FakeTable()
    table.seed({"pk": "BUDGETS", "sk": "BUDGETS", "items": items, "version": Decimal(version)})
    return table


FakePayCycleRepo = partial(_FakePayCycleRepo, length=LENGTH, last_pay_date=PAYDATE)


def _category_repo(cat_id, bucket):
    """The REAL CategoryRepository over a FakeTable holding the one category, so a re-bucket
    lands in the store and a later list_categories reads it back."""
    import repository_category
    repo = repository_category.CategoryRepository()
    repo._table = FakeTable()
    repo._table.seed({"pk": "CATEGORIES", "sk": "CATEGORIES", "version": Decimal(1),
                      "items": {cat_id: _cat(cat_id, bucket, parent=None)}})
    return repo


def _event(bucket, cat_id="sink"):
    return api_event(
        "PATCH",
        f"/categories/{cat_id}",
        body={"name": "Sink", "bucket": bucket},
        path_params={"id": cat_id},
        is_base64=False,
    )


def _rollover_entry(target=100, carryover=0, carryover_from="2026-05-08"):
    # An OLD anchor (3 cycles back) aligned to the current pay cycle: WOULD fold every cycle
    # since if it were still treated as rollover. carryover starts 0 so any non-zero result
    # is purely re-folded past cycles (the exact WHIT-474 buffer resurrection).
    return {
        "target": Decimal(target), "rollover": True, "carryover": Decimal(carryover),
        "carryover_from": carryover_from, "carryover_len": Decimal(LENGTH),
        "carryover_paydate": PAYDATE,
    }


def _budget_repo(handler, table):
    r = handler.BudgetRepository()
    r._table = table
    return r


# --- [A1] the true regression: real clear -> re-bucket back -> no re-fold ------


def test_rebucket_to_income_then_back_to_spend_does_not_resurrect_the_buffer(handler):
    # WHIT-474 — [A1] END-TO-END against the REAL BudgetRepository + REAL list_budgets fold:
    # a rollover sink with a 3-cycle-old anchor -> re-bucket to Income (REAL clear strips the
    # fields, keeps the target) -> re-bucket back to a spend bucket -> GET /budgets. The buffer
    # must NOT reappear and NO past cycle may re-fold. FAIL-ON-REVERT: drop the handler cascade
    # and the surviving anchor re-folds 3 empty cycles -> carryover 300, reddening this.
    table = _config_table(items={"sink": _rollover_entry()})
    budget_repo = _budget_repo(handler, table)
    cat_repo = _category_repo("sink", "Lifestyle")

    to_income = handler.update_category(_event("Income"), cat_repo, budget_repo)
    assert to_income["statusCode"] == 200
    # the REAL clear ran on the REAL store: only the dollar target survives.
    assert table.store[_KEY]["items"]["sink"] == {"target": Decimal(100)}

    back_to_spend = handler.update_category(_event("Lifestyle"), cat_repo, budget_repo)
    assert back_to_spend["statusCode"] == 200

    result = handler.list_budgets(budget_repo, _QueuedTransactionRepo(), FakePayCycleRepo(), cat_repo)

    row = result["sink"]
    assert row["target"] == Decimal(100)          # the target is intact
    assert "carryover" not in row                 # no buffer resurrected
    assert "rollover" not in row                  # and it reads as a plain non-rollover budget

