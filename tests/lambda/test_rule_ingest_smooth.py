"""Webhook-side auto-smoothing (WHIT-559): a `smooth` rule filing a matching incoming charge
creates its category's bill-spread plan once. Local fakes per the webhook-suite convention
(test_budget_alerts.py) — FakeRuleStore is snake_case and gains mark_smoothed; a fake budget +
pay-cycle repo record the seed."""

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


def _charge(txn_id, description="ORIGIN ENERGY BILL"):
    return {"transaction_id": txn_id, "account_id": "up-spending",
            "description": description, "category": None, "counts_to_budget": True}


def _smooth_rule(**over):
    return {"id": "r-origin", "field": "description", "operator": "contains", "value": "ORIGIN",
            "category_id": "insurance", "smooth": True, "smooth_seeded": False,
            "smooth_amount": Decimal("42.50"), "smooth_gap_days": 30, **over}


def _apply(lam, store, charges, *, smoothing=True):
    budget, paycycle = FakeBudget(), FakePaycycle()
    kwargs = {"rule_repo": store, "category_repo": FakeCategoryRepo(["insurance"])}
    if smoothing:
        kwargs.update(budget_repo=budget, paycycle_repo=paycycle)
    lam.rule_ingest.apply(charges, **kwargs)
    return budget, paycycle


def test_a_smooth_rule_seeds_the_plan_and_marks_it(lam):
    store = FakeRuleStore([_smooth_rule()])
    charge = _charge("t1")
    budget, _ = _apply(lam, store, [charge])

    assert charge["category"] == "insurance" and charge["filed_by_rule"] == "r-origin"
    assert len(budget.calls) == 1
    cat, amount, cycles, _from, length, _paydate = budget.calls[0]
    assert (cat, amount, cycles, length) == ("insurance", Decimal("42.50"), 2, 14)
    assert store.marked == ["r-origin"]


def test_two_matching_charges_seed_the_plan_once(lam):
    store = FakeRuleStore([_smooth_rule()])
    budget, paycycle = _apply(lam, store, [_charge("t1"), _charge("t2")])
    assert len(budget.calls) == 1 and paycycle.reads == 1 and store.marked == ["r-origin"]


def test_a_no_op_create_does_not_mark_the_rule(lam):
    store = FakeRuleStore([_smooth_rule()])
    budget, _ = _apply(lam, store, [_charge("t1")])
    budget.calls.clear()

    # A category that already has a spread / no target -> set_spread_if_absent returns None.
    store2 = FakeRuleStore([_smooth_rule()])
    b2 = FakeBudget(result=None)
    lam.rule_ingest.apply([_charge("t1")], rule_repo=store2,
                          category_repo=FakeCategoryRepo(["insurance"]),
                          budget_repo=b2, paycycle_repo=FakePaycycle())
    assert b2.calls and store2.marked == []


def test_a_non_smooth_rule_never_touches_budget_or_paycycle(lam):
    store = FakeRuleStore([_smooth_rule(smooth=False)])
    budget, paycycle = _apply(lam, store, [_charge("t1")])
    assert budget.calls == [] and paycycle.reads == 0 and store.marked == []


def test_an_already_seeded_rule_does_not_reseed(lam):
    store = FakeRuleStore([_smooth_rule(smooth_seeded=True)])
    budget, paycycle = _apply(lam, store, [_charge("t1")])
    assert budget.calls == [] and paycycle.reads == 0


def test_reprocess_path_without_repos_files_but_does_not_smooth(lam):
    # apply() without budget/paycycle repos (the reprocess re-drive) files the charge but skips
    # smoothing entirely — the live webhook/sweep seeds it later.
    store = FakeRuleStore([_smooth_rule()])
    charge = _charge("t1")
    _apply(lam, store, [charge], smoothing=False)
    assert charge["category"] == "insurance" and store.marked == []
