"""WHIT-742: GET /budgets says which cycles a rollover's carryover came from.

A rollover row carries `carryover_cycles` (newest first: sealed history plus the completed
cycles still inside the settle lag, flagged `settling`) and `carryover_earlier` (the part of
the carryover saved before history existed), and together they add up to `carryover`. The
newly sealed cycles are saved on the budget entry as `carryover_history`, in the same write
as the carryover. Carryover and available are worked out exactly as before.
"""

from decimal import Decimal

import pytest

from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo, _txn
from _transaction_range_fakes import _DateFilteringTransactionRepo
from _budget_fakes import recording_budget_repo, stored_budgets

# Monthly cycle: current cycle starts 2026-08-06, today 2026-08-10. Settle lag 10 days →
# cutoff 2026-07-31. Anchor 2026-05-08 gives three completed cycles:
#   2026-05-08 – 2026-06-06  spent 150 → −50  (sealed)
#   2026-06-07 – 2026-07-06  spent   0 → +100 (sealed)
#   2026-07-07 – 2026-08-05  spent  30 → +70  (still settling)
CYCLE_START = "2026-08-06"
TODAY = "2026-08-10"
LENGTH = 30
PAYDATE = "2026-01-01"


@pytest.fixture(autouse=True)
def _fixed_window(handler, monkeypatch):
    import budget_standing
    for module in (handler, budget_standing):
        monkeypatch.setattr(module, "current_cycle_window",
                            lambda last_pay_date, length, today=None: (CYCLE_START, TODAY))


def test_rollover_row_lists_the_cycles_behind_its_carryover_and_saves_the_sealed_ones(handler):
    # A legacy carryover of +40 was saved before history existed.
    budget_repo = recording_budget_repo({"sink": {
        "target": Decimal(100), "rollover": True, "carryover": Decimal(40),
        "carryover_from": "2026-05-08", "carryover_len": Decimal(LENGTH), "carryover_paydate": PAYDATE,
    }})
    transactions = _DateFilteringTransactionRepo([
        _txn("t1", "sink", -150, "2026-05-20"),
        _txn("t2", "sink", -30, "2026-07-20"),
        _txn("t3", "sink", -20, "2026-08-08"),
    ])
    categories = _FakeCategoryRepo([{"id": "sink", "bucket": "Lifestyle", "parent": None}])

    result = handler.list_budgets(budget_repo, transactions, _FakePayCycleRepo(LENGTH, PAYDATE), categories)
    row = result["sink"]

    # Same maths as before: 40 − 50 + 100 + 70 = 160; available = target + carryover.
    assert row["carryover"] == Decimal(160)
    assert row["available"] == Decimal(260)
    assert row["posted"] == Decimal(20)

    assert row["carryover_cycles"] == [
        {"start": "2026-07-07", "end": "2026-08-05", "target": Decimal(100), "spent": Decimal(30),
         "leftover": Decimal(70), "settling": True},
        {"start": "2026-06-07", "end": "2026-07-06", "target": Decimal(100), "spent": Decimal(0),
         "leftover": Decimal(100), "settling": False},
        {"start": "2026-05-08", "end": "2026-06-06", "target": Decimal(100), "spent": Decimal(150),
         "leftover": Decimal(-50), "settling": False},
    ]
    assert row["carryover_earlier"] == Decimal(40)
    assert sum(c["leftover"] for c in row["carryover_cycles"]) + row["carryover_earlier"] == row["carryover"]

    # Only the two sealed cycles are saved, newest first, alongside the sealed carryover.
    saved = stored_budgets(budget_repo)["sink"]
    assert saved["carryover"] == Decimal(90)
    assert saved["carryover_from"] == "2026-07-07"
    assert saved["carryover_history"] == [
        {"start": "2026-06-07", "end": "2026-07-06", "target": Decimal(100), "spent": Decimal(0),
         "leftover": Decimal(100)},
        {"start": "2026-05-08", "end": "2026-06-06", "target": Decimal(100), "spent": Decimal(150),
         "leftover": Decimal(-50)},
    ]
