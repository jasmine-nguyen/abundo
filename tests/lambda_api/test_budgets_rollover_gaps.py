"""Budget ROLLOVER — adversarial GAP coverage (QA, budget-rollover feature).

Complements tests/lambda_api/test_budgets_rollover.py (happy-path seal/accumulate) and
tests/lambda_api/test_budgets.py (set_budget validation). Here we attack the edges the
implementer's suite doesn't pin:

  * the EXACT settle-lag cutoff boundary (end == cutoff must NOT seal),
  * SUBTREE sealing (a budgeted parent's sealed leftover must fold its children),
  * a refund in a sealed cycle (per-cycle spend floors at 0 -> leftover caps at target),
  * the current-cycle slice boundary (a txn dated exactly cycle_start is current, not sealed),
  * PUT /budgets rollover: OFF->ON anchors, an already-ON amount edit does NOT re-anchor,
    rollover:true rejected on Income, a non-boolean rollover rejected, explicit false frozen.

`handler.current_cycle_window` is monkeypatched per test to a fixed (cycle_start, today) so the
window math is deterministic. LAG is 10 days (ROLLOVER_SETTLE_LAG_DAYS); CAP is 12.
"""

from decimal import Decimal

import json

import pytest

LENGTH = 30
PAYDATE = "2026-01-01"


# --- fakes (module-local, mirroring the sibling suites' pattern) --------------


class FakeBudgetRepo:
    def __init__(self, budgets):
        self._budgets = budgets
        self.settle_calls = []
        self.set_calls = []
        self.set_kwargs = None

    def list_budgets(self):
        return {k: dict(v) for k, v in self._budgets.items()}

    def set_budget(self, cat_id, target, rollover=None, anchor=None):
        self.set_calls.append((cat_id, target))
        self.set_kwargs = {"rollover": rollover, "anchor": anchor}
        return {"id": cat_id, "target": target}

    def settle_carryover(self, cat_id, carryover, carryover_from, carryover_len, carryover_paydate):
        self.settle_calls.append((cat_id, carryover, carryover_from, carryover_len, carryover_paydate))
        self._budgets.setdefault(cat_id, {}).update({
            "carryover": carryover, "carryover_from": carryover_from,
            "carryover_len": Decimal(carryover_len), "carryover_paydate": carryover_paydate,
        })


class FakeTransactionRepo:
    """Serves the queued page once (ignores the date range — the handler slices by date)."""

    def __init__(self, transactions=None):
        self._queue = [(list(transactions or []), None)]

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        return self._queue.pop(0) if self._queue else ([], None)


class FakePayCycleRepo:
    def __init__(self, length=LENGTH, last_pay_date=PAYDATE):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


class FakeCategoryRepo:
    def __init__(self, categories):
        self._categories = categories

    def list_categories(self):
        return [dict(c) for c in self._categories]


def _txn(category, amount, date, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "date": date, "counts_to_budget": counts}


def _spend_cat(cat_id="sink", bucket="Lifestyle", parent=None):
    return {"id": cat_id, "bucket": bucket, "parent": parent}


def _entry(target, **extra):
    entry = {"target": Decimal(str(target)), "rollover": True,
             "carryover_len": Decimal(LENGTH), "carryover_paydate": PAYDATE}
    entry.update(extra)
    return entry


def _pin_window(handler, monkeypatch, cycle_start, today):
    monkeypatch.setattr(handler, "current_cycle_window",
                        lambda last_pay_date, length, _today=None: (cycle_start, today))


# --- settle-lag EXACT boundary: end == cutoff must NOT seal -------------------


def test_a_cycle_ending_exactly_on_the_lag_cutoff_is_not_sealed(handler, monkeypatch):
    # cycle_start 2026-08-06, today 2026-08-15 -> lag cutoff = today-10 = 2026-08-05. The one
    # completed cycle [2026-07-07, 2026-08-05] ends EXACTLY on the cutoff. The seal test is a
    # strict `<`, so end==cutoff stays LIVE (recomputed each read), nothing sealed. Fail-on-
    # revert: relaxing `<` to `<=` would seal it here and populate settle_calls.
    _pin_window(handler, monkeypatch, "2026-08-06", "2026-08-15")
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-07-07")})
    result = handler.list_budgets(budget_repo, FakeTransactionRepo(), FakePayCycleRepo(),
                                  FakeCategoryRepo([_spend_cat()]))

    assert result["sink"]["carryover"] == Decimal(100)   # live leftover, shown
    assert budget_repo.settle_calls == []                # end == cutoff -> NOT sealed


def test_a_cycle_ending_one_day_before_the_cutoff_seals(handler, monkeypatch):
    # The other side of the same boundary: today 2026-08-16 -> cutoff 2026-08-06, so the same
    # cycle (ends 2026-08-05) is now strictly before the cutoff and DOES seal, advancing the
    # anchor to the next cycle start (2026-08-06). Pins that the boundary is exactly one day wide.
    _pin_window(handler, monkeypatch, "2026-08-06", "2026-08-16")
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-07-07")})
    result = handler.list_budgets(budget_repo, FakeTransactionRepo(), FakePayCycleRepo(),
                                  FakeCategoryRepo([_spend_cat()]))

    assert result["sink"]["carryover"] == Decimal(100)
    assert budget_repo.settle_calls == [("sink", Decimal(100), "2026-08-06", LENGTH, PAYDATE)]


# --- SUBTREE sealing: a parent's sealed leftover folds its children -----------


def test_a_parents_sealed_leftover_folds_child_spend_across_the_subtree(handler, monkeypatch):
    # A budgeted PARENT (food, target 100) with rollover; a child (dining) carries no target of
    # its own. In a SEALED past cycle the child spent 30. The sealed leftover must be 100-30=70,
    # not 100 — _seal_rollover has to fold the whole subtree per cycle, exactly as the current
    # window does. Fail-on-revert: sealing on {parent} only would read 100 sealed / carryover 200.
    _pin_window(handler, monkeypatch, "2026-08-06", "2026-08-10")   # cutoff 2026-07-31
    budget_repo = FakeBudgetRepo({"food": _entry(100, carryover=Decimal(0), carryover_from="2026-06-07")})
    cats = FakeCategoryRepo([_spend_cat("food"), _spend_cat("dining", parent="food")])
    # dining spend lands in the sealed cycle [2026-06-07, 2026-07-06]; the live cycle is empty.
    txns = FakeTransactionRepo([_txn("dining", -30, "2026-06-20")])
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), cats)

    assert result["food"]["carryover"] == Decimal(170)   # sealed 70 + live 100
    assert budget_repo.settle_calls == [("food", Decimal(70), "2026-07-07", LENGTH, PAYDATE)]
    # The past child spend is NOT in the current cycle, so the bar shows 0 spent this cycle.
    assert result["food"]["posted"] == Decimal(0)


# --- refund in a sealed cycle: per-cycle spend floors at 0 -------------------


def test_a_refund_in_a_sealed_cycle_cannot_push_leftover_above_target(handler, monkeypatch):
    # A net refund in a past cycle drives that cycle's spend negative, but fold_subtree clamps
    # per-cycle spend at >= 0, so the sealed leftover caps at the target (100), never 150. Pins
    # the aggregate-then-clamp rule for sealing. (A user-visible surprise — see the critique.)
    _pin_window(handler, monkeypatch, "2026-08-06", "2026-08-10")   # cutoff 2026-07-31
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-06-07")})
    # +50 amount with the default spend sign is a refund (negative contribution) in the sealed cycle.
    txns = FakeTransactionRepo([_txn("sink", 50, "2026-06-20")])
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), FakeCategoryRepo([_spend_cat()]))

    assert result["sink"]["carryover"] == Decimal(200)   # sealed 100 (capped) + live 100, NOT 250
    assert budget_repo.settle_calls == [("sink", Decimal(100), "2026-07-07", LENGTH, PAYDATE)]


# --- current-cycle slice boundary: a txn dated exactly cycle_start is current -


def test_a_transaction_dated_exactly_on_cycle_start_is_current_not_sealed(handler, monkeypatch):
    # A spend dated EXACTLY on cycle_start (2026-08-06) must count as this cycle's posted spend,
    # never leak back into the just-completed cycle [2026-07-07, 2026-08-05]. The completed
    # windows are end-inclusive to 08-05, and the current slice is [cycle_start, today]. Fail-on-
    # revert: an off-by-one that bucketed 08-06 into the live cycle would drop posted to 0 and
    # shrink that cycle's leftover.
    _pin_window(handler, monkeypatch, "2026-08-06", "2026-08-10")   # cutoff 2026-07-31
    budget_repo = FakeBudgetRepo({"sink": _entry(100, carryover=Decimal(0), carryover_from="2026-06-07")})
    # A spend in a PAST sealed cycle (25) + a spend dated exactly cycle_start (40). Only the
    # cycle_start one is this cycle's posted spend; the past one belongs to the sealed cycle,
    # so it must NOT inflate `posted`. Without the current-cycle slice, posted would read 65.
    txns = FakeTransactionRepo([
        _txn("sink", -25, "2026-06-20"),   # sealed cycle [2026-06-07, 2026-07-06]
        _txn("sink", -40, "2026-08-06"),   # exactly cycle_start -> current
    ])
    result = handler.list_budgets(budget_repo, txns, FakePayCycleRepo(), FakeCategoryRepo([_spend_cat()]))

    assert result["sink"]["posted"] == Decimal(40)       # ONLY the cycle_start spend, not the past 25
    # sealed cycle leftover 100-25=75, live cycle empty +100 -> carryover 175.
    assert result["sink"]["carryover"] == Decimal(175)
    assert budget_repo.settle_calls == [("sink", Decimal(75), "2026-07-07", LENGTH, PAYDATE)]


# --- PUT /budgets rollover: anchor + validation gaps -------------------------


def _put_budget_event(category="coffee", body=None):
    return {
        "rawPath": f"/budgets/{category}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"category": category},
        "body": body if body is not None else '{"target": 60}',
        "isBase64Encoded": False,
    }


def test_turning_rollover_on_for_an_existing_budget_re_anchors_to_the_current_cycle(handler, monkeypatch):
    # OFF -> ON must (re)start accumulation at the current cycle: set_budget receives an anchor
    # carrying the CURRENT cycle_start + the live pay-cycle length/payday. Fail-on-revert:
    # dropping the anchor build leaves anchor=None and the buffer would seal the off-period.
    _pin_window(handler, monkeypatch, "2026-08-06", "2026-08-10")
    repo = FakeBudgetRepo({"coffee": {"target": Decimal(50)}})   # exists, rollover OFF/unset
    resp = handler.set_budget(_put_budget_event(body='{"target": 60, "rollover": true}'),
                              repo, FakeCategoryRepo([_spend_cat("coffee")]), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo.set_kwargs["rollover"] is True
    assert repo.set_kwargs["anchor"] == {
        "carryover_from": "2026-08-06", "carryover_len": Decimal(LENGTH), "carryover_paydate": PAYDATE,
    }


def test_an_amount_edit_while_rollover_already_on_does_not_re_anchor(handler, monkeypatch):
    # An amount edit that re-sends rollover:true while it is ALREADY on must NOT carry an anchor
    # (re-anchoring would drop a not-yet-sealed cycle). Fail-on-revert: if the OFF->ON guard were
    # removed, every amount edit would re-anchor and silently reset the settle window.
    _pin_window(handler, monkeypatch, "2026-08-06", "2026-08-10")
    repo = FakeBudgetRepo({"coffee": {"target": Decimal(50), "rollover": True}})
    resp = handler.set_budget(_put_budget_event(body='{"target": 75, "rollover": true}'),
                              repo, FakeCategoryRepo([_spend_cat("coffee")]), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo.set_kwargs["rollover"] is True
    assert repo.set_kwargs["anchor"] is None


def test_rollover_true_on_an_income_category_is_rejected_400(handler):
    # Rollover is spend-only: rollover:true on an Income earn-target is a 400 and is never written.
    repo = FakeBudgetRepo({})
    resp = handler.set_budget(_put_budget_event(body='{"target": 60, "rollover": true}'),
                              repo, FakeCategoryRepo([_spend_cat("coffee", bucket="Income")]), FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert "spend" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


def test_a_non_boolean_rollover_is_rejected_before_any_taxonomy_read(handler):
    # rollover must be a real bool — a truthy string like "yes" must 400, not be stored as-is.
    # The type check runs before the bucket read, so the taxonomy is never fetched.
    repo = FakeBudgetRepo({})
    cats = FakeCategoryRepo([_spend_cat("coffee")])
    resp = handler.set_budget(_put_budget_event(body='{"target": 60, "rollover": "yes"}'),
                              repo, cats, FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_explicit_rollover_false_is_forwarded_and_freezes_without_an_anchor(handler):
    # Turning rollover OFF forwards rollover=False (freezing the stored buffer) and never builds
    # an anchor. Fail-on-revert: if false were omitted instead of forwarded, the stored flag
    # wouldn't flip off.
    repo = FakeBudgetRepo({"coffee": {"target": Decimal(50), "rollover": True, "carryover": Decimal(40)}})
    resp = handler.set_budget(_put_budget_event(body='{"target": 50, "rollover": false}'),
                              repo, FakeCategoryRepo([_spend_cat("coffee")]), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo.set_kwargs["rollover"] is False
    assert repo.set_kwargs["anchor"] is None
