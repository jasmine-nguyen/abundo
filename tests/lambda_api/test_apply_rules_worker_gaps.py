"""Adversarial GAP tests for lambda_api/apply_rules_worker.py (WHIT-537).

The impl suite (test_apply_rules_worker.py) proves the headline "files 900 past the 300 cap",
progress-every-50, failure, idempotency, inline mint and no-rules. These add the edges it skips:

  * progress cadence EXACTNESS — exactly 900 filed => exactly the initial write + 18 mid writes,
    at filed = 50,100,...,900; a run of <50 => the initial matched write and NO mid write.
  * the WHIT-540 reconcile sweep running UNCAPPED — a filed_by_rule tail of 500 orphaned stamps
    the SYNC route's 300 cap would leave behind, which the worker clears in full (this is the
    "no cap" promise for the reconcile half, which the impl suite never exercises).
  * a matched set carrying vanished / write-error / already-filed / changed-back-to-unfiled rows,
    so every outcome bucket (filed/vanished/failed/alreadyFiled) the job reports is real.

Runs the real TransactionRepository and RuleRepository over one FakeTable (_feed_fakes.real_repos)
via the lambda_api conftest's `apply_rules_worker` fixture, and the real JobRepository over its own
FakeTable (_job_fakes). The cadence assertions read the ORDERED progress writes off the table's
update log (progress_writes), since the stored row only keeps the last one.
"""

import pytest

from _feed_fakes import (
    SPENDING, FakeCategoryRepo, fail_writes, real_repos, _row, stored, vanish_on_write,
)
from _job_fakes import progress_writes, real_job_repo


def _rule(value, category_id="groceries"):
    # The kwargs of one real RuleRepository.create_rule call.
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id}


def _wire(worker, monkeypatch, *, transactions, rules, categories=frozenset({"groceries"})):
    table, txn_repo, rule_repo = real_repos(transactions, rules=rules)
    job_repo = real_job_repo()
    job_repo.create_job("job1")
    monkeypatch.setattr(worker, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(worker, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(worker, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(worker, "JobRepository", lambda: job_repo)
    return table, job_repo


# --- progress cadence exactness ----------------------------------------------


def test_progress_writes_exactly_every_50_over_900_rows(apply_rules_worker, monkeypatch):
    # [A-G1] 900 filed => 1 initial "matched" write + 18 mid-run writes at filed 50,100,...,900.
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", f"t{i:04d}", description="COLES")
            for i in range(900)]
    _, job_repo = _wire(worker, monkeypatch, transactions={SPENDING: rows}, rules=[_rule("COLES")])

    worker.lambda_handler({"jobId": "job1"})

    # The initial write carries matched=900, filed=0; mid-run writes carry a positive `filed`.
    mid = [c for c in progress_writes(job_repo) if c.get("filed", 0) > 0]
    assert [c["filed"] for c in mid] == list(range(50, 901, 50))   # exactly 18, exact cadence
    # remaining tracks matched - filed on every mid-run write (never negative, never overshoots).
    assert all(c["remaining"] == 900 - c["filed"] for c in mid)
    # The one initial write, before any filing.
    initial = [c for c in progress_writes(job_repo) if c.get("filed", 0) == 0]
    assert len(initial) == 1 and initial[0]["matched"] == 900 and initial[0]["remaining"] == 900


def test_a_run_under_50_writes_only_the_initial_progress_no_mid_writes(apply_rules_worker, monkeypatch):
    # [A-G2] 30 filed (< PROGRESS_EVERY) => only the initial matched write; the bar jumps at finish.
    worker = apply_rules_worker
    rows = [_row(SPENDING, "2026-07-01", f"t{i:02d}", description="COLES")
            for i in range(30)]
    table, job_repo = _wire(worker, monkeypatch, transactions={SPENDING: rows},
                            rules=[_rule("COLES")])

    worker.lambda_handler({"jobId": "job1"})

    # Exactly ONE progress write (the initial matched=30), and no mid-run write fired.
    assert len(progress_writes(job_repo)) == 1
    assert progress_writes(job_repo)[0]["matched"] == 30 and progress_writes(job_repo)[0]["filed"] == 0
    # But everything was still filed and the finished counts are complete.
    assert len(table.update_calls) == 30
    assert job_repo.get_job("job1")["filed"] == 30 and job_repo.get_job("job1")["remaining"] == 0


# --- reconcile sweep runs UNCAPPED in the worker -----------------------------


def test_worker_clears_a_500_row_reconcile_tail_the_300_cap_would_leave(apply_rules_worker, monkeypatch):
    # [A-G3] 500 rows stamped by a rule that no longer exists (orphans). The sync route's 300 cap
    # would leave 200 stamped; the worker (max_writes=None) clears ALL 500. This is the "no cap"
    # promise for the WHIT-540 reconcile half — the impl suite only exercises the file loop.
    worker = apply_rules_worker
    orphans = [_row(SPENDING, "2026-07-01", f"o{i:04d}", description="MYER",
                    category="oldcat", filed_by_rule="r_dead") for i in range(500)]
    # A live rule must exist (else the worker returns before the write phase) but it targets COLES,
    # so it matches NONE of the MYER orphans — the only writes are reconcile clears.
    table, job_repo = _wire(worker, monkeypatch, transactions={SPENDING: orphans},
                            rules=[_rule("COLES")])

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


# --- every outcome bucket exercised ------------------------------------------


def test_worker_counts_filed_vanished_failed_and_alreadyfiled_in_one_sweep(apply_rules_worker, monkeypatch):
    # [A-G4] One matched set spanning every write outcome, so the job's counts are all real:
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
    table, job_repo = _wire(worker, monkeypatch, transactions={SPENDING: rows},
                            rules=[_rule("COLES")],
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
