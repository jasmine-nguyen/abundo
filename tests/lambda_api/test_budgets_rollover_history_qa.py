"""WHIT-742 QA: the cycles behind a rollover carryover, over GET /budgets with the real repository.

Monthly cycle: current cycle starts 2026-08-06, today 2026-08-10, settle cutoff 2026-07-31.
"""

import json
from decimal import Decimal

import pytest

from _budget_endpoint_fakes import _DateFilteringTransactionRepo, _FakeCategoryRepo, _FakePayCycleRepo, _txn, pin_cycle_window
from _budget_fakes import recording_budget_repo, stored_budgets

CYCLE_START = "2026-08-06"
TODAY = "2026-08-10"
LENGTH = 30
PAYDATE = "2026-01-01"
CATEGORIES = _FakeCategoryRepo([{"id": "sink", "bucket": "Lifestyle", "parent": None}])


@pytest.fixture(autouse=True)
def _fixed_window(handler, monkeypatch):
    pin_cycle_window(handler, monkeypatch, CYCLE_START, TODAY)


def _record(start, end, spent, leftover):
    return {"start": start, "end": end, "target": Decimal(100), "spent": Decimal(spent),
            "leftover": Decimal(leftover)}


def _entry(**extra):
    return {"target": Decimal(100), "rollover": True, "carryover_len": Decimal(LENGTH),
            "carryover_paydate": PAYDATE, **extra}


def _list(handler, budget_repo, transactions, length=LENGTH):
    return handler.list_budgets(budget_repo, _DateFilteringTransactionRepo(transactions),
                                _FakePayCycleRepo(length, PAYDATE), CATEGORIES)


def _adds_up(row):
    return sum(c["leftover"] for c in row["carryover_cycles"]) + row["carryover_earlier"] == row["carryover"]


SPEND = [_txn("t1", "sink", -150, "2026-05-20"), _txn("t2", "sink", -30, "2026-07-20")]


# [A3] (P0) A second read after the seal returns the same list from the saved history, with no
# extra write and nothing counted twice.
def test_a_second_read_lists_the_same_cycles_from_the_saved_history_without_writing(handler):
    budget_repo = recording_budget_repo({"sink": _entry(carryover=Decimal(40), carryover_from="2026-05-08")})

    first = _list(handler, budget_repo, SPEND)["sink"]
    second = _list(handler, budget_repo, SPEND)["sink"]

    assert second == first
    assert second["carryover"] == Decimal(160)
    assert _adds_up(second)
    assert len(budget_repo.settle_calls) == 1


# [A2] (P0) The response the app receives is valid JSON with the cycles as plain numbers.
def test_the_budgets_response_serialises_the_cycles_for_the_app(handler):
    budget_repo = recording_budget_repo({"sink": _entry(carryover=Decimal(40), carryover_from="2026-05-08")})

    body = json.loads(handler._json_response(200, _list(handler, budget_repo, SPEND))["body"])
    row = body["sink"]

    assert [c["leftover"] for c in row["carryover_cycles"]] == [70, 100, -50]
    assert [c["settling"] for c in row["carryover_cycles"]] == [True, False, False]
    assert row["carryover_earlier"] == 40
    assert row["carryover"] == 160


# [A4] (P1) A pay-cycle change re-anchors: the saved cycles stay listed and still add up.
def test_a_pay_cycle_change_keeps_the_saved_cycles_and_they_still_add_up(handler):
    old = _record("2026-05-08", "2026-05-21", 150, -50)
    budget_repo = recording_budget_repo({"sink": _entry(
        carryover=Decimal(-10), carryover_from="2026-05-22", carryover_len=Decimal(14), carryover_history=[old])})

    row = _list(handler, budget_repo, [])["sink"]

    assert row["carryover"] == Decimal(-10)
    assert row["carryover_cycles"] == [{**old, "settling": False}]
    assert row["carryover_earlier"] == Decimal(40)
    assert _adds_up(row)
    saved = stored_budgets(budget_repo)["sink"]
    assert saved["carryover_history"] == [old]
    assert saved["carryover_from"] == CYCLE_START


# [A7] (P1) A long gap is capped at the lookback; the cycles that are folded are the ones listed.
def test_a_long_gap_lists_only_the_folded_cycles_and_still_adds_up(handler):
    budget_repo = recording_budget_repo({"sink": _entry(carryover=Decimal(-25), carryover_from="2024-01-01")})

    row = _list(handler, budget_repo, [])["sink"]

    assert _adds_up(row)
    assert row["carryover_earlier"] == Decimal(-25)
    saved = stored_budgets(budget_repo)["sink"]
    assert sum(r["leftover"] for r in saved["carryover_history"]) + Decimal(-25) == saved["carryover"]


# [A8] (P1) Turning rollover off and moving to a spread or out of spend strips the saved cycles.
def test_clearing_rollover_or_setting_a_spread_drops_the_saved_cycles(handler):
    history = [_record("2026-06-07", "2026-07-06", 0, 100)]
    budget_repo = recording_budget_repo({
        "a": _entry(carryover=Decimal(100), carryover_from="2026-07-07", carryover_history=history),
        "b": _entry(carryover=Decimal(100), carryover_from="2026-07-07", carryover_history=history),
    })

    budget_repo.clear_rollover("a")
    budget_repo.set_spread("b", Decimal(300), 3, CYCLE_START, LENGTH, PAYDATE)

    stored = stored_budgets(budget_repo)
    assert "carryover_history" not in stored["a"]
    assert "carryover_history" not in stored["b"]
