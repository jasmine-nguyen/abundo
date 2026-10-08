"""WHIT-703 slice 2 QA — edges of GET /transactions/cycle's `budgets` the acceptance test
doesn't reach: which dates are read, older cycles, orphan / grandchild / refund budgets,
budget-excluded rows, and that the transaction list is unchanged by the budget maths.

Pay cycle: last_pay_date 2026-07-01, length 30, today 2026-07-25 →
cycle 0 = [2026-07-01, 2026-07-25], cycle 1 = [2026-06-01, 2026-06-30],
cycle 2 = [2026-05-02, 2026-05-31].
"""

import json
from datetime import date
from decimal import Decimal

import pytest

from _api_event import api_event
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _budget_fakes import recording_budget_repo
from _transaction_range_fakes import _DateFilteringTransactionRepo

LENGTH = 30
PAYDATE = "2026-07-01"


CATEGORIES = [
    {"id": "home", "name": "Home", "bucket": "Living", "parent": None},
    {"id": "utilities", "name": "Utilities", "bucket": "Living", "parent": "home"},
    {"id": "power", "name": "Power", "bucket": "Living", "parent": "utilities"},
    {"id": "coffee", "name": "Coffee", "bucket": "Lifestyle", "parent": None},
    {"id": "sink", "name": "Car service", "bucket": "Lifestyle", "parent": None},
]


def _txn(txn_id, date_, amount, category, status="posted", counts=True):
    return {
        "transaction_id": txn_id, "date": date_, "amount": Decimal(str(amount)),
        "category": category, "status": status, "counts_to_budget": counts,
        "merchant_name": "Shop", "description": "SHOP", "account_name": "Everyday",
        "pk": "ACCOUNT#up-spending", "sk": f"TXN#{txn_id}",
    }


TXNS = [
    _txn("c2-power", "2026-05-02", -11, "power"),               # cycle 2, first day
    _txn("c2-coffee", "2026-05-31", -3, "coffee"),              # cycle 2, last day
    _txn("c1-power", "2026-06-05", -80, "power"),               # grandchild of "home"
    _txn("c1-orphan", "2026-06-07", -9, "deleted_cat"),         # target's category is gone
    _txn("c1-excluded", "2026-06-08", -500, "coffee", counts=False),
    _txn("c1-refund", "2026-06-09", 25, "coffee"),              # refund only → clamps to 0
    _txn("c0-coffee", "2026-07-02", -4, "coffee"),
]


def _wire(handler, monkeypatch, budgets, txns=TXNS):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2026, 7, 25))
    repos = {"txn": _DateFilteringTransactionRepo(txns)}
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repos["txn"])
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: _FakePayCycleRepo())
    monkeypatch.setattr(handler, "BudgetRepository", lambda: recording_budget_repo(budgets))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _FakeCategoryRepo(CATEGORIES))
    return repos


def _get(handler, query=None):
    event = api_event("GET", "/transactions/cycle")
    if query is not None:
        event["queryStringParameters"] = query
    response = handler.lambda_handler(event, None)
    assert response["statusCode"] == 200, response
    return json.loads(response["body"], parse_float=Decimal)


def _numbers(entry):
    return Decimal(str(entry["target"])), Decimal(str(entry["posted"])), Decimal(str(entry["pending"]))


ROLLOVER_SINK = {"target": Decimal("100"), "rollover": True, "carryover": Decimal(0),
                 "carryover_from": "2026-05-02", "carryover_len": Decimal(LENGTH),
                 "carryover_paydate": PAYDATE}


# [A1] (P0) last cycle with a rollover budget → reads exactly last cycle's dates (no widened read).
def test_past_cycle_reads_only_its_own_window_even_with_a_rollover_budget(handler, monkeypatch):
    repos = _wire(handler, monkeypatch, {"sink": dict(ROLLOVER_SINK), "coffee": {"target": Decimal("50")}})
    body = _get(handler, {"cycle": "1"})
    assert (body["start"], body["end"]) == ("2026-06-01", "2026-06-30")
    assert set((c[1], c[2]) for c in repos["txn"].calls) == {("2026-06-01", "2026-06-30")}


# [A2] (P0) this cycle with a rollover budget → the file's dates stay this cycle, even though
# the read reaches back for the rollover.
def test_current_cycle_dates_ignore_the_wider_rollover_read(handler, monkeypatch):
    repos = _wire(handler, monkeypatch, {"sink": dict(ROLLOVER_SINK)})
    body = _get(handler)
    assert (body["start"], body["end"]) == ("2026-07-01", "2026-07-25")
    assert min(c[1] for c in repos["txn"].calls) < "2026-07-01"
    assert [row["transaction_id"] for row in body["transactions"]] == ["c0-coffee"]


# [A3] (P1) two cycles back → spend from that window only, first and last day included.
def test_older_cycle_budgets_use_that_cycles_window(handler, monkeypatch):
    _wire(handler, monkeypatch, {"home": {"target": Decimal("200")}, "coffee": {"target": Decimal("50")}})
    body = _get(handler, {"cycle": "2"})
    assert (body["start"], body["end"]) == ("2026-05-02", "2026-05-31")
    assert _numbers(body["budgets"]["home"]) == (Decimal("200"), Decimal("11"), Decimal("0"))
    assert _numbers(body["budgets"]["coffee"]) == (Decimal("50"), Decimal("3"), Decimal("0"))


# [A4] (P1) a parent budget includes a GRANDCHILD's spend for last cycle (unbudgeted middle).
def test_past_cycle_parent_includes_grandchild_spend(handler, monkeypatch):
    _wire(handler, monkeypatch, {"home": {"target": Decimal("200")}})
    budgets = _get(handler, {"cycle": "1"})["budgets"]
    assert _numbers(budgets["home"]) == (Decimal("200"), Decimal("80"), Decimal("0"))
    assert set(budgets) == {"home"}


# [A5] (P1) a budget whose category was deleted is still listed for last cycle, summed as spend.
def test_past_cycle_orphan_budget_is_listed_and_summed(handler, monkeypatch):
    _wire(handler, monkeypatch, {"deleted_cat": {"target": Decimal("40")}})
    budgets = _get(handler, {"cycle": "1"})["budgets"]
    assert _numbers(budgets["deleted_cat"]) == (Decimal("40"), Decimal("9"), Decimal("0"))


# [A6] (P1) last cycle: a budget-excluded charge doesn't count, and a refund-only budget floors
# at 0 (same rules as /budgets) — but both rows are still in the Transactions tab.
def test_past_cycle_excluded_charge_and_refund_follow_budget_rules(handler, monkeypatch):
    _wire(handler, monkeypatch, {"coffee": {"target": Decimal("50")}})
    body = _get(handler, {"cycle": "1"})
    assert _numbers(body["budgets"]["coffee"]) == (Decimal("50"), Decimal("0"), Decimal("0"))
    ids = {row["transaction_id"] for row in body["transactions"]}
    assert {"c1-excluded", "c1-refund"} <= ids


# [A7] (P0) with budgets, the exported rows still lose their storage keys and keep the
# effective "counts to budget" flag, this cycle and last.
@pytest.mark.parametrize("query", [None, {"cycle": "1"}])
def test_rows_are_cleaned_and_flagged_when_budgets_exist(handler, monkeypatch, query):
    _wire(handler, monkeypatch, {"sink": dict(ROLLOVER_SINK), "coffee": {"target": Decimal("50")}})
    rows = _get(handler, query)["transactions"]
    assert rows
    for row in rows:
        assert "pk" not in row and "sk" not in row
        assert "counts_to_budget_effective" in row


# [A8] (P1) last cycle: each entry is the plain {target, posted, pending}, no today-only
# rollover/spread figures leaking into a past cycle.
def test_past_cycle_entries_carry_no_current_only_fields(handler, monkeypatch):
    _wire(handler, monkeypatch, {"sink": dict(ROLLOVER_SINK)})
    budgets = _get(handler, {"cycle": "1"})["budgets"]
    assert set(budgets["sink"]) == {"target", "posted", "pending"}


# [A9] (P1) the budget maths are the same function /budgets uses: budget_spend over the
# current window equals budget_standing's posted/pending for plain budgets.
def test_budget_spend_matches_budget_standing_for_plain_budgets(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2026, 7, 25))
    from budget_standing import budget_spend, budget_standing, standing_window
    targets = {"home": {"target": Decimal("200")}, "coffee": {"target": Decimal("50")}}
    window = standing_window(targets, {"length": LENGTH, "last_pay_date": PAYDATE})
    current = [t for t in TXNS if window.cycle_start <= t["date"] <= window.today]
    rows, _ = budget_standing(targets, window, CATEGORIES, current)
    spend_by_id = budget_spend(targets, CATEGORIES, current)
    for cat_id in targets:
        assert spend_by_id[cat_id] == {"posted": rows[cat_id]["posted"], "pending": rows[cat_id]["pending"]}
