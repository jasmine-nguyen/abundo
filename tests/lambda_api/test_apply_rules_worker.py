"""Tests for lambda_api/apply_rules_worker.py — the async, UNCAPPED apply-rules sweep (WHIT-537).

The whole point of the card: the worker files the WHOLE matched backlog, past the 300/15s cap the
synchronous route lives under. It reuses the handler's shared write phase, so what gets FILED is
identical to the sync route; only the cap differs. These tests drive the real write phase against
the WritableFeedRepo (the realistic paged date-index fake) and a recording FakeJobRepo, so the
"no cap", progress, failure, and idempotency behaviours are exercised for real.
"""

import pytest

from _feed_fakes import SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _rule(value, category_id="groceries", rule_id="r1"):
    return {"id": rule_id, "field": "description", "operator": "contains", "value": value,
            "category_id": category_id}


class FakeJobRepo:
    def __init__(self):
        self.jobs = {}
        self.progress_calls = []

    def create_job(self, job_id, kind="apply_rules"):
        self.jobs[job_id] = {"id": job_id, "status": "running"}
        return self.jobs[job_id]

    def get_job(self, job_id):
        return self.jobs.get(job_id)

    def update_progress(self, job_id, counts):
        self.progress_calls.append(dict(counts))
        self.jobs.setdefault(job_id, {"id": job_id}).update(counts)

    def finish_job(self, job_id, status, counts, created_rule=None, error=None):
        self.jobs.setdefault(job_id, {"id": job_id}).update(
            {"status": status, "error": error, "createdRule": created_rule, **counts})


def _wire(worker, monkeypatch, *, transactions, rules, categories=frozenset({"groceries"})):
    """Point the worker's repo constructors at the given fakes, return (txn_repo, job_repo)."""
    txn_repo = WritableFeedRepo(transactions)
    rule_repo = FakeRuleRepo(rules=list(rules))
    job_repo = FakeJobRepo()
    job_repo.create_job("job1")
    monkeypatch.setattr(worker, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(worker, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(worker, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(worker, "JobRepository", lambda: job_repo)
    return txn_repo, job_repo


def test_worker_files_the_whole_backlog_past_the_300_cap(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", f"t{i}", description="COLES", category=None)
            for i in range(900)]
    txn_repo, job_repo = _wire(worker, monkeypatch, transactions={SPENDING: rows},
                               rules=[_rule("COLES")])

    result = worker.lambda_handler({"jobId": "job1"})

    assert result == {"jobId": "job1", "status": "succeeded"}
    # FAIL-ON-REVERT: this is the card. Reintroduce APPLY_RULES_MAX_WRITES on the worker path and
    # the file count collapses to 300.
    assert len(txn_repo.writes) == 900
    job = job_repo.jobs["job1"]
    assert job["status"] == "succeeded"
    assert job["matched"] == 900 and job["filed"] == 900 and job["remaining"] == 0


def test_worker_records_progress_as_it_files(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", f"t{i}", description="COLES", category=None)
            for i in range(120)]
    _, job_repo = _wire(worker, monkeypatch, transactions={SPENDING: rows}, rules=[_rule("COLES")])

    worker.lambda_handler({"jobId": "job1"})

    # Progress fires every 50 filed (PROGRESS_EVERY): once each at 50 and 100 during the run, plus
    # the initial "matched" write. The bar's `filed` rises monotonically and never exceeds matched.
    filed_values = [c["filed"] for c in job_repo.progress_calls if "filed" in c]
    assert filed_values == sorted(filed_values)
    assert all(c.get("filed", 0) <= c.get("matched", 120) for c in job_repo.progress_calls)
    assert 50 in filed_values and 100 in filed_values


def test_worker_marks_the_job_failed_when_a_read_raises(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    _, job_repo = _wire(worker, monkeypatch, transactions={SPENDING: []}, rules=[_rule("COLES")])
    # A DB fault reading the taxonomy: the worker must end the job "failed" (with the error), not
    # leave it stuck "running" until its TTL.
    monkeypatch.setattr(worker, "CategoryRepository", _RaisingCategoryRepo)

    result = worker.lambda_handler({"jobId": "job1"})

    assert result["status"] == "failed"
    assert job_repo.jobs["job1"]["status"] == "failed"
    assert job_repo.jobs["job1"]["error"]


def test_worker_is_idempotent_on_a_second_run(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", f"t{i}", description="COLES", category=None)
            for i in range(5)]
    txn_repo, job_repo = _wire(worker, monkeypatch, transactions={SPENDING: rows},
                               rules=[_rule("COLES")])

    worker.lambda_handler({"jobId": "job1"})
    first_writes = len(txn_repo.writes)
    assert first_writes == 5
    # Second run over the same rows: they are all filed now, so they are no longer "unfiled" and
    # the plan matches nothing — the worker files 0 more and writes nothing. This is the re-run
    # safety AWS async double-delivery relies on (a redelivered job can't double-file).
    job_repo.create_job("job2")
    worker.lambda_handler({"jobId": "job2"})

    job2 = job_repo.jobs["job2"]
    assert job2["status"] == "succeeded"
    assert job2["matched"] == 0 and job2["filed"] == 0
    assert len(txn_repo.writes) == first_writes    # no new writes on the second run


def test_worker_with_an_inline_rule_mints_it_and_records_created_rule(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", "t1", description="COLES", category=None)]
    txn_repo, job_repo = _wire(worker, monkeypatch, transactions={SPENDING: rows}, rules=[])

    result = worker.lambda_handler({"jobId": "job1", "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert result["status"] == "succeeded"
    job = job_repo.jobs["job1"]
    assert job["filed"] == 1
    assert job["createdRule"] is not None and job["createdRule"]["categoryId"] == "groceries"


def test_worker_succeeds_with_no_rules(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    _, job_repo = _wire(worker, monkeypatch,
                        transactions={SPENDING: [_row(SPENDING, "2026-07-01", "t1", category=None)]},
                        rules=[])

    result = worker.lambda_handler({"jobId": "job1"})
    assert result["status"] == "succeeded"
    assert job_repo.jobs["job1"]["matched"] == 0 and job_repo.jobs["job1"]["filed"] == 0


class _RaisingCategoryRepo:
    """A taxonomy repo whose read raises the same DatabaseError the worker catches."""

    def list_categories(self):
        from repository import DatabaseError
        raise DatabaseError("db down")
