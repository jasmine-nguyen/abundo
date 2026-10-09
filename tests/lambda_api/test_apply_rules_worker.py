"""Tests for lambda_api/apply_rules_worker.py — the async, UNCAPPED apply-rules sweep (WHIT-537).

The whole point of the card: the worker files the WHOLE matched backlog, past the 300/15s cap the
synchronous route lives under. It reuses the handler's shared write phase, so what gets FILED is
identical to the sync route; only the cap differs. These tests drive the real write phase against
the real TransactionRepository, RuleRepository and JobRepository over FakeTables, so
the "no cap", progress, failure, and idempotency behaviours are exercised for real.
"""

from _feed_fakes import (
    SPENDING, FakeCategoryRepo, fail_writes, _row, stored, vanish_on_write,
)
from _job_fakes import progress_writes, wire_apply_rules_worker


def _rule(value, category_id="groceries"):
    # The kwargs of one real RuleRepository.create_rule call.
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id}


def test_worker_files_the_whole_backlog_past_the_300_cap(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", f"t{i}", description="COLES")
            for i in range(900)]
    table, _, job_repo = wire_apply_rules_worker(
        worker, monkeypatch, transactions={SPENDING: rows}, rules=[_rule("COLES")])

    result = worker.lambda_handler({"jobId": "job1"})

    assert result == {"jobId": "job1", "status": "succeeded"}
    # FAIL-ON-REVERT: this is the card. Reintroduce APPLY_RULES_MAX_WRITES on the worker path and
    # the file count collapses to 300.
    assert len(table.update_calls) == 900
    job = job_repo.get_job("job1")
    assert job["status"] == "succeeded"
    assert job["matched"] == 900 and job["filed"] == 900 and job["remaining"] == 0


def test_worker_records_progress_as_it_files(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", f"t{i}", description="COLES")
            for i in range(120)]
    _, _, job_repo = wire_apply_rules_worker(
        worker, monkeypatch, transactions={SPENDING: rows}, rules=[_rule("COLES")])

    worker.lambda_handler({"jobId": "job1"})

    # Progress fires every 50 filed (PROGRESS_EVERY): once each at 50 and 100 during the run, plus
    # the initial "matched" write. The bar's `filed` rises monotonically and never exceeds matched.
    filed_values = [c["filed"] for c in progress_writes(job_repo) if "filed" in c]
    assert filed_values == sorted(filed_values)
    assert all(c.get("filed", 0) <= c.get("matched", 120) for c in progress_writes(job_repo))
    assert 50 in filed_values and 100 in filed_values


def test_worker_marks_the_job_failed_when_a_read_raises(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    _, _, job_repo = wire_apply_rules_worker(
        worker, monkeypatch, transactions={SPENDING: []}, rules=[_rule("COLES")])
    # A DB fault reading the taxonomy: the worker must end the job "failed" (with the error), not
    # leave it stuck "running" until its TTL.
    from repository_errors import DatabaseError
    monkeypatch.setattr(worker, "CategoryRepository",
                        lambda: FakeCategoryRepo([], error=DatabaseError("db down")))

    result = worker.lambda_handler({"jobId": "job1"})

    assert result["status"] == "failed"
    assert job_repo.get_job("job1")["status"] == "failed"
    assert job_repo.get_job("job1")["error"]


def test_worker_is_idempotent_on_a_second_run(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", f"t{i}", description="COLES")
            for i in range(5)]
    table, _, job_repo = wire_apply_rules_worker(
        worker, monkeypatch, transactions={SPENDING: rows}, rules=[_rule("COLES")])

    worker.lambda_handler({"jobId": "job1"})
    first_writes = len(table.update_calls)
    assert first_writes == 5
    # Second run over the same rows: they are all filed now, so they are no longer "unfiled" and
    # the plan matches nothing — the worker files 0 more and writes nothing. This is the re-run
    # safety AWS async double-delivery relies on (a redelivered job can't double-file).
    job_repo.create_job("job2")
    worker.lambda_handler({"jobId": "job2"})

    job2 = job_repo.get_job("job2")
    assert job2["status"] == "succeeded"
    assert job2["matched"] == 0 and job2["filed"] == 0
    assert len(table.update_calls) == first_writes    # no new writes on the second run


def test_worker_with_an_inline_rule_mints_it_and_records_created_rule(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", "t1", description="COLES")]
    table, _, job_repo = wire_apply_rules_worker(
        worker, monkeypatch, transactions={SPENDING: rows}, rules=[])

    result = worker.lambda_handler(
        {"jobId": "job1", "rule": {"value": "COLES", "categoryId": "groceries", "budgetExcluded": False}})

    assert result["status"] == "succeeded"
    job = job_repo.get_job("job1")
    assert job["filed"] == 1
    assert job["createdRule"] is not None and job["createdRule"]["categoryId"] == "groceries"


def test_worker_saves_created_rule_in_the_app_shape_without_spread_seeded(apply_rules_worker, monkeypatch):
    # WHIT-623: the job row's createdRule is what the app reads, so it keeps the reply shape — the
    # internal spreadSeeded flag the matcher's shape carries must not leak into it.
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", "t1", description="COLES")]
    _, _, job_repo = wire_apply_rules_worker(
        worker, monkeypatch, transactions={SPENDING: rows}, rules=[])

    worker.lambda_handler(
        {"jobId": "job1", "rule": {"value": "COLES", "categoryId": "groceries", "budgetExcluded": False}})

    assert set(job_repo.get_job("job1")["createdRule"]) == {
        "id", "field", "operator", "value", "categoryId", "budgetExcluded",
        "spread", "spreadAmount", "spreadGapDays", "conditions", "logic"}


def test_worker_succeeds_with_no_rules(apply_rules_worker, monkeypatch):
    worker = apply_rules_worker
    _, _, job_repo = wire_apply_rules_worker(
        worker, monkeypatch, transactions={SPENDING: [_row(SPENDING, "2026-07-01", "t1")]},
        rules=[])

    result = worker.lambda_handler({"jobId": "job1"})
    assert result["status"] == "succeeded"
    assert job_repo.get_job("job1")["matched"] == 0 and job_repo.get_job("job1")["filed"] == 0


def test_worker_inline_run_files_only_that_shop_stamped_with_the_minted_rule(
        apply_rules_worker, monkeypatch):
    # A stored "uber -> petrol" rule matches t2, but the inline run is "file COLES" only.
    # FAIL-ON-REVERT: drop the worker's `book.only(...)` and t2 is filed too; stamp with None
    # instead of created_rule["id"] and t1 carries no stamp.
    rows = [_row(SPENDING, "2026-07-01", "t1", description="COLES"),
            _row(SPENDING, "2026-07-02", "t2", description="UBER")]
    table, _, job_repo = wire_apply_rules_worker(
        apply_rules_worker, monkeypatch, transactions={SPENDING: rows},
        rules=[_rule("uber", "petrol")], categories=frozenset({"groceries", "petrol"}))

    apply_rules_worker.lambda_handler(
        {"jobId": "job1", "rule": {"value": "COLES", "categoryId": "groceries",
                                   "budgetExcluded": False}})

    job = job_repo.get_job("job1")
    assert job["status"] == "succeeded" and job["filed"] == 1
    assert stored(table, "t1")["filed_by_rule"] == job["createdRule"]["id"]
    assert stored(table, "t2").get("category") is None


def test_worker_clears_a_500_row_reconcile_tail_the_300_cap_would_leave(apply_rules_worker, monkeypatch):
    # 500 rows stamped by a rule that no longer exists (orphans). The sync route's 300 cap would
    # leave 200 stamped; the worker (max_writes=None) clears ALL 500 — the "no cap" promise for
    # the WHIT-540 reconcile half.
    worker = apply_rules_worker
    orphans = [_row(SPENDING, "2026-07-01", f"o{i:04d}", description="MYER",
                    category="oldcat", filed_by_rule="r_dead") for i in range(500)]
    # A live rule must exist (else the worker returns before the write phase) but it targets COLES,
    # so it matches NONE of the MYER orphans — the only writes are reconcile clears.
    table, _, job_repo = wire_apply_rules_worker(
        worker, monkeypatch, transactions={SPENDING: orphans}, rules=[_rule("COLES")])

    result = worker.lambda_handler({"jobId": "job1"})

    assert result["status"] == "succeeded"
    # FAIL-ON-REVERT: swap the worker's max_writes=None for APPLY_RULES_MAX_WRITES and this drops to
    # 300 clears with 200 orphans left stamped.
    assert len(table.update_calls) == 500
    remaining_stamps = [r for r in table.store.values() if r.get("filed_by_rule") == "r_dead"]
    assert remaining_stamps == []          # every orphan stamp cleared, none left behind
    # The reconcile clears are NOT counted as `filed` (they climb `attempted` only, not the bar).
    assert job_repo.get_job("job1")["filed"] == 0
    assert job_repo.get_job("job1")["matched"] == 0


def test_worker_counts_filed_vanished_failed_and_alreadyfiled_in_one_sweep(apply_rules_worker, monkeypatch):
    # One matched set spanning every write outcome, so the job's counts are all real:
    #   f1,f2  -> written               (filed=2)
    #   v1     -> row gone since scan   (vanished=1)
    #   e1     -> write raises          (failed via DatabaseError)
    #   c1     -> changed to a still-unfiled raw label underneath (failed via changed-unfiled)
    #   a1     -> changed to a filed category underneath (alreadyFiled=1)
    worker = apply_rules_worker
    rows = [
        _row(SPENDING, "2026-07-01", "f1", description="COLES"),
        _row(SPENDING, "2026-07-01", "f2", description="COLES"),
        _row(SPENDING, "2026-07-01", "v1", description="COLES"),
        _row(SPENDING, "2026-07-01", "e1", description="COLES"),
        # Store already holds a filed category; the scan is behind and still shows it unfiled.
        _row(SPENDING, "2026-07-01", "a1", description="COLES", category="coffee"),
        # Store holds the bank's raw label (still unfiled); the scan is behind and shows None.
        _row(SPENDING, "2026-07-01", "c1", description="COLES", category="RAW-EFTPOS"),
    ]
    table, _, job_repo = wire_apply_rules_worker(
        worker, monkeypatch, transactions={SPENDING: rows}, rules=[_rule("COLES")],
        categories=frozenset({"groceries", "coffee"}))
    vanish_on_write(table, "v1")
    fail_writes(table, "e1")
    # Make a1/c1 planned (scan shows them unfiled) while the store holds the changed value.
    for transaction_id in ("a1", "c1"):
        table.stale_index(stored(table, transaction_id), category=None)

    result = worker.lambda_handler({"jobId": "job1"})

    assert result["status"] == "succeeded"
    job = job_repo.get_job("job1")
    assert job["matched"] == 6
    assert job["filed"] == 2
    assert job["vanished"] == 1
    assert job["failed"] == 2          # e1 (DB error) + c1 (changed but still unfiled)
    assert job["alreadyFiled"] == 1    # a1 (changed to a real category)
    assert job["attempted"] == 6 and job["remaining"] == 0
