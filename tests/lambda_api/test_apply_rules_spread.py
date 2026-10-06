"""WHIT-559: the "Apply my rules" sweep auto-spreads a bill when the winning rule is a spread one —
creating the category's spread plan ONCE across the whole run, create-only so a user's plan is never
clobbered. Runs the real TransactionRepository and RuleRepository over one FakeTable; a fake
budget + pay-cycle repo record the seed."""

import json
from decimal import Decimal
from functools import partial

from _budget_endpoint_fakes import _FakePayCycleRepo
from _feed_fakes import SPENDING, FakeCategoryRepo, real_repos, _row


def _spread_rule(value="ORIGIN", category_id="insurance", *, spread=True):
    # The kwargs of one real RuleRepository.create_rule call.
    rule = {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id, "spread": spread}
    if spread:
        rule.update(spread_amount=Decimal("42.50"), spread_gap_days=30)
    return rule


def _seed_marks(table):
    """How many times the store's spread_seeded marker was written."""
    return len([names for _, names, _ in table.update_calls if "spread_seeded" in names.values()])


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


FakePaycycle = partial(_FakePayCycleRepo, length=14, last_pay_date="2026-01-07")


def _call(handler, rows, rules, *, budget=None, paycycle=None, already_seeded=False,
          categories=frozenset({"insurance", "coffee"})):
    """Run the sweep; returns (table, the stored rule after the run)."""
    table, repo, rule_repo = real_repos({SPENDING: rows}, rules=rules)
    [rule] = rule_repo.list_rules()
    if already_seeded:
        rule_repo.mark_spread_seeded(rule["id"])
    handler.apply_rules_to_uncategorized(
        _event({"dryRun": False}), repo, FakeCategoryRepo(categories), rule_repo,
        budget or FakeBudget(), paycycle or FakePaycycle())
    return table, rule_repo.get_rule(rule["id"])


def _origin(txn_id, date="2026-07-01"):
    return _row(SPENDING, date, txn_id, description="ORIGIN ENERGY BILL")


def test_sweep_seeds_a_spread_rules_plan_and_marks_it(handler):
    budget = FakeBudget()
    table, rule = _call(handler, [_origin("t1")], [_spread_rule()], budget=budget)

    assert len(budget.calls) == 1
    cat, amount, cycles, _from, length, _paydate = budget.calls[0]
    assert (cat, amount, cycles, length) == ("insurance", Decimal("42.50"), 2, 14)
    assert rule["spread_seeded"] is True and _seed_marks(table) == 1


def test_a_spread_rule_matching_many_charges_seeds_once(handler):
    # FAIL-ON-REVERT for the per-run dedup: three matching charges, one seed.
    budget, paycycle = FakeBudget(), FakePaycycle()
    _call(handler, [_origin("t1", "2026-07-01"), _origin("t2", "2026-07-02"),
                    _origin("t3", "2026-07-03")],
          [_spread_rule()], budget=budget, paycycle=paycycle)
    assert len(budget.calls) == 1 and paycycle.get_calls == 1


def test_a_no_op_create_does_not_mark_the_rule(handler):
    # set_spread_if_absent returns None (category already has a spread / no target) -> stay unseeded.
    budget = FakeBudget(result=None)
    table, rule = _call(handler, [_origin("t1")], [_spread_rule()], budget=budget)
    assert budget.calls and rule["spread_seeded"] is False and _seed_marks(table) == 0


def test_a_non_spread_rule_never_touches_budget(handler):
    budget, paycycle = FakeBudget(), FakePaycycle()
    _call(handler, [_origin("t1")], [_spread_rule(spread=False)], budget=budget, paycycle=paycycle)
    assert budget.calls == [] and paycycle.get_calls == 0


def test_an_already_seeded_rule_does_not_reseed(handler):
    budget, paycycle = FakeBudget(), FakePaycycle()
    _call(handler, [_origin("t1")], [_spread_rule()], budget=budget, paycycle=paycycle,
          already_seeded=True)
    assert budget.calls == [] and paycycle.get_calls == 0
