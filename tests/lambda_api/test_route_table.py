"""WHIT-791: the handler dispatches fixed paths through one (method, path) table.

API Gateway's fixed-path route keys (no `{id}` placeholder) and the table must match both ways:
a key the table lacks 404s inside the Lambda, a table entry the gateway lacks 404s at the gateway.
This test is the only check in both directions.
"""

import json

import pytest
from _api_event import api_event
from _feed_fakes import FakeCategoryRepo, real_repos
from _job_fakes import created_jobs, real_job_repo, throttled_worker
from _terraform import app_route_keys, exact_route_keys


def test_route_table_answers_exactly_the_fixed_paths_api_gateway_declares(handler):
    table_routes = exact_route_keys(handler)
    gateway_fixed_routes = {key for key in app_route_keys() if "{" not in key}

    assert "GET /transactions/feed" in gateway_fixed_routes
    assert table_routes == gateway_fixed_routes


@pytest.mark.parametrize("key", [
    "PUT /budgets/{category}/spread",
    "DELETE /budgets/{category}/spread",
    "PUT /rules/{id}",
    "DELETE /rules/{id}",
    "DELETE /transactions/{id}",
])
def test_placeholder_routes_are_declared_in_api_gateway(key):
    # The handler matches these by prefix, so the fixed-path check above can't derive them: a
    # route that works in tests would 404 at the deployed gateway without its key (WHIT-506).
    assert key in app_route_keys()


_REPOSITORIES = [
    "AccountBalanceRepository", "BudgetRepository", "CategoryRepository", "DeviceRepository",
    "GoalsRepository", "InsightRepository", "JobRepository",
    "LoanFactsRepository", "MilestoneRepository", "NotifyRepository", "PayCycleRepository",
    "RuleRepository", "TransactionRepository",
]

# (method, path, the route function it must reach; None = 404, nothing called)
_DISPATCH = [
    ("GET", "/transactions", "get_recent_transactions"),
    ("GET", "/transactions/feed", "get_transactions_feed"),
    ("GET", "/transactions/search", "get_transactions_search"),
    ("GET", "/transactions/uncategorized/count", "get_uncategorized_count"),
    ("GET", "/transactions/uncategorized/feed", "get_uncategorized_feed"),
    ("GET", "/transactions/uncategorized/merchants", "get_uncategorized_merchants"),
    ("PATCH", "/transactions", "patch_transactions_batch"),
    ("PATCH", "/transactions/t1", "patch_transaction"),
    ("GET", "/categories/c1/transactions", "get_category_transactions"),
    ("PUT", "/budgets/c1/spread", "set_spread"),
    # A category whose id is literally "spread" is a budget item, not a spread.
    ("PUT", "/budgets/spread", "set_budget"),
    # Method-gated: a known path with the wrong method reaches no route.
    ("POST", "/transactions/feed", None),
    ("GET", "/nope", None),
]


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


def test_a_chat_poll_read_error_is_500_not_404(handler):
    class _Boom:
        def get_job(self, job_id):
            raise handler.DatabaseError("db down")

    assert handler.get_ai_chat_job({"pathParameters": {"id": "j1"}}, _Boom())["statusCode"] == 500
