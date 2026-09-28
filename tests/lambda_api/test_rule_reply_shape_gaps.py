"""WHIT-623 slice 1 QA — every reply that carries a rule drops the internal `spreadSeeded` flag.

The one converter (rule_book.rule_from_row) now keeps `spreadSeeded` so the spread seeder can read
it. That makes every engine-shaped rule carry the flag, so each reply site must strip it through
rule_book.rule_reply (decision A: replies unchanged). test_rules_routes.py pins GET /rules on a
plain rule and test_apply_rules_worker.py pins the job row; this suite pins the remaining reply
sites — on an ALREADY-SEEDED spread rule, where a leak would read `"spreadSeeded": true`:
POST 201, PUT 200, the create/update/apply/job 409s, and the sync apply's createdRule. Plus the
worker's spread lookup, which is now the full engine rule rather than the old hand-built map.

FAIL-ON-REVERT: make rule_book.rule_reply return the rule unchanged (or call rule_from_row alone at
a reply site) and the reply tests redden.
"""

import json
from decimal import Decimal

import pytest

from _feed_fakes import SPENDING, _row, FakeCategoryRepo, WritableFeedRepo
from _rule_fakes import FakeRuleRepo

_CATEGORIES = ("groceries", "petrol", "insurance")
_REPLY_KEYS = {"id", "field", "operator", "value", "categoryId", "budgetExcluded",
               "spread", "spreadAmount", "spreadGapDays", "conditions", "logic"}


def _seeded_spread_rule(value="ORIGIN", category_id="insurance", rule_id=None):
    # No id → FakeRuleRepo derives the store's text-hash id, so same-text writes really collide.
    return {"id": rule_id, "field": "description", "operator": "contains", "value": value,
            "category_id": category_id, "budget_excluded": False, "spread": True,
            "spread_seeded": True, "spread_amount": Decimal("42.50"), "spread_gap_days": 30}


def _event(method, path, body=None, path_params=None):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if body is not None:
        event["body"] = json.dumps(body)
    if path_params is not None:
        event["pathParameters"] = path_params
    return event


def _inject(handler, monkeypatch, rule_repo, transactions=None):
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(_CATEGORIES))
    monkeypatch.setattr(
        handler, "TransactionRepository", lambda: WritableFeedRepo(transactions or {}))


def _origin(txn_id, date="2026-07-01"):
    return _row(SPENDING, date, txn_id, description="ORIGIN ENERGY BILL", category=None)


# --- the /rules routes ------------------------------------------------------------------------


def test_get_rules_on_a_seeded_spread_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A1]
    _inject(handler, monkeypatch, FakeRuleRepo(rules=[_seeded_spread_rule()]))

    resp = handler.lambda_handler(_event("GET", "/rules"), None)
    [rule] = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert set(rule) == _REPLY_KEYS
    assert rule["spread"] is True


def test_post_rules_201_reply_has_no_spread_seeded(handler, monkeypatch):
    # [A2]
    _inject(handler, monkeypatch, FakeRuleRepo())

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "COLES", "categoryId": "groceries"}), None)

    assert resp["statusCode"] == 201
    assert set(json.loads(resp["body"])) == _REPLY_KEYS


def test_post_rules_409_existing_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A3] Same text, different category → create_rule raises RuleClashError(existing row).
    _inject(handler, monkeypatch, FakeRuleRepo(rules=[_seeded_spread_rule()]))

    resp = handler.lambda_handler(
        _event("POST", "/rules", {"value": "ORIGIN", "categoryId": "groceries"}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert set(body["existingRule"]) == _REPLY_KEYS
    assert body["existingRule"]["value"] == "ORIGIN"


def test_put_rules_200_reply_on_a_seeded_spread_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A4] An in-place edit of a seeded spread rule keeps spread_seeded True in the store; the reply
    # must still not carry it. The `remaining` count stays on the reply.
    repo = FakeRuleRepo(rules=[_seeded_spread_rule()])
    _inject(handler, monkeypatch, repo)
    [rule_id] = [row["id"] for row in repo.list_rules()]

    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{rule_id}",
               {"value": "ORIGIN", "categoryId": "insurance", "spread": True},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200, body
    assert set(body) == _REPLY_KEYS | {"remaining"}
    assert body["remaining"] == 0


def test_put_rules_409_existing_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A5] Editing COLES onto ORIGIN's text → RuleClashError(ORIGIN's seeded row).
    import rule_engine

    coles_id = rule_engine.rule_id_for("description", "contains", "COLES")
    origin_id = rule_engine.rule_id_for("description", "contains", "ORIGIN")
    repo = FakeRuleRepo(rules=[
        _seeded_spread_rule(rule_id=origin_id),
        {"id": coles_id, "field": "description", "operator": "contains", "value": "COLES",
         "category_id": "groceries"},
    ])
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        _event("PUT", f"/rules/{coles_id}", {"value": "ORIGIN", "categoryId": "groceries"},
               path_params={"id": coles_id}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert set(body["existingRule"]) == _REPLY_KEYS


# --- the sync apply-rules route ---------------------------------------------------------------


def _apply_event(body):
    return {"rawPath": "/transactions/uncategorized/apply-rules",
            "requestContext": {"http": {"method": "POST"}}, "body": json.dumps(body)}


def test_apply_pre_scan_clash_409_existing_rule_has_no_spread_seeded(handler):
    # [A6] The pre-scan clash returns a rule straight out of the engine-shaped list (rule_from_row),
    # the path most likely to leak — only _rule_clash_response strips it.
    resp = handler.apply_rules_to_uncategorized(
        _apply_event({"dryRun": True, "rule": {"value": "ORIGIN", "categoryId": "groceries"}}),
        WritableFeedRepo({SPENDING: [_origin("t1")]}), FakeCategoryRepo(_CATEGORIES),
        FakeRuleRepo(rules=[_seeded_spread_rule()]))
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409, body
    assert set(body["existingRule"]) == _REPLY_KEYS
    assert body["existingRule"]["value"] == "ORIGIN"


def test_apply_inline_created_rule_has_no_spread_seeded(handler):
    # [A7] The sync route's createdRule (the job row's twin is pinned in test_apply_rules_worker.py).
    resp = handler.apply_rules_to_uncategorized(
        _apply_event({"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}}),
        WritableFeedRepo({SPENDING: [
            _row(SPENDING, "2026-07-01", "t1", description="COLES", category=None)]}),
        FakeCategoryRepo(_CATEGORIES), FakeRuleRepo())
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200, body
    assert set(body["createdRule"]) == _REPLY_KEYS


# --- the async job start route ----------------------------------------------------------------


class _JobRepo:
    def __init__(self):
        self.created = []

    def create_job(self, job_id, kind="apply_rules"):
        self.created.append(job_id)
        return {"id": job_id}


def test_job_start_clash_409_existing_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A8]
    monkeypatch.setenv("APPLY_RULES_WORKER_FUNCTION", "abundo-apply-rules-worker")
    monkeypatch.setattr(handler, "_get_lambda_client", lambda: pytest.fail("must not invoke"))
    job_repo = _JobRepo()

    resp = handler.start_apply_rules_job(
        _event("POST", "/transactions/uncategorized/apply-rules/jobs",
               {"rule": {"value": "ORIGIN", "categoryId": "groceries"}}),
        FakeCategoryRepo(_CATEGORIES), FakeRuleRepo(rules=[_seeded_spread_rule()]), job_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert set(body["existingRule"]) == _REPLY_KEYS
    assert job_repo.created == []


# --- the worker's spread lookup (now the full engine rule, not the old hand-built map) ---------


class _Budget:
    def __init__(self):
        self.calls = []

    def set_spread_if_absent(self, *args):
        self.calls.append(args)
        return {"id": "plan"}


class _Paycycle:
    def __init__(self):
        self.reads = 0

    def get_paycycle(self):
        self.reads += 1
        return {"length": 14, "last_pay_date": "2026-01-07"}


class _WorkerJobRepo:
    def __init__(self):
        self.jobs = {"job1": {"id": "job1", "status": "running"}}

    def get_job(self, job_id):
        return self.jobs.get(job_id)

    def update_progress(self, job_id, counts):
        self.jobs[job_id].update(counts)

    def finish_job(self, job_id, status, counts, created_rule=None, error=None):
        self.jobs[job_id].update(
            {"status": status, "error": error, "createdRule": created_rule, **counts})


def test_worker_does_not_reseed_a_rule_already_seeded_in_the_store(apply_rules_worker, monkeypatch):
    # [A9] The sync route's twin is pinned in test_apply_rules_spread_gaps.py [A20]; the worker had
    # no such guard. FAIL-ON-REVERT: drop spreadSeeded from rule_from_row (or build the worker's
    # spread lookup without it) and the worker re-creates a plan the user already has.
    worker = apply_rules_worker
    budget, paycycle = _Budget(), _Paycycle()
    rule_repo = FakeRuleRepo(rules=[_seeded_spread_rule()])
    job_repo = _WorkerJobRepo()
    txn_repo = WritableFeedRepo({SPENDING: [_origin("t1"), _origin("t2", "2026-07-02")]})
    monkeypatch.setattr(worker, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(worker, "CategoryRepository", lambda: FakeCategoryRepo(_CATEGORIES))
    monkeypatch.setattr(worker, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(worker, "JobRepository", lambda: job_repo)
    monkeypatch.setattr(worker, "BudgetRepository", lambda: budget)
    monkeypatch.setattr(worker, "PayCycleRepository", lambda: paycycle)

    result = worker.lambda_handler({"jobId": "job1"})

    assert result["status"] == "succeeded"
    assert job_repo.jobs["job1"]["filed"] == 2          # the rule still files
    assert budget.calls == [] and paycycle.reads == 0   # ...but never re-seeds
    assert rule_repo.spread_seeded_ids == []
