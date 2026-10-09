"""WHIT-559 PR2a — adversarial gaps on the "Apply my rules" auto-spreading (sweep + async worker).

Independent of the impl suite (test_apply_rules_spread.py, which covers seed+mark / many-once /
non-spread-zero). Here: the cross-run idempotency the store-row `spread_seeded` flag guarantees,
the async worker route (impl tested only the sync route), the seed firing even when the write
no-ops, and the None-create retry.

Runs the real TransactionRepository and RuleRepository over one FakeTable; local
FakeBudget/FakePaycycle record the seed and the real JobRepository (_job_fakes) drives the worker
(as test_apply_rules_worker.py does)."""

import json
from decimal import Decimal
from functools import partial

from _budget_endpoint_fakes import _FakePayCycleRepo
from _feed_fakes import apply_rules_event, SPENDING, FakeCategoryRepo, real_repos, _row, stored
from _job_fakes import real_job_repo


def _spread_rule(value="ORIGIN", category_id="insurance"):
    # The kwargs of one real RuleRepository.create_rule call.
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id, "spread": True,
            "spread_amount": Decimal("42.50"), "spread_gap_days": 30}


def _seed_marks(table):
    """How many times the store's spread_seeded marker was written."""
    return len([names for _, names, _ in table.update_calls if "spread_seeded" in names.values()])


def _seeded(rule_repo):
    """The one stored rule's spread_seeded marker."""
    [rule] = rule_repo.list_rules()
    return rule["spread_seeded"]


class FakeBudget:
    def __init__(self, result={"id": "x"}):
        self._result = result
        self.calls = []

    def set_spread_if_absent(self, *args):
        self.calls.append(args)
        return self._result


FakePaycycle = partial(_FakePayCycleRepo, length=14, last_pay_date="2026-01-07")


def _origin(txn_id, date="2026-07-01"):
    return _row(SPENDING, date, txn_id, description="ORIGIN ENERGY BILL")


def _sweep(handler, repo, rule_repo, *, budget=None, paycycle=None,
           categories=frozenset({"insurance", "coffee"})):
    resp = handler.apply_rules_to_uncategorized(
        apply_rules_event({"dryRun": False}), repo, FakeCategoryRepo(categories), rule_repo,
        budget or FakeBudget(), paycycle or FakePaycycle())
    return resp


# --- cross-path / cross-run idempotency (the core guarantee — neither impl suite tests it) -------


def test_two_sweeps_over_the_same_store_seed_once(handler):
    # [A21] Cross-RUN: the first sweep seeds + marks the store row; the second sweep (same rule
    # store, a new unfiled charge) reads the persisted flag and skips. Proves mark_spread_seeded
    # round-trips through the store, not just an in-memory per-run set.
    table, repo, rule_repo = real_repos({SPENDING: [_origin("t1")]}, rules=[_spread_rule()])
    b1, p1 = FakeBudget(), FakePaycycle()
    _sweep(handler, repo, rule_repo, budget=b1, paycycle=p1)
    assert len(b1.calls) == 1 and _seeded(rule_repo) is True and _seed_marks(table) == 1

    table.seed(_origin("t2"))
    b2, p2 = FakeBudget(), FakePaycycle()
    _sweep(handler, repo, rule_repo, budget=b2, paycycle=p2)
    assert b2.calls == [] and p2.get_calls == 0             # second run does not re-seed


# --- the seed fires even when the charge write no-ops (the plan is about the bill) ----------------

def test_the_seed_fires_even_when_the_charge_write_no_ops(handler):
    # [A22] A charge the user already filed since the scan: the SCAN reports it unfiled (so it plans
    # as a match), but the store holds a real category, so the conditional write no-ops
    # (already_filed). The spread seed is about the BILL, not this charge, so it must still fire once.
    filed_row = _row(SPENDING, "2026-07-01", "t1", description="ORIGIN ENERGY BILL",
                     category="coffee")                                       # store: already filed
    table, repo, rule_repo = real_repos({SPENDING: [filed_row]}, rules=[_spread_rule()])
    table.stale_index(filed_row, category=None)                               # scan: looks unfiled
    budget = FakeBudget()
    resp = _sweep(handler, repo, rule_repo, budget=budget)
    body = json.loads(resp["body"])
    assert body["filed"] == [] and body["alreadyFiled"] == ["t1"]             # the write no-oped
    assert len(budget.calls) == 1 and _seeded(rule_repo) is True   # ...but the bill seeded
    assert stored(table, "t1")["category"] == "coffee"                        # tap untouched


# --- a None create (user already has a plan) leaves the rule unseeded so a later run retries -------

def test_a_none_create_stays_unseeded_and_a_later_run_retries(handler):
    # [A23] set_spread_if_absent returns None (the category already has a USER spread / no target yet)
    # -> the user's plan is never clobbered and the rule is NOT marked, so once the plan is gone / a
    # target appears a later sweep seeds it. Proves the retry semantics, not just "not marked once".
    table, repo, rule_repo = real_repos({SPENDING: [_origin("t1")]}, rules=[_spread_rule()])
    blocked = FakeBudget(result=None)
    _sweep(handler, repo, rule_repo, budget=blocked)
    # Attempted, not marked.
    assert blocked.calls and _seeded(rule_repo) is False and _seed_marks(table) == 0

    table.seed(_origin("t2"))
    ok = FakeBudget(result={"id": "insurance"})
    _sweep(handler, repo, rule_repo, budget=ok)
    assert len(ok.calls) == 1 and _seeded(rule_repo) is True   # the retry seeds + marks


# --- the async worker route (impl suite tested only the sync route) -------------------------------

def _wire_worker(worker, monkeypatch, *, transactions, rules, budget, paycycle,
                 categories=frozenset({"insurance", "coffee"})):
    table, txn_repo, rule_repo = real_repos(transactions, rules=rules)
    job_repo = real_job_repo()
    job_repo.create_job("job1")
    monkeypatch.setattr(worker, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(worker, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(worker, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(worker, "JobRepository", lambda: job_repo)
    monkeypatch.setattr(worker, "BudgetRepository", lambda: budget)
    monkeypatch.setattr(worker, "PayCycleRepository", lambda: paycycle)
    return table, rule_repo, job_repo


def test_worker_seeds_a_spread_rules_plan_once_and_marks_it(apply_rules_worker, monkeypatch):
    # [A27] The async (uncapped) worker builds its own SpreadSeeder + spread map. Three matching
    # charges -> one plan seeded, one pay-cycle read, rule marked. FAIL-ON-REVERT: drop the worker's
    # spread_seeder/rule_spread_by_id kwargs and budget.calls goes to zero.
    worker = apply_rules_worker
    budget, paycycle = FakeBudget(), FakePaycycle()
    rows = [_origin("t1", "2026-07-01"), _origin("t2", "2026-07-02"), _origin("t3", "2026-07-03")]
    table, rule_repo, job_repo = _wire_worker(
        worker, monkeypatch, transactions={SPENDING: rows}, rules=[_spread_rule()],
        budget=budget, paycycle=paycycle)

    result = worker.lambda_handler({"jobId": "job1"})

    assert result["status"] == "succeeded"
    assert len(budget.calls) == 1 and paycycle.get_calls == 1
    assert _seeded(rule_repo) is True and _seed_marks(table) == 1
    assert job_repo.get_job("job1")["filed"] == 3
