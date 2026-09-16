"""WHIT-559: the "Apply my rules" sweep auto-smooths a bill when the winning rule is a smooth one —
creating the category's spread plan ONCE across the whole run, create-only so a user's plan is never
clobbered. Reuses WritableFeedRepo + FakeRuleRepo like test_apply_rules_budget_excluded.py; a fake
budget + pay-cycle repo record the seed."""

import json
from decimal import Decimal

from _feed_fakes import SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _smooth_rule(value="ORIGIN", category_id="insurance", *, rule_id="r1", smooth=True,
                 smooth_seeded=False):
    row = {"id": rule_id, "field": "description", "operator": "contains", "value": value,
           "category_id": category_id, "smooth": smooth, "smooth_seeded": smooth_seeded}
    if smooth:
        row.update(smooth_amount=Decimal("42.50"), smooth_gap_days=30)
    return row


def _event(body):
    return {"rawPath": "/transactions/uncategorized/apply-rules",
            "requestContext": {"http": {"method": "POST"}}, "body": json.dumps(body)}


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


def _call(handler, repo, rules, *, budget=None, paycycle=None,
          categories=frozenset({"insurance", "coffee"})):
    rule_repo = FakeRuleRepo(rules=rules)
    resp = handler.apply_rules_to_uncategorized(
        _event({"dryRun": False}), repo, FakeCategoryRepo(categories), rule_repo,
        budget or FakeBudget(), paycycle or FakePaycycle())
    return resp, rule_repo


def _origin(txn_id, date="2026-07-01"):
    return _row(SPENDING, date, txn_id, description="ORIGIN ENERGY BILL", category=None)


def test_sweep_seeds_a_smooth_rules_plan_and_marks_it(handler):
    repo = WritableFeedRepo({SPENDING: [_origin("t1")]})
    budget = FakeBudget()
    _, rule_repo = _call(handler, repo, [_smooth_rule()], budget=budget)

    assert len(budget.calls) == 1
    cat, amount, cycles, _from, length, _paydate = budget.calls[0]
    assert (cat, amount, cycles, length) == ("insurance", Decimal("42.50"), 2, 14)
    assert rule_repo.smoothed == ["r1"]


def test_a_smooth_rule_matching_many_charges_seeds_once(handler):
    # FAIL-ON-REVERT for the per-run dedup: three matching charges, one seed.
    repo = WritableFeedRepo({SPENDING: [
        _origin("t1", "2026-07-01"), _origin("t2", "2026-07-02"), _origin("t3", "2026-07-03")]})
    budget, paycycle = FakeBudget(), FakePaycycle()
    _call(handler, repo, [_smooth_rule()], budget=budget, paycycle=paycycle)
    assert len(budget.calls) == 1 and paycycle.reads == 1


def test_a_no_op_create_does_not_mark_the_rule(handler):
    # set_spread_if_absent returns None (category already has a spread / no target) -> stay unseeded.
    repo = WritableFeedRepo({SPENDING: [_origin("t1")]})
    budget = FakeBudget(result=None)
    _, rule_repo = _call(handler, repo, [_smooth_rule()], budget=budget)
    assert budget.calls and rule_repo.smoothed == []


def test_a_non_smooth_rule_never_touches_budget(handler):
    repo = WritableFeedRepo({SPENDING: [_origin("t1")]})
    budget, paycycle = FakeBudget(), FakePaycycle()
    _call(handler, repo, [_smooth_rule(smooth=False)], budget=budget, paycycle=paycycle)
    assert budget.calls == [] and paycycle.reads == 0


def test_an_already_seeded_rule_does_not_reseed(handler):
    repo = WritableFeedRepo({SPENDING: [_origin("t1")]})
    budget, paycycle = FakeBudget(), FakePaycycle()
    _call(handler, repo, [_smooth_rule(smooth_seeded=True)], budget=budget, paycycle=paycycle)
    assert budget.calls == [] and paycycle.reads == 0
