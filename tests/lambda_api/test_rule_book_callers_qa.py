"""WHIT-623 slice 3 QA — the callers (apply route, update/delete routes, worker, reprocess) now run
on shared/rule_book.py. These pin the WIRING each caller owns, which the rule book's own suites
can't see:

  * [A1]/[A2] the routes' write limit reads the HANDLER's clock (`handler.time`), not rule_book's
    own `time.monotonic` — the clock `started` came from. The fake clock starts far in the future,
    so if the limit read the real clock the budget would never trip.
  * [A3] the worker's plain sweep carries the winning rule's "keep out of budget" action.
  * [A4]/[A5] the worker's inline "file this shop" run: narrowed to the one minted rule, stamped
    with its id, and no reconcile pass (so an orphan stamp is left for the plain sweep).
  * [A6] reprocess's `file_charge(charge, *load_rules(...))` shape still files, stamps and excludes.
"""

import json

from _feed_fakes import SPENDING, FakeCategoryRepo, real_repos, _row, stored
from _job_fakes import real_job_repo


_CATEGORIES = frozenset({"groceries", "petrol"})
_FAR_FUTURE = 1e12   # far past any real time.monotonic() reading


class _FutureStepClock:
    """Stands in for the handler's `time` module: starts at _FAR_FUTURE and advances `step` each read."""

    def __init__(self, step):
        self.step = step
        self.reads = 0

    def monotonic(self):
        value = _FAR_FUTURE + self.reads * self.step
        self.reads += 1
        return value


def _store_rule(value, category_id="groceries", **extra):
    # The kwargs of one real RuleRepository.create_rule call.
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id, **extra}


# --- [A1]/[A2] the routes' limit runs on the handler's clock ------------------------------------


def test_apply_route_time_budget_reads_the_handlers_clock(handler, monkeypatch):
    # [A1] Reads: started=F, row2=F+4, row3=F+8, row4=F+12 >= budget 10 -> 3 writes, 2 remaining.
    # FAIL-ON-REVERT: drop `clock=time.monotonic` from _apply_rules_limit and the limit reads the
    # real clock (far below F), never trips, and all 5 file.
    monkeypatch.setattr(handler, "APPLY_RULES_TIME_BUDGET_SECONDS", 10)
    monkeypatch.setattr(handler, "time", _FutureStepClock(step=4))
    rows = [_row(SPENDING, f"2026-07-0{n}", f"t{n}", description="COLES") for n in range(1, 6)]
    table, repo, rule_repo = real_repos({SPENDING: rows}, rules=[_store_rule("coles")])
    event = {"rawPath": "/transactions/uncategorized/apply-rules",
             "requestContext": {"http": {"method": "POST"}}, "body": json.dumps({"dryRun": False})}

    resp = handler.apply_rules_to_uncategorized(
        event, repo, FakeCategoryRepo(_CATEGORIES), rule_repo)
    body = json.loads(resp["body"])

    assert len(body["filed"]) == 3 and len(table.update_calls) == 3
    assert body["remaining"] == 2


def test_delete_route_time_budget_reads_the_handlers_clock(handler, monkeypatch):
    # [A2] One write always gets in; the next read is F+100 >= budget 10 -> stop, 2 left.
    # FAIL-ON-REVERT: same as [A1] — on the real clock all 3 are cleared and remaining is 0.
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 999)
    monkeypatch.setattr(handler, "APPLY_RULES_TIME_BUDGET_SECONDS", 10)
    monkeypatch.setattr(handler, "time", _FutureStepClock(step=100))
    table, repo, rule_repo = real_repos(rules=[_store_rule("coles")])
    rule_id = rule_repo.list_rules()[0]["id"]
    table.seed(*[_row(SPENDING, f"2026-07-0{n}", f"t{n}", description="COLES",
                      category="groceries", filed_by_rule=rule_id) for n in range(1, 4)])
    event = {"rawPath": f"/rules/{rule_id}", "requestContext": {"http": {"method": "DELETE"}},
             "pathParameters": {"id": rule_id}}

    body = json.loads(handler.delete_rule_route(event, rule_repo, repo)["body"])

    assert body["remaining"] == 2
    assert sum(1 for n in range(1, 4) if "category" not in stored(table, f"t{n}")) == 1


# --- [A3]-[A5] the worker's wiring ---------------------------------------------------------------


def _wire_worker(worker, monkeypatch, *, rows, rules):
    table, txn_repo, rule_repo = real_repos({SPENDING: rows}, rules=rules)
    job_repo = real_job_repo()
    monkeypatch.setattr(worker, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(worker, "CategoryRepository", lambda: FakeCategoryRepo(_CATEGORIES))
    monkeypatch.setattr(worker, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(worker, "JobRepository", lambda: job_repo)
    return table, job_repo


def test_worker_plain_sweep_keeps_an_excluding_rules_charge_out_of_the_budget(
        apply_rules_worker, monkeypatch):
    # [A3] FAIL-ON-REVERT: build excluded_by_id empty (or read it off the narrowed rules) and the
    # worker files the charge without budget_excluded.
    rows = [_row(SPENDING, "2026-07-01", "t1", description="RENT")]
    table, job_repo = _wire_worker(
        apply_rules_worker, monkeypatch, rows=rows,
        rules=[_store_rule("rent", budget_excluded=True)])

    apply_rules_worker.lambda_handler({"jobId": "job1"})

    assert job_repo.get_job("job1")["status"] == "succeeded"
    assert stored(table, "t1")["category"] == "groceries"
    assert stored(table, "t1")["budget_excluded"] is True


def test_worker_inline_run_files_only_that_shop_stamped_with_the_minted_rule(
        apply_rules_worker, monkeypatch):
    # [A4] A stored "uber -> petrol" rule matches t2, but the inline run is "file COLES" only.
    # FAIL-ON-REVERT: drop the worker's `book.only(...)` and t2 is filed too; stamp with None
    # instead of created_rule["id"] and t1 carries no stamp.
    rows = [_row(SPENDING, "2026-07-01", "t1", description="COLES"),
            _row(SPENDING, "2026-07-02", "t2", description="UBER")]
    table, job_repo = _wire_worker(
        apply_rules_worker, monkeypatch, rows=rows, rules=[_store_rule("uber", "petrol")])

    apply_rules_worker.lambda_handler(
        {"jobId": "job1", "rule": {"value": "COLES", "categoryId": "groceries",
                                   "budgetExcluded": False}})

    job = job_repo.get_job("job1")
    assert job["status"] == "succeeded" and job["filed"] == 1
    assert stored(table, "t1")["filed_by_rule"] == job["createdRule"]["id"]
    assert stored(table, "t2").get("category") is None


def test_worker_inline_run_runs_no_reconcile_pass(apply_rules_worker, monkeypatch):
    # [A5] An orphan stamp (its rule is gone) is the plain sweep's job to clear, never the inline
    # run's. FAIL-ON-REVERT: pass run_reconcile=True on the inline path and the orphan is cleared.
    rows = [_row(SPENDING, "2026-07-01", "t1", description="COLES"),
            _row(SPENDING, "2026-07-02", "orphan", description="KMART",
                 category="groceries", filed_by_rule="r_dead")]
    table, _ = _wire_worker(apply_rules_worker, monkeypatch, rows=rows, rules=[])

    apply_rules_worker.lambda_handler(
        {"jobId": "job1", "rule": {"value": "COLES", "categoryId": "groceries",
                                   "budgetExcluded": False}})

    orphan = stored(table, "orphan")
    assert orphan["category"] == "groceries" and orphan["filed_by_rule"] == "r_dead"
