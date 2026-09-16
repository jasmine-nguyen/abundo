"""WHIT-559 PR2a — adversarial gaps on the "Apply my rules" auto-smoothing (sweep + async worker).

Independent of the impl suite (test_apply_rules_smooth.py, which covers seed+mark / many-once /
no-op-not-marked / non-smooth-zero / already-seeded). Here: the cross-path/cross-run idempotency
the store-row `smooth_seeded` flag guarantees, the async worker route (impl tested only the sync
route), the seed firing even when the write no-ops, the None-create retry, a multi-condition smooth
rule, a smooth rule matching nothing, and a budget_excluded regression with the smooth wiring live.

Reuses WritableFeedRepo + FakeRuleRepo like test_apply_rules_smooth.py; local FakeBudget/FakePaycycle
record the seed and a local FakeJobRepo drives the worker (as test_apply_rules_worker.py does)."""

import json
from decimal import Decimal

from _feed_fakes import SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _smooth_rule(value="ORIGIN", category_id="insurance", *, rule_id="r1", smooth=True,
                 smooth_seeded=False, budget_excluded=False):
    row = {"id": rule_id, "field": "description", "operator": "contains", "value": value,
           "category_id": category_id, "smooth": smooth, "smooth_seeded": smooth_seeded,
           "budget_excluded": budget_excluded}
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


def _origin(txn_id, date="2026-07-01", **extra):
    return _row(SPENDING, date, txn_id, description="ORIGIN ENERGY BILL", category=None, **extra)


def _sweep(handler, repo, rule_repo, *, budget=None, paycycle=None,
           categories=frozenset({"insurance", "coffee"})):
    resp = handler.apply_rules_to_uncategorized(
        _event({"dryRun": False}), repo, FakeCategoryRepo(categories), rule_repo,
        budget or FakeBudget(), paycycle or FakePaycycle())
    return resp


# --- cross-path / cross-run idempotency (the core guarantee — neither impl suite tests it) -------

def test_a_prior_seed_marked_in_the_store_blocks_the_sweep(handler):
    # [A20] The webhook's SmoothSeeder ends by calling rule_repo.mark_smoothed(id) — the SAME store
    # method, on the SAME row, that the sweep reads back through _build_rule_smooth_map. Simulate that
    # prior seed, then run the sweep over a fresh matching charge -> it sees smooth_seeded True and
    # does NOT re-seed. FAIL-ON-REVERT: build the smooth map off the client shape (no smooth_seeded)
    # or hardcode False and the sweep re-seeds every run, double-creating the plan the user dismissed.
    rule_repo = FakeRuleRepo(rules=[_smooth_rule()])
    rule_repo.mark_smoothed("r1")                       # the webhook already seeded on a prior delivery
    budget, paycycle = FakeBudget(), FakePaycycle()
    _sweep(handler, WritableFeedRepo({SPENDING: [_origin("t1")]}), rule_repo,
           budget=budget, paycycle=paycycle)
    assert budget.calls == [] and paycycle.reads == 0
    assert getattr(rule_repo, "smoothed", []) == ["r1"]                 # no second mark


def test_two_sweeps_over_the_same_store_seed_once(handler):
    # [A21] Cross-RUN: the first sweep seeds + marks the store row; the second sweep (same rule_repo,
    # a new unfiled charge) reads the persisted flag and skips. Proves mark_smoothed round-trips
    # through the store, not just an in-memory per-run set.
    rule_repo = FakeRuleRepo(rules=[_smooth_rule()])
    b1, p1 = FakeBudget(), FakePaycycle()
    _sweep(handler, WritableFeedRepo({SPENDING: [_origin("t1")]}), rule_repo, budget=b1, paycycle=p1)
    assert len(b1.calls) == 1 and getattr(rule_repo, "smoothed", []) == ["r1"]

    b2, p2 = FakeBudget(), FakePaycycle()
    _sweep(handler, WritableFeedRepo({SPENDING: [_origin("t2")]}), rule_repo, budget=b2, paycycle=p2)
    assert b2.calls == [] and p2.reads == 0             # second run does not re-seed


# --- the seed fires even when the charge write no-ops (the plan is about the bill) ----------------

def test_the_seed_fires_even_when_the_charge_write_no_ops(handler):
    # [A22] A charge the user already filed since the scan: the SCAN reports it unfiled (so it plans
    # as a match), but the store holds a real category, so the conditional write no-ops
    # (already_filed). The smooth seed is about the BILL, not this charge, so it must still fire once.
    rule_repo = FakeRuleRepo(rules=[_smooth_rule()])
    filed_row = _row(SPENDING, "2026-07-01", "t1", description="ORIGIN ENERGY BILL",
                     category="coffee")                                       # store: already filed
    repo = WritableFeedRepo({SPENDING: [filed_row]})
    repo.scan_shows = {"t1": None}                                            # scan: looks unfiled
    budget = FakeBudget()
    resp = _sweep(handler, repo, rule_repo, budget=budget)
    body = json.loads(resp["body"])
    assert body["filed"] == [] and body["alreadyFiled"] == ["t1"]             # the write no-oped
    assert len(budget.calls) == 1 and getattr(rule_repo, "smoothed", []) == ["r1"]            # ...but the bill seeded
    assert repo._find_row(f"ACCOUNT#{SPENDING}", "TXN#t1")["category"] == "coffee"  # tap untouched


# --- a None create (user already has a plan) leaves the rule unseeded so a later run retries -------

def test_a_none_create_stays_unseeded_and_a_later_run_retries(handler):
    # [A23] set_spread_if_absent returns None (the category already has a USER spread / no target yet)
    # -> the user's plan is never clobbered and the rule is NOT marked, so once the plan is gone / a
    # target appears a later sweep seeds it. Proves the retry semantics, not just "not marked once".
    rule_repo = FakeRuleRepo(rules=[_smooth_rule()])
    blocked = FakeBudget(result=None)
    _sweep(handler, WritableFeedRepo({SPENDING: [_origin("t1")]}), rule_repo, budget=blocked)
    assert blocked.calls and getattr(rule_repo, "smoothed", []) == []           # attempted, not marked

    ok = FakeBudget(result={"id": "insurance"})
    _sweep(handler, WritableFeedRepo({SPENDING: [_origin("t2")]}), rule_repo, budget=ok)
    assert len(ok.calls) == 1 and getattr(rule_repo, "smoothed", []) == ["r1"]  # the retry seeds + marks


# --- a multi-condition (WHIT-541) smooth rule carries smooth through the apply path ---------------

def test_a_multi_condition_smooth_rule_still_seeds(handler):
    # [A24] A smooth rule with conditions must still seed: _build_rule_smooth_map keys off the raw
    # row id, the same id the plan's matched charge carries, so the smooth context is found.
    conditions = [{"field": "description", "operator": "contains", "value": "ORIGIN"},
                  {"field": "amount", "operator": "less_than", "value": "100"}]
    row = {"id": "m1", "field": "description", "operator": "contains", "value": "ORIGIN",
           "category_id": "insurance", "conditions": conditions, "logic": "all",
           "smooth": True, "smooth_seeded": False,
           "smooth_amount": Decimal("42.50"), "smooth_gap_days": 30}
    repo = WritableFeedRepo({SPENDING: [_origin("t1", amount=Decimal("-42.50"))]})
    rule_repo = FakeRuleRepo(rules=[row])
    budget = FakeBudget()
    _sweep(handler, repo, rule_repo, budget=budget)
    assert repo._find_row(f"ACCOUNT#{SPENDING}", "TXN#t1")["category"] == "insurance"
    assert len(budget.calls) == 1 and getattr(rule_repo, "smoothed", []) == ["m1"]


# --- a smooth rule matching nothing never touches the pay cycle -----------------------------------

def test_a_smooth_rule_matching_nothing_reads_no_paycycle(handler):
    # [A25] No matched charge -> seed() is never reached -> zero pay-cycle read + zero budget write.
    rule_repo = FakeRuleRepo(rules=[_smooth_rule(value="NOMATCH")])
    budget, paycycle = FakeBudget(), FakePaycycle()
    _sweep(handler, WritableFeedRepo({SPENDING: [_origin("t1")]}), rule_repo,
           budget=budget, paycycle=paycycle)
    assert budget.calls == [] and paycycle.reads == 0


# --- regression: a budget_excluded (non-smooth) winning rule still files + excludes ----------------

def test_a_budget_excluded_non_smooth_rule_still_files_and_excludes(handler):
    # [A26] budget_excluded + smooth can't coexist (PR1 rejects at create), so with the smooth wiring
    # present a plain budget_excluded rule must file the charge, set budget_excluded, and touch no
    # budget/paycycle repo (it is not smooth).
    rule_repo = FakeRuleRepo(rules=[_smooth_rule(smooth=False, budget_excluded=True)])
    repo = WritableFeedRepo({SPENDING: [_origin("t1")]})
    budget, paycycle = FakeBudget(), FakePaycycle()
    _sweep(handler, repo, rule_repo, budget=budget, paycycle=paycycle)
    row = repo._find_row(f"ACCOUNT#{SPENDING}", "TXN#t1")
    assert row["category"] == "insurance" and row.get("budget_excluded") is True
    assert budget.calls == [] and paycycle.reads == 0 and getattr(rule_repo, "smoothed", []) == []


# --- the async worker route (impl suite tested only the sync route) -------------------------------

class FakeJobRepo:
    def __init__(self):
        self.jobs = {}

    def create_job(self, job_id, kind="apply_rules"):
        self.jobs[job_id] = {"id": job_id, "status": "running"}
        return self.jobs[job_id]

    def get_job(self, job_id):
        return self.jobs.get(job_id)

    def update_progress(self, job_id, counts):
        self.jobs.setdefault(job_id, {"id": job_id}).update(counts)

    def finish_job(self, job_id, status, counts, created_rule=None, error=None):
        self.jobs.setdefault(job_id, {"id": job_id}).update(
            {"status": status, "error": error, "createdRule": created_rule, **counts})


def _wire_worker(worker, monkeypatch, *, transactions, rules, budget, paycycle,
                 categories=frozenset({"insurance", "coffee"})):
    txn_repo = WritableFeedRepo(transactions)
    rule_repo = FakeRuleRepo(rules=list(rules))
    job_repo = FakeJobRepo()
    job_repo.create_job("job1")
    monkeypatch.setattr(worker, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(worker, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(worker, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(worker, "JobRepository", lambda: job_repo)
    monkeypatch.setattr(worker, "BudgetRepository", lambda: budget)
    monkeypatch.setattr(worker, "PayCycleRepository", lambda: paycycle)
    return txn_repo, rule_repo, job_repo


def test_worker_seeds_a_smooth_rules_plan_once_and_marks_it(apply_rules_worker, monkeypatch):
    # [A27] The async (uncapped) worker builds its own SmoothSeeder + smooth map. Three matching
    # charges -> one plan seeded, one pay-cycle read, rule marked. FAIL-ON-REVERT: drop the worker's
    # smooth_seeder/rule_smooth_by_id kwargs and budget.calls goes to zero.
    worker = apply_rules_worker
    budget, paycycle = FakeBudget(), FakePaycycle()
    rows = [_origin("t1", "2026-07-01"), _origin("t2", "2026-07-02"), _origin("t3", "2026-07-03")]
    _, rule_repo, job_repo = _wire_worker(
        worker, monkeypatch, transactions={SPENDING: rows}, rules=[_smooth_rule()],
        budget=budget, paycycle=paycycle)

    result = worker.lambda_handler({"jobId": "job1"})

    assert result["status"] == "succeeded"
    assert len(budget.calls) == 1 and paycycle.reads == 1 and getattr(rule_repo, "smoothed", []) == ["r1"]
    assert job_repo.jobs["job1"]["filed"] == 3


def test_worker_with_a_non_smooth_rule_touches_no_budget(apply_rules_worker, monkeypatch):
    # [A28] The worker's smooth wiring costs a normal charge nothing.
    worker = apply_rules_worker
    budget, paycycle = FakeBudget(), FakePaycycle()
    _, rule_repo, _ = _wire_worker(
        worker, monkeypatch, transactions={SPENDING: [_origin("t1")]},
        rules=[_smooth_rule(smooth=False)], budget=budget, paycycle=paycycle)

    worker.lambda_handler({"jobId": "job1"})
    assert budget.calls == [] and paycycle.reads == 0 and getattr(rule_repo, "smoothed", []) == []
