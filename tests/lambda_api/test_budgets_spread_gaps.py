"""QA gap tests for the bill SPREAD (WHIT-504) — the adversarial half.

The happy paths, slice math, bounds and mutual-exclusion guards are pinned in
tests/lambda_api/test_budgets_spread.py; this file covers what those leave open:
subtree rows, body encodings, the lambda_handler dispatch (409 / 404 / JSON shape), a
stateful PUT->PUT->GET sequence, and the reclassify guards. Same fixed window as the
sibling suite. Deliberately does NOT import tests/shared/_category_fakes.py (the WHIT-445
closed-importer guard); it carries its own small stateful fake.
"""

import base64
import json
from decimal import Decimal

import pytest

CYCLE_START = "2026-08-06"
TODAY = "2026-08-10"
LENGTH = 30
PAYDATE = "2026-01-01"
BILL = Decimal("1390.91")   # over 4 cycles: 347.73, 347.73, 347.73, 347.72

SPREAD_KEYS = ("spread_amount", "spread_cycles", "spread_from", "spread_len", "spread_paydate")


class StatefulBudgetRepo:
    """Like the sibling suite's FakeBudgetRepo but the writes actually land, so a
    PUT -> PUT -> GET sequence reads back what the earlier handlers stored."""

    def __init__(self, budgets=None):
        self._budgets = budgets or {}
        self.clear_spread_calls = []
        self.raise_on_clear = set()     # cat_ids whose clear_spread raises
        self.raises = None              # exception raised by every write

    def list_budgets(self):
        return {k: dict(v) for k, v in self._budgets.items()}

    def set_budget(self, cat_id, target, rollover=None, anchor=None):
        if self.raises:
            raise self.raises
        entry = self._budgets.setdefault(cat_id, {})
        entry["target"] = target
        if rollover is not None:
            entry["rollover"] = rollover
        if anchor:
            entry.update(anchor)
        return {"id": cat_id, "target": target}

    def set_spread(self, cat_id, amount, cycles, spread_from, spread_len, spread_paydate):
        if self.raises:
            raise self.raises
        self._budgets.setdefault(cat_id, {}).update({
            "spread_amount": amount, "spread_cycles": Decimal(cycles), "spread_from": spread_from,
            "spread_len": Decimal(spread_len), "spread_paydate": spread_paydate,
        })
        return {"id": cat_id, "amount": amount, "cycles": cycles}

    def clear_spread(self, cat_id):
        self.clear_spread_calls.append(cat_id)
        if self.raises:
            raise self.raises
        if cat_id in self.raise_on_clear:
            raise RuntimeError("boom")
        for key in SPREAD_KEYS:
            self._budgets.get(cat_id, {}).pop(key, None)

    def clear_rollover(self, cat_id):
        # Only the reclassify cascade reaches this; nothing here asserts on it.
        pass

    def settle_carryover(self, cat_id, carryover, carryover_from, carryover_len, carryover_paydate):
        self._budgets.setdefault(cat_id, {}).update({
            "carryover": carryover, "carryover_from": carryover_from,
            "carryover_len": Decimal(carryover_len), "carryover_paydate": carryover_paydate,
        })

    def delete_budget(self, cat_id):
        self._budgets.pop(cat_id, None)


class FakeTransactionRepo:
    def __init__(self, transactions=None):
        self._queue = [(list(transactions or []), None)]

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        return self._queue.pop(0) if self._queue else ([], None)


class FakePayCycleRepo:
    def get_paycycle(self):
        return {"length": LENGTH, "last_pay_date": PAYDATE}


class FakeCategoryRepo:
    def __init__(self, categories=None):
        self._categories = categories if categories is not None else _spend_cat()
        self.update_calls = []

    def list_categories(self):
        return [dict(c) for c in self._categories]

    def update_category(self, cat_id, name, bucket, icon, parent=None):
        # Only the re-bucket guard test reaches this (update_category handler).
        self.update_calls.append((cat_id, name, bucket, icon))
        return {"id": cat_id, "name": name, "bucket": bucket, "icon": icon, "parent": None}


def _spend_cat(cat_id="insurance", bucket="Living", parent=None):
    return [{"id": cat_id, "bucket": bucket, "parent": parent}]


def _txn(category, amount, date):
    return {"category": category, "amount": Decimal(str(amount)), "status": "posted",
            "date": date, "counts_to_budget": True}


def _entry(spread_from, amount=BILL, cycles=4, spread_len=LENGTH, target=250, **extra):
    return {
        "target": Decimal(target), "spread_amount": amount, "spread_cycles": Decimal(cycles),
        "spread_from": spread_from, "spread_len": Decimal(spread_len), "spread_paydate": PAYDATE,
        **extra,
    }


def _list(handler, budget_repo, transactions=None, categories=None):
    return handler.list_budgets(
        budget_repo, FakeTransactionRepo(transactions), FakePayCycleRepo(), FakeCategoryRepo(categories))


def _event(method, path, category=None, body=None, b64=False):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if category is not None:
        event["pathParameters"] = {"category": category}
    if body is not None:
        event["body"] = base64.b64encode(body.encode()).decode() if b64 else body
        event["isBase64Encoded"] = b64
    return event


def _wire(handler, monkeypatch, budget_repo, categories=None, transactions=None):
    monkeypatch.setattr(handler, "BudgetRepository", lambda: budget_repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: FakePayCycleRepo())
    monkeypatch.setattr(handler, "TransactionRepository", lambda: FakeTransactionRepo(transactions))


@pytest.fixture(autouse=True)
def _fixed_window(handler, monkeypatch):
    monkeypatch.setattr(handler, "current_cycle_window",
                        lambda last_pay_date, length, today=None: (CYCLE_START, TODAY))


# --- subtree rows ------------------------------------------------------------------


def test_a_spread_on_a_parent_cushions_the_parent_row_with_the_childs_bill_folded_in(handler):
    # The bill is tagged on the CHILD; the plan sits on the PARENT's budget. The parent row
    # folds the child's spend (WHIT-228) AND carries the cushion, so the client's spendable
    # (target + adjustment) covers the folded bill.
    categories = [{"id": "bills", "bucket": "Living", "parent": None},
                  {"id": "insurance", "bucket": "Living", "parent": "bills"}]
    budget_repo = StatefulBudgetRepo({"bills": _entry(spread_from=CYCLE_START)})

    result = _list(handler, budget_repo, [_txn("insurance", -1390.91, "2026-08-07")], categories)

    assert result["bills"]["posted"] == BILL
    assert result["bills"]["spread"] == {"amount": BILL, "cycles": 4, "index": 0, "adjustment": BILL}
    assert "insurance" not in result           # no target on the child -> no row


def test_a_spread_on_a_child_does_not_leak_onto_the_budgeted_parent_row(handler):
    # The plan is per category: the parent folds the child's spend but gets NO cushion, so
    # the parent's spendable still reads the bill as an overspend. (Documented for PR2 —
    # a design choice, not a defect in this contract.)
    categories = [{"id": "bills", "bucket": "Living", "parent": None},
                  {"id": "insurance", "bucket": "Living", "parent": "bills"}]
    budget_repo = StatefulBudgetRepo({
        "bills": {"target": Decimal(500)},
        "insurance": _entry(spread_from=CYCLE_START),
    })

    result = _list(handler, budget_repo, [_txn("insurance", -1390.91, "2026-08-07")], categories)

    assert result["insurance"]["spread"]["adjustment"] == BILL
    assert result["bills"]["posted"] == BILL
    assert "spread" not in result["bills"]


# --- reclassify guards --------------------------------------------------------------


def test_a_spread_cannot_be_stranded_on_a_savings_category_via_reclassify(handler):
    # The pre-existing WHIT-202 guard blocks a re-bucket to Savings while a budget exists
    # (and a spread REQUIRES a budget), so the only non-spend strand is Income, which the
    # reclassify path clears. Pin that the guard fires before any clear is attempted.
    repo = FakeCategoryRepo(_spend_cat("coffee"))
    budget = StatefulBudgetRepo({"coffee": _entry(spread_from=CYCLE_START)})
    event = {
        "rawPath": "/categories/coffee", "requestContext": {"http": {"method": "PATCH"}},
        "pathParameters": {"id": "coffee"},
        "body": '{"name": "Coffee", "bucket": "Savings", "icon": "coffee"}', "isBase64Encoded": False,
    }

    resp = handler.update_category(event, repo, budget)

    assert resp["statusCode"] == 400
    assert budget.clear_spread_calls == []
    assert repo.update_calls == []


# --- best-effort persistence across several categories ----------------------------


def test_one_failing_clear_does_not_skip_the_other_finished_spreads(handler):
    # Two finished plans on one read; the first id's clear raises. The second must still be
    # attempted (each write is its own best-effort try), and the read succeeds.
    categories = _spend_cat("a") + _spend_cat("b")
    budget_repo = StatefulBudgetRepo({"a": _entry(spread_from="2026-03-09"),
                                      "b": _entry(spread_from="2026-03-09")})
    budget_repo.raise_on_clear = {"a"}

    result = _list(handler, budget_repo, categories=categories)

    assert "spread" not in result["a"] and "spread" not in result["b"]
    assert budget_repo.clear_spread_calls == ["a", "b"]
    assert "spread_amount" not in budget_repo._budgets["b"]     # b really was cleared


# --- PUT body encodings + input strictness -------------------------------------------


def test_set_spread_accepts_a_base64_body(handler):
    # API Gateway may base64-encode the body; the shared parser must be used.
    repo = StatefulBudgetRepo({"insurance": {"target": Decimal(250)}})

    resp = handler.set_spread(
        _event("PUT", "/budgets/insurance/spread", "insurance", '{"amount": 120.5, "cycles": 2}', b64=True),
        repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo._budgets["insurance"]["spread_amount"] == Decimal("120.50")


@pytest.mark.parametrize("body", [
    "not json",                       # invalid JSON
    "",                               # empty body
    '[{"amount": 100, "cycles": 2}]', # a JSON array, not an object
    '{"amount": 100, "cycles": 2.0}', # a float that equals an int is still not an int
    '{"amount": 100, "cycles": "4"}', # numeric string
])
def test_set_spread_rejects_malformed_or_loosely_typed_bodies_400(handler, body):
    repo = StatefulBudgetRepo({"insurance": {"target": Decimal(250)}})

    resp = handler.set_spread(_event("PUT", "/budgets/insurance/spread", "insurance", body),
                              repo, FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert "spread_amount" not in repo._budgets["insurance"]


def test_set_spread_accepts_an_orphan_id_with_a_target_like_set_budget_does(handler):
    # An id not in the taxonomy has bucket None (not Income/Savings). set_budget already
    # accepts an orphan target, so a spread on that orphan is accepted too — the client
    # ignores orphan rows. Documents the policy so tightening it is a deliberate change.
    repo = StatefulBudgetRepo({"ghost": {"target": Decimal(250)}})

    resp = handler.set_spread(_event("PUT", "/budgets/ghost/spread", "ghost", '{"amount": 100, "cycles": 2}'),
                              repo, FakeCategoryRepo([]), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo._budgets["ghost"]["spread_amount"] == Decimal("100.00")


# --- lambda_handler dispatch: 409, 404, JSON shape, and a stateful sequence ----------


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
def test_a_write_conflict_from_the_spread_routes_maps_to_409(handler, monkeypatch, method):
    # The dispatch wrapper turns VersionConflictError into 409 for every route inside its
    # try; the two NEW branches must sit inside it too.
    repo = StatefulBudgetRepo({"insurance": {"target": Decimal(250)}})
    repo.raises = handler.VersionConflictError("contention")
    _wire(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event(method, "/budgets/insurance/spread", "insurance", '{"amount": 100, "cycles": 2}'), None)

    assert resp["statusCode"] == 409


@pytest.mark.parametrize("method", ["GET", "PATCH", "POST"])
def test_other_methods_on_the_spread_path_are_404_not_routed_to_a_budget_handler(handler, monkeypatch, method):
    # Only PUT/DELETE exist; a GET must not fall into list/transactions.
    repo = StatefulBudgetRepo({"insurance": _entry(spread_from=CYCLE_START)})
    _wire(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event(method, "/budgets/insurance/spread", "insurance", '{"amount": 100, "cycles": 2}'), None)

    assert resp["statusCode"] == 404
    assert repo.clear_spread_calls == []
    assert repo._budgets["insurance"]["spread_amount"] == BILL      # nothing written


def test_get_budgets_serialises_the_spread_object_as_json_numbers(handler, monkeypatch):
    # Through lambda_handler: Decimal amount/adjustment render as JSON numbers
    # (DecimalEncoder), and cycles/index stay JSON integers (not 4.0 / 1.0).
    repo = StatefulBudgetRepo({"insurance": _entry(spread_from="2026-07-07")})
    _wire(handler, monkeypatch, repo)

    resp = handler.lambda_handler(_event("GET", "/budgets"), None)

    assert resp["statusCode"] == 200
    spread = json.loads(resp["body"])["insurance"]["spread"]
    assert spread == {"amount": 1390.91, "cycles": 4, "index": 1, "adjustment": -347.73}
    assert isinstance(spread["cycles"], int) and isinstance(spread["index"], int)
    assert isinstance(spread["adjustment"], float)


def test_spread_then_rollover_then_get_keeps_exactly_one_of_the_two(handler, monkeypatch):
    # End-to-end through the router with a store that keeps state:
    # PUT spread (200) -> PUT rollover (400, spread still there) -> GET shows spread only ->
    # DELETE spread -> PUT rollover (200) -> GET shows rollover only -> PUT spread (400).
    repo = StatefulBudgetRepo({"insurance": {"target": Decimal(250)}})
    _wire(handler, monkeypatch, repo)
    put_spread = _event("PUT", "/budgets/insurance/spread", "insurance", '{"amount": 100, "cycles": 2}')
    put_rollover = _event("PUT", "/budgets/insurance", "insurance", '{"target": 250, "rollover": true}')

    assert handler.lambda_handler(put_spread, None)["statusCode"] == 200
    assert handler.lambda_handler(put_rollover, None)["statusCode"] == 400
    row = json.loads(handler.lambda_handler(_event("GET", "/budgets"), None)["body"])["insurance"]
    assert row["spread"]["adjustment"] == 100 and "rollover" not in row

    assert handler.lambda_handler(_event("DELETE", "/budgets/insurance/spread", "insurance"), None)["statusCode"] == 200
    assert handler.lambda_handler(put_rollover, None)["statusCode"] == 200
    row = json.loads(handler.lambda_handler(_event("GET", "/budgets"), None)["body"])["insurance"]
    assert row["rollover"] is True and "spread" not in row

    assert handler.lambda_handler(put_spread, None)["statusCode"] == 400
    assert "spread_amount" not in repo._budgets["insurance"]
