"""Unit tests for SpreadSeeder (shared/rule_spreading.py) — the shared "seed one bill-spread plan"
side-effect the webhook and the sweep both use (WHIT-559). Driven with tiny fakes so the gate,
the once-per-run dedup, the lazy pay-cycle read, and the best-effort swallow are exercised directly."""

from decimal import Decimal

import pytest


class _FakeBudget:
    def __init__(self, result=None, raises=None):
        self._result = result
        self._raises = raises
        self.calls = []

    def set_spread_if_absent(self, cat_id, amount, cycles, spread_from, length, paydate):
        self.calls.append((cat_id, amount, cycles, spread_from, length, paydate))
        if self._raises is not None:
            raise self._raises
        return self._result


class _FakePaycycle:
    def __init__(self):
        self.reads = 0

    def get_paycycle(self):
        self.reads += 1
        return {"length": 14, "last_pay_date": "2026-01-07"}


class _FakeRule:
    def __init__(self):
        self.marked = []

    def mark_spread_seeded(self, rule_id):
        self.marked.append(rule_id)


def _rule(**over):
    return {"id": "r1", "categoryId": "insurance", "spread": True, "spreadSeeded": False,
            "spreadAmount": Decimal("42.50"), "spreadGapDays": 30, **over}


def _seeder(shared, budget, paycycle, rule):
    return shared.rule_spreading.SpreadSeeder(budget, paycycle, rule)


def test_seeds_a_spread_unseeded_rule_and_marks_it(shared):
    budget = _FakeBudget(result={"id": "insurance"})
    paycycle, rule_repo = _FakePaycycle(), _FakeRule()
    _seeder(shared, budget, paycycle, rule_repo).seed(_rule())

    expected_start, _ = shared.spend.current_cycle_window("2026-01-07", 14)
    assert budget.calls == [
        ("insurance", Decimal("42.50"), 2, expected_start, 14, "2026-01-07")]
    assert rule_repo.marked == ["r1"]   # cycles = cadence_cycles(30, 14) = 2


def test_a_non_spread_rule_reads_nothing(shared):
    budget, paycycle, rule_repo = _FakeBudget(), _FakePaycycle(), _FakeRule()
    _seeder(shared, budget, paycycle, rule_repo).seed(_rule(spread=False))
    assert budget.calls == [] and rule_repo.marked == [] and paycycle.reads == 0


def test_an_already_seeded_rule_is_skipped(shared):
    budget, paycycle, rule_repo = _FakeBudget(result={"id": "x"}), _FakePaycycle(), _FakeRule()
    _seeder(shared, budget, paycycle, rule_repo).seed(_rule(spreadSeeded=True))
    assert budget.calls == [] and paycycle.reads == 0


def test_seeding_the_same_rule_twice_creates_one_plan(shared):
    # Per-run dedup + one lazy pay-cycle read, so a rule matching many charges seeds once.
    budget = _FakeBudget(result={"id": "x"})
    paycycle, rule_repo = _FakePaycycle(), _FakeRule()
    seeder = _seeder(shared, budget, paycycle, rule_repo)
    seeder.seed(_rule())
    seeder.seed(_rule())
    assert len(budget.calls) == 1 and paycycle.reads == 1 and rule_repo.marked == ["r1"]


def test_a_no_op_create_does_not_mark_seeded(shared):
    # set_spread_if_absent returns None (no target / a spread already exists) -> the rule stays
    # unseeded so it can seed later (e.g. once the user sets a target). FAIL-ON-REVERT: mark
    # unconditionally and this reddens.
    budget = _FakeBudget(result=None)
    rule_repo = _FakeRule()
    _seeder(shared, budget, _FakePaycycle(), rule_repo).seed(_rule())
    assert budget.calls and rule_repo.marked == []


def test_a_write_failure_is_swallowed_not_raised(shared):
    # Best-effort: a budget-write fault must never break the charge filing that triggered it.
    budget = _FakeBudget(raises=RuntimeError("dynamo down"))
    rule_repo = _FakeRule()
    _seeder(shared, budget, _FakePaycycle(), rule_repo).seed(_rule())   # no raise
    assert rule_repo.marked == []


def test_seed_ignores_a_none_rule(shared):
    budget, paycycle, rule_repo = _FakeBudget(), _FakePaycycle(), _FakeRule()
    _seeder(shared, budget, paycycle, rule_repo).seed(None)
    assert budget.calls == [] and paycycle.reads == 0
