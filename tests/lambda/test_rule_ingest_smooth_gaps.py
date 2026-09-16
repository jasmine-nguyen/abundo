"""WHIT-559 PR2a — adversarial gaps on the WEBHOOK-side auto-smoothing (lambda/rule_ingest.py).

Independent of the impl suite (test_rule_ingest_smooth.py, which covers seed+mark / two-charges-once
/ no-op-not-marked / non-smooth-zero / already-seeded / reprocess-no-smooth). Here: cross-DELIVERY
idempotency (the store-row smooth_seeded flag survives across two deliveries, each with its OWN
SmoothSeeder), a multi-condition (WHIT-541) smooth rule, a smooth rule matching nothing, and a
budget_excluded (non-smooth) regression with the smooth wiring live. Local fakes per the webhook-suite
convention, like test_rule_ingest_smooth.py."""

from decimal import Decimal

import pytest


class FakeRuleStore:
    def __init__(self, rules=()):
        self._rules = [dict(r) for r in rules]
        self.marked = []

    def list_rules(self):
        return [dict(r) for r in self._rules]

    def mark_smoothed(self, rule_id):
        self.marked.append(rule_id)
        for row in self._rules:
            if row["id"] == rule_id:
                row["smooth_seeded"] = True


class FakeCategoryRepo:
    def __init__(self, ids):
        self._ids = list(ids)

    def list_categories(self):
        return [{"id": i} for i in self._ids]


class FakeBudget:
    def __init__(self, result={"id": "x"}):
        self._result = result
        self.calls = []

    def set_spread_if_absent(self, *args):
        self.calls.append(args)
        return self._result


class FakePaycycle:
    def __init__(self):
        self.reads = 0

    def get_paycycle(self):
        self.reads += 1
        return {"length": 14, "last_pay_date": "2026-01-07"}


def _charge(txn_id, description="ORIGIN ENERGY BILL", **extra):
    return {"transaction_id": txn_id, "account_id": "up-spending",
            "description": description, "category": None, "counts_to_budget": True, **extra}


def _smooth_rule(**over):
    return {"id": "r-origin", "field": "description", "operator": "contains", "value": "ORIGIN",
            "category_id": "insurance", "smooth": True, "smooth_seeded": False,
            "smooth_amount": Decimal("42.50"), "smooth_gap_days": 30, **over}


def _apply(lam, store, charges, *, categories=("insurance",)):
    budget, paycycle = FakeBudget(), FakePaycycle()
    lam.rule_ingest.apply(charges, rule_repo=store, category_repo=FakeCategoryRepo(list(categories)),
                          budget_repo=budget, paycycle_repo=paycycle)
    return budget, paycycle


def test_two_deliveries_over_the_same_store_seed_once(lam):
    # [A10] Cross-DELIVERY idempotency: delivery 1 seeds + marks the store row; delivery 2 (a fresh
    # SmoothSeeder — the per-run dedup set does NOT carry over) reads the persisted smooth_seeded and
    # skips. This is the guarantee that makes the webhook and the sweep never double-seed: it lives in
    # the store row, not the in-memory run. FAIL-ON-REVERT: stop reading smoothSeeded in _to_engine_rule
    # (or stop mark_smoothed flipping it) and delivery 2 re-seeds.
    store = FakeRuleStore([_smooth_rule()])
    b1, _ = _apply(lam, store, [_charge("t1")])
    assert len(b1.calls) == 1 and store.marked == ["r-origin"]

    b2, p2 = _apply(lam, store, [_charge("t2")])
    assert b2.calls == [] and p2.reads == 0            # delivery 2 does not re-seed


def test_a_multi_condition_smooth_rule_still_seeds(lam):
    # [A11] A WHIT-541 multi-condition smooth rule carries smooth through _to_engine_rule, so a charge
    # matching every condition still auto-seeds the plan.
    conditions = [{"field": "description", "operator": "contains", "value": "ORIGIN"},
                  {"field": "amount", "operator": "less_than", "value": "100"}]
    rule = _smooth_rule(conditions=conditions, logic="all")
    store = FakeRuleStore([rule])
    charge = _charge("t1", amount=Decimal("-42.50"))
    budget, _ = _apply(lam, store, [charge])
    assert charge["category"] == "insurance"
    assert len(budget.calls) == 1 and store.marked == ["r-origin"]


def test_a_smooth_rule_matching_nothing_reads_no_paycycle(lam):
    # [A12] No matching charge -> the seeder is never invoked -> zero pay-cycle read, zero budget write.
    store = FakeRuleStore([_smooth_rule(value="NOMATCH")])
    charge = _charge("t1")
    budget, paycycle = _apply(lam, store, [charge])
    assert charge["category"] is None
    assert budget.calls == [] and paycycle.reads == 0 and store.marked == []


def test_a_budget_excluded_non_smooth_rule_still_files_and_excludes(lam):
    # [A13] Regression: with the smooth wiring present, a plain budget_excluded rule still files the
    # charge, sets budget_excluded, and touches no budget/paycycle repo.
    store = FakeRuleStore([_smooth_rule(smooth=False, budget_excluded=True)])
    charge = _charge("t1")
    budget, paycycle = _apply(lam, store, [charge])
    assert charge["category"] == "insurance" and charge["budget_excluded"] is True
    assert budget.calls == [] and paycycle.reads == 0 and store.marked == []
