"""WHIT-791 QA: the (method, path) route table and the shared job helpers.

Every route the old if-chain answered must still reach the same route function, method-gated, with
the spread route ahead of the budget item route, and anything else 404s. The shared job helpers must
keep each job type's failure text and the apply-rules poll's any-kind read.
"""

import json

import pytest

from _feed_fakes import FakeCategoryRepo, real_repos
from _job_fakes import created_jobs, real_job_repo

_REPOSITORIES = [
    "AccountBalanceRepository", "BudgetRepository", "CategoryRepository", "DeviceRepository",
    "GoalsRepository", "HomeLoanBalanceRepository", "InsightRepository", "JobRepository",
    "LoanFactsRepository", "MilestoneRepository", "NotifyRepository", "PayCycleRepository",
    "RuleRepository", "TransactionRepository",
]

# (method, path, the route function it must reach; None = 404, nothing called)
_DISPATCH = [
    ("GET", "/transactions", "get_recent_transactions"),
    ("PATCH", "/transactions", "patch_transactions_batch"),
    ("GET", "/transactions/feed", "get_transactions_feed"),
    ("GET", "/transactions/uncategorized/count", "get_uncategorized_count"),
    ("GET", "/transactions/uncategorized/feed", "get_uncategorized_feed"),
    ("GET", "/transactions/uncategorized/merchants", "get_uncategorized_merchants"),
    ("GET", "/transactions/filing-suggestions", "get_filing_suggestions"),
    ("GET", "/transactions/search", "get_transactions_search"),
    ("GET", "/transactions/cycle", "get_cycle_transactions"),
    ("POST", "/transactions/uncategorized/apply-rules", "apply_rules_to_uncategorized"),
    ("POST", "/transactions/uncategorized/apply-rules/jobs", "start_apply_rules_job"),
    ("GET", "/transactions/uncategorized/apply-rules/jobs/j1", "get_apply_rules_job"),
    ("PATCH", "/transactions/t1", "patch_transaction"),
    ("DELETE", "/transactions/t1", "delete_transaction"),
    ("GET", "/categories", "list_categories"),
    ("POST", "/categories", "create_category"),
    ("GET", "/categories/c1/transactions", "get_category_transactions"),
    ("PATCH", "/categories/c1", "update_category"),
    ("DELETE", "/categories/c1", "delete_category"),
    ("GET", "/budgets", "list_budgets"),
    ("GET", "/budgets/c1/transactions", "get_budget_transactions"),
    ("PUT", "/budgets/c1/spread", "set_spread"),
    ("DELETE", "/budgets/c1/spread", "delete_spread"),
    ("PUT", "/budgets/c1", "set_budget"),
    ("DELETE", "/budgets/c1", "delete_budget"),
    # A category whose id is literally "spread" is a budget item, not a spread.
    ("PUT", "/budgets/spread", "set_budget"),
    ("DELETE", "/budgets/spread", "delete_budget"),
    ("GET", "/breakdown", "list_category_breakdown"),
    ("GET", "/insights/ai", "get_ai_insights"),
    ("POST", "/insights/ai", "generate_ai_insights"),
    ("POST", "/ai/chat", "start_ai_chat_job"),
    ("GET", "/ai/chat/jobs/j1", "get_ai_chat_job"),
    ("GET", "/homeloan", "get_homeloan"),
    ("GET", "/accounts/balances", "get_account_balances"),
    ("POST", "/accounts/balances/refresh", "refresh_account_balances"),
    ("GET", "/repayment", "get_repayment"),
    ("GET", "/loanfacts", "get_loanfacts"),
    ("PUT", "/loanfacts", "set_loanfacts"),
    ("GET", "/milestones", "get_milestones"),
    ("PUT", "/milestones", "set_milestones"),
    ("GET", "/paycycle", "get_paycycle_view"),
    ("PUT", "/paycycle", "set_paycycle"),
    ("GET", "/goals", "list_goals"),
    ("PUT", "/goals/g1", "upsert_goal"),
    ("DELETE", "/goals/g1", "delete_goal"),
    ("GET", "/rules", "list_rules_route"),
    ("POST", "/rules", "create_rule_route"),
    ("PUT", "/rules/r1", "update_rule_route"),
    ("DELETE", "/rules/r1", "delete_rule_route"),
    ("POST", "/devices", "register_device"),
    # Method-gated and prefix-exact: none of these reach a route.
    ("POST", "/transactions/feed", None),
    ("GET", "/transactions/t1", None),
    ("POST", "/budgets/c1", None),
    ("GET", "/categories/c1", None),
    ("GET", "/ai/chat/jobs", None),
    ("GET", "/ai/chat", None),
    ("PUT", "/goals", None),
    ("GET", "/devices", None),
    ("GET", "/nope", None),
    ("", "", None),
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

    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    resp = handler.lambda_handler(event, None)

    if expected is None:
        assert resp["statusCode"] == 404 and called == []
        return
    assert called == [expected]


def _throttled(function_env_var, payload):
    raise RuntimeError("throttled")


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
    monkeypatch.setattr(handler, "_invoke_worker", _throttled)
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


# [A4]
@pytest.mark.parametrize("event", [{}, {"pathParameters": None}, {"pathParameters": {"id": ""}}])
def test_a_chat_poll_with_no_job_id_is_404_without_a_read(handler, event):
    class _NoRead:
        def get_job(self, job_id):
            pytest.fail("read a job with no id")

    assert handler.get_ai_chat_job(event, _NoRead())["statusCode"] == 404


# [A5]
def test_a_chat_poll_read_error_is_500_not_404(handler):
    class _Boom:
        def get_job(self, job_id):
            raise handler.DatabaseError("db down")

    assert handler.get_ai_chat_job({"pathParameters": {"id": "j1"}}, _Boom())["statusCode"] == 500
