"""WHIT-549 — adversarial GAP tests for the server-computed `available` on GET /budgets.

The implementer's tests/lambda_api/test_budgets_available.py already cover the four normal
row kinds (plain / income / rollover / spread), the corrupt-both XOR precedence, and the
happy positive cushions. These cover the edges they DON'T:

  [G1] rollover with a NEGATIVE live carryover (a prior overspend deficit) -> available < target
  [G2] spread PAYBACK cycle (index>0, negative adjustment) -> available < target, can go negative
  [G3] a REANCHORED rollover (misaligned pay cycle, reanchor_by_id path) still emits available
  [G4] an income PARENT with a child subtree: available is the parent's own target, not inflated
       by the child's folded income
  [G5] `available` survives the REAL JSON response (DecimalEncoder) as a number, not a string/dropped

Same deterministic grid as the sibling suites: monthly, cycle_start 2026-08-06, payday grid
from 2026-01-01. `current_cycle_window` is monkeypatched to a fixed window.
"""

import json
from decimal import Decimal

import pytest

CYCLE_START = "2026-08-06"
TODAY = "2026-08-10"
LENGTH = 30
PAYDATE = "2026-01-01"

BILL = Decimal("1390.91")   # 4-cycle split: index-1 payback slice = -347.73


class FakeBudgetRepo:
    def __init__(self, budgets=None):
        self._budgets = budgets or {}
        self.settle_calls = []
        self.set_spread_calls = []
        self.clear_spread_calls = []

    def list_budgets(self):
        return {k: dict(v) for k, v in self._budgets.items()}

    def settle_carryover(self, cat_id, carryover, carryover_from, carryover_len, carryover_paydate):
        self.settle_calls.append((cat_id, carryover, carryover_from, carryover_len, carryover_paydate))
        self._budgets.setdefault(cat_id, {}).update({
            "carryover": carryover, "carryover_from": carryover_from,
            "carryover_len": Decimal(carryover_len), "carryover_paydate": carryover_paydate,
        })

    def set_spread(self, cat_id, amount, cycles, spread_from, spread_len, spread_paydate):
        self.set_spread_calls.append((cat_id, amount, cycles, spread_from, spread_len, spread_paydate))

    def clear_spread(self, cat_id):
        self.clear_spread_calls.append(cat_id)


class FakeTransactionRepo:
    def __init__(self, transactions=None):
        self._queue = [(list(transactions or []), None)]

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        return self._queue.pop(0) if self._queue else ([], None)


class FakePayCycleRepo:
    def get_paycycle(self):
        return {"length": LENGTH, "last_pay_date": PAYDATE}


class FakeCategoryRepo:
    def __init__(self, categories):
        self._categories = categories

    def list_categories(self):
        return [dict(c) for c in self._categories]


def _txn(category, amount, date, status="posted"):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "date": date, "counts_to_budget": True}


def _list(handler, budget_repo, transactions=None, categories=None):
    cats = categories if categories is not None else [{"id": "cat", "bucket": "Living", "parent": None}]
    return handler.list_budgets(
        budget_repo, FakeTransactionRepo(transactions), FakePayCycleRepo(), FakeCategoryRepo(cats))


@pytest.fixture(autouse=True)
def _fixed_window(handler, monkeypatch):
    monkeypatch.setattr(handler, "current_cycle_window",
                        lambda last_pay_date, length, today=None: (CYCLE_START, TODAY))


# [G1] rollover DEFICIT: a live carryover that is NEGATIVE (prior overspend) subtracts.
def test_rollover_negative_carryover_makes_available_below_target(handler):
    # A sinking fund that went into the red: stored buffer -60 on a 100 target, no completed
    # cycles this read (anchor == current), so the live carryover the row reports is -60.
    # available = 100 + (-60) = 40 — the deficit must eat into the spendable, not be clamped to 100.
    cats = [{"id": "sink", "bucket": "Lifestyle", "parent": None}]
    entry = {"target": Decimal(100), "rollover": True, "carryover": Decimal(-60),
             "carryover_from": CYCLE_START, "carryover_len": Decimal(LENGTH), "carryover_paydate": PAYDATE}
    result = _list(handler, FakeBudgetRepo({"sink": entry}), categories=cats)

    assert result["sink"]["carryover"] == Decimal(-60)
    assert result["sink"]["available"] == Decimal(40)


# [G2] spread PAYBACK cycle: index 1 gives a NEGATIVE adjustment -> available can go below zero.
def test_spread_payback_cycle_available_is_target_minus_slice(handler):
    # Plan anchored ONE cycle back (spread_from = 30 days before cycle_start) -> index 1 -> the
    # first payback slice of a 4-way split of 1390.91 = -347.73. available = 250 - 347.73 = -97.73,
    # a legitimately NEGATIVE spendable the server must emit verbatim (no floor at 0).
    spread_from = "2026-07-07"   # 30 days before 2026-08-06 -> spread_index == 1
    entry = {"target": Decimal(250), "spread_amount": BILL, "spread_cycles": Decimal(4),
             "spread_from": spread_from, "spread_len": Decimal(LENGTH), "spread_paydate": PAYDATE}
    result = _list(handler, FakeBudgetRepo({"cat": entry}))

    assert result["cat"]["spread"]["index"] == 1
    assert result["cat"]["spread"]["adjustment"] == Decimal("-347.73")
    assert result["cat"]["available"] == Decimal("250") + Decimal("-347.73")   # == -97.73


# [G3] a REANCHORED rollover (misaligned pay cycle) still carries `available`.
def test_reanchored_rollover_still_emits_available(handler):
    # carryover_len 14 != the current length 30 -> _rollover_windows re-anchors: freeze the stored
    # balance (200) to the current cycle. The reanchor_by_id branch is a DIFFERENT code path than a
    # normal seal; available must still be target + frozen carryover = 100 + 200 = 300.
    cats = [{"id": "moved", "bucket": "Lifestyle", "parent": None}]
    entry = {"target": Decimal(100), "rollover": True, "carryover": Decimal(200),
             "carryover_from": "2026-05-08", "carryover_len": Decimal(14), "carryover_paydate": PAYDATE}
    result = _list(handler, FakeBudgetRepo({"moved": entry}), categories=cats)

    assert result["moved"]["carryover"] == Decimal(200)
    assert result["moved"]["available"] == Decimal(300)


# [G4] income PARENT with a child subtree: available is the parent's OWN target, not inflated.
def test_income_parent_available_is_own_target_not_child_folded(handler):
    # Parent "salary" (target 5000) has child "bonus"; a 900 bonus txn tagged on the child folds into
    # the parent's posted (subtree sum), but income is excluded from both cushions -> parent available
    # stays 5000, not 5000 + child anything. Child's own available == its own target.
    cats = [
        {"id": "salary", "bucket": "Income", "parent": None},
        {"id": "bonus", "bucket": "Income", "parent": "salary"},
    ]
    budget_repo = FakeBudgetRepo({"salary": {"target": Decimal(5000)}, "bonus": {"target": Decimal(900)}})
    result = _list(handler, budget_repo, [_txn("bonus", 900, "2026-08-08")], cats)

    assert result["salary"]["available"] == Decimal(5000)
    assert result["bonus"]["available"] == Decimal(900)
    # sanity: the child income DID fold into the parent's posted (so available isn't just ignoring txns)
    assert result["salary"]["posted"] == Decimal(900)


# [G5] `available` survives the REAL JSON response as a number (DecimalEncoder -> float), not dropped.
def test_available_serialises_as_a_json_number_through_the_real_response(handler):
    # list_budgets returns Decimals; the real GET /budgets wraps them in handler._json_response, which
    # dumps with DecimalEncoder. Pin that `available` reaches the wire as a NUMBER the client can read
    # with `b.available ?? ...` — not a string, and not silently dropped by the encoder.
    entry = {"target": Decimal(250), "spread_amount": BILL, "spread_cycles": Decimal(4),
             "spread_from": CYCLE_START, "spread_len": Decimal(LENGTH), "spread_paydate": PAYDATE}
    result = _list(handler, FakeBudgetRepo({"cat": entry}), [_txn("cat", -1390.91, "2026-08-07")])

    body = json.loads(handler._json_response(200, result)["body"])
    assert "available" in body["cat"]
    assert isinstance(body["cat"]["available"], (int, float))
    assert not isinstance(body["cat"]["available"], bool)
    assert body["cat"]["available"] == pytest.approx(250 + 1390.91)
