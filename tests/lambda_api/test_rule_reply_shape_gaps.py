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
from functools import partial

import pytest

from _api_event import api_event
from _budget_endpoint_fakes import _FakePayCycleRepo
from _feed_fakes import apply_rules_event, apply_rules_job_post_event, SPENDING, FakeCategoryRepo, Repos, _row, inject_rule_routes
from _job_fakes import created_jobs, real_job_repo
from _rule_ingest_fakes import apply_rules_to_uncategorized

_CATEGORIES = ("groceries", "petrol", "insurance")
_REPLY_KEYS = {"id", "field", "operator", "value", "categoryId", "budgetExcluded",
               "spread", "spreadAmount", "spreadGapDays", "conditions", "logic"}


def _seeded_store(*other_rules, transactions=None):
    """Real repos over one table holding an ORIGIN -> insurance spread rule that has ALREADY seeded
    its plan (marked through the real mark_spread_seeded), plus any other create_rule kwargs."""
    store = Repos(transactions, rules=[
        {"field": "description", "operator": "contains", "value": "ORIGIN",
         "category_id": "insurance", "spread": True, "spread_amount": Decimal("42.50"),
         "spread_gap_days": 30},
        *other_rules,
    ])
    store.rule_repo.mark_spread_seeded(store.rule_id("ORIGIN"))
    return store


def _seed_marks(table):
    """How many times the store's spread_seeded marker was written."""
    return len([names for _, names, _ in table.update_calls if "spread_seeded" in names.values()])


_inject = partial(inject_rule_routes, categories=_CATEGORIES)


def _origin(txn_id, date="2026-07-01"):
    return _row(SPENDING, date, txn_id, description="ORIGIN ENERGY BILL")


# --- the /rules routes ------------------------------------------------------------------------


def test_get_rules_on_a_seeded_spread_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A1]
    _inject(handler, monkeypatch, _seeded_store())

    resp = handler.lambda_handler(api_event("GET", "/rules"), None)
    [rule] = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert set(rule) == _REPLY_KEYS
    assert rule["spread"] is True


def test_post_rules_201_reply_has_no_spread_seeded(handler, monkeypatch):
    # [A2]
    _inject(handler, monkeypatch, Repos())

    resp = handler.lambda_handler(
        api_event("POST", "/rules", {"value": "COLES", "categoryId": "groceries"}), None)

    assert resp["statusCode"] == 201
    assert set(json.loads(resp["body"])) == _REPLY_KEYS


def test_post_rules_409_existing_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A3] Same text, different category → create_rule raises RuleClashError(existing row).
    _inject(handler, monkeypatch, _seeded_store())

    resp = handler.lambda_handler(
        api_event("POST", "/rules", {"value": "ORIGIN", "categoryId": "groceries"}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert set(body["existingRule"]) == _REPLY_KEYS
    assert body["existingRule"]["value"] == "ORIGIN"


def test_put_rules_200_reply_on_a_seeded_spread_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A4] An in-place edit of a seeded spread rule keeps spread_seeded True in the store; the reply
    # must still not carry it. The `remaining` count stays on the reply.
    repo = _seeded_store()
    _inject(handler, monkeypatch, repo)
    rule_id = repo.rule_id("ORIGIN")

    resp = handler.lambda_handler(
        api_event("PUT", f"/rules/{rule_id}",
               {"value": "ORIGIN", "categoryId": "insurance", "spread": True},
               path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200, body
    assert set(body) == _REPLY_KEYS | {"remaining"}
    assert body["remaining"] == 0


def test_put_rules_409_existing_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A5] Editing COLES onto ORIGIN's text → RuleClashError(ORIGIN's seeded row).
    repo = _seeded_store({"field": "description", "operator": "contains", "value": "COLES",
                          "category_id": "groceries"})
    coles_id = repo.rule_id("COLES")
    _inject(handler, monkeypatch, repo)

    resp = handler.lambda_handler(
        api_event("PUT", f"/rules/{coles_id}", {"value": "ORIGIN", "categoryId": "groceries"},
               path_params={"id": coles_id}), None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert set(body["existingRule"]) == _REPLY_KEYS


# --- the sync apply-rules route ---------------------------------------------------------------


def test_apply_pre_scan_clash_409_existing_rule_has_no_spread_seeded(handler):
    # [A6] The pre-scan clash returns a rule straight out of the engine-shaped list (rule_from_row),
    # the path most likely to leak — only _rule_clash_response strips it.
    store = _seeded_store(transactions={SPENDING: [_origin("t1")]})
    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event({"dryRun": True, "rule": {"value": "ORIGIN", "categoryId": "groceries"}}),
        store.transaction_repo, FakeCategoryRepo(_CATEGORIES), store.rule_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409, body
    assert set(body["existingRule"]) == _REPLY_KEYS
    assert body["existingRule"]["value"] == "ORIGIN"


def test_apply_inline_created_rule_has_no_spread_seeded(handler):
    # [A7] The sync route's createdRule (the job row's twin is pinned in test_apply_rules_worker.py).
    store = Repos({SPENDING: [_row(SPENDING, "2026-07-01", "t1", description="COLES")]})
    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event({"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}}),
        store.transaction_repo, FakeCategoryRepo(_CATEGORIES), store.rule_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200, body
    assert set(body["createdRule"]) == _REPLY_KEYS


# --- the async job start route ----------------------------------------------------------------


def test_job_start_clash_409_existing_rule_has_no_spread_seeded(handler, monkeypatch):
    # [A8]
    monkeypatch.setenv("APPLY_RULES_WORKER_FUNCTION", "abundo-apply-rules-worker")
    monkeypatch.setattr(handler, "_get_lambda_client", lambda: pytest.fail("must not invoke"))
    job_repo = real_job_repo()

    resp = handler.start_apply_rules_job(
        apply_rules_job_post_event({"rule": {"value": "ORIGIN", "categoryId": "groceries"}}),
        FakeCategoryRepo(_CATEGORIES), _seeded_store().rule_repo, job_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 409
    assert set(body["existingRule"]) == _REPLY_KEYS
    assert created_jobs(job_repo) == []


# --- the worker's spread lookup (now the full engine rule, not the old hand-built map) ---------


class _Budget:
    def __init__(self):
        self.calls = []

    def set_spread_if_absent(self, *args):
        self.calls.append(args)
        return {"id": "plan"}


_Paycycle = partial(_FakePayCycleRepo, length=14, last_pay_date="2026-01-07")


def test_worker_does_not_reseed_a_rule_already_seeded_in_the_store(apply_rules_worker, monkeypatch):
    # [A9] The sync route's twin is pinned in test_apply_rules_spread_gaps.py [A20]; the worker had
    # no such guard. FAIL-ON-REVERT: drop spreadSeeded from rule_from_row (or build the worker's
    # spread lookup without it) and the worker re-creates a plan the user already has.
    worker = apply_rules_worker
    budget, paycycle = _Budget(), _Paycycle()
    store = _seeded_store(transactions={SPENDING: [_origin("t1"), _origin("t2", "2026-07-02")]})
    job_repo = real_job_repo()
    job_repo.create_job("job1")
    monkeypatch.setattr(worker, "TransactionRepository", lambda: store.transaction_repo)
    monkeypatch.setattr(worker, "CategoryRepository", lambda: FakeCategoryRepo(_CATEGORIES))
    monkeypatch.setattr(worker, "RuleRepository", lambda: store.rule_repo)
    monkeypatch.setattr(worker, "JobRepository", lambda: job_repo)
    monkeypatch.setattr(worker, "BudgetRepository", lambda: budget)
    monkeypatch.setattr(worker, "PayCycleRepository", lambda: paycycle)

    result = worker.lambda_handler({"jobId": "job1"})

    assert result["status"] == "succeeded"
    assert job_repo.get_job("job1")["filed"] == 2          # the rule still files
    assert budget.calls == [] and paycycle.get_calls == 0   # ...but never re-seeds
    assert _seed_marks(store.table) == 1                # only the setup's mark — never re-marked
