"""WHIT-791 QA: the (method, path) route table and the shared job helpers.

Every route the old if-chain answered must still reach the same route function, method-gated, with
the spread route ahead of the budget item route, and anything else 404s. The shared job helpers must
keep each job type's failure text and the apply-rules poll's any-kind read.
"""

import json

import pytest

from _api_event import api_event
from _feed_fakes import FakeCategoryRepo, real_repos
from _job_fakes import created_jobs, real_job_repo, throttled_worker

_REPOSITORIES = [
    "AccountBalanceRepository", "BudgetRepository", "CategoryRepository", "DeviceRepository",
    "GoalsRepository", "InsightRepository", "JobRepository",
    "LoanFactsRepository", "MilestoneRepository", "NotifyRepository", "PayCycleRepository",
    "RuleRepository", "TransactionRepository",
]

# (method, path, the route function it must reach; None = 404, nothing called)
_DISPATCH = [
    ("GET", "/transactions", "get_recent_transactions"),
    ("GET", "/categories/c1/transactions", "get_category_transactions"),
    ("PUT", "/budgets/c1/spread", "set_spread"),
    # A category whose id is literally "spread" is a budget item, not a spread.
    ("PUT", "/budgets/spread", "set_budget"),
    # Method-gated: a known path with the wrong method reaches no route.
    ("POST", "/transactions/feed", None),
    ("GET", "/nope", None),
]


# [A1]
@pytest.mark.parametrize("method, path, expected", _DISPATCH)
def test_each_method_and_path_reaches_its_route_function(handler, monkeypatch, method, path, expected):
    for name in _REPOSITORIES:
        monkeypatch.setattr(handler, name, lambda: object())
    called = []
    targets = {target for _method, _path, target in _DISPATCH if target}
    for target in targets:
        monkeypatch.setattr(
            handler, target,
            lambda *args, _target=target, **kwargs: called.append(_target) or {"statusCode": 299})

    event = api_event(method, path)
    resp = handler.lambda_handler(event, None)

    if expected is None:
        assert resp["statusCode"] == 404 and called == []
        return
    assert called == [expected]


def _chat_start(handler, job_repo):
    event = {"body": json.dumps({"messages": [{"role": "user", "text": "How much on coffee?"}]})}
    return handler.start_ai_chat_job(event, job_repo)


def _apply_rules_start(handler, job_repo):
    _, _, rule_repo = real_repos()
    return handler.start_apply_rules_job({"body": "{}"}, FakeCategoryRepo(frozenset()), rule_repo, job_repo)


# [A2]
@pytest.mark.parametrize("start, poll, error_text", [
    (_chat_start, "get_ai_chat_job", "could not start the chat"),
    (_apply_rules_start, "get_apply_rules_job", "could not start the job"),
])
def test_a_job_whose_worker_cannot_start_polls_as_failed_with_its_own_error(
        handler, monkeypatch, start, poll, error_text):
    monkeypatch.setattr(handler, "_invoke_worker", throttled_worker)
    job_repo = real_job_repo()

    resp = start(handler, job_repo)
    [(job_id, _kind)] = created_jobs(job_repo)
    polled = getattr(handler, poll)({"pathParameters": {"id": job_id}}, job_repo)

    assert resp["statusCode"] == 502 and json.loads(resp["body"]) == {"error": error_text}
    assert polled["statusCode"] == 200
    body = json.loads(polled["body"])
    assert body["status"] == "failed" and body["error"] == error_text


# [A3]
def test_the_apply_rules_poll_still_reads_a_job_of_any_kind(handler):
    job_repo = real_job_repo({"c1": {"id": "c1", "kind": "ai_chat", "status": "running"}})
    resp = handler.get_apply_rules_job({"pathParameters": {"id": "c1"}}, job_repo)
    assert resp["statusCode"] == 200 and json.loads(resp["body"])["jobId"] == "c1"


# [A5]
def test_a_chat_poll_read_error_is_500_not_404(handler):
    class _Boom:
        def get_job(self, job_id):
            raise handler.DatabaseError("db down")

    assert handler.get_ai_chat_job({"pathParameters": {"id": "j1"}}, _Boom())["statusCode"] == 500
