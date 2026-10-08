"""Tests for the async apply-rules job routes (WHIT-537):
  POST /transactions/uncategorized/apply-rules/jobs  — start a background sweep (202 + jobId)
  GET  /transactions/uncategorized/apply-rules/jobs/{id} — poll its status

The POST validates the request synchronously (so a bad rule never spawns a worker), writes a job
row, and async-invokes the worker. The safety-critical property: the invoke is InvocationType
"Event" (fire-and-return) so the POST returns well inside the 30s gateway window.
"""

import json

import pytest

from _api_event import api_event
from _feed_fakes import FakeCategoryRepo, real_repos
from _job_fakes import created_jobs, real_job_repo


def _rule(value, category_id="groceries"):
    # The kwargs of one real RuleRepository.create_rule call.
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id}


def _post_event(body=None):
    return api_event("POST", "/transactions/uncategorized/apply-rules/jobs", body=body)


def _get_event(job_id):
    return api_event(
        "GET",
        f"/transactions/uncategorized/apply-rules/jobs/{job_id}",
        path_params={"id": job_id},
    )


class FakeLambdaClient:
    def __init__(self):
        self.calls = []

    def invoke(self, **kwargs):
        self.calls.append(kwargs)
        return {"StatusCode": 202}


@pytest.fixture
def worker_env(handler, monkeypatch):
    """Point the handler at a named worker + a capturing lambda client."""
    monkeypatch.setenv("APPLY_RULES_WORKER_FUNCTION", "abundo-apply-rules-worker")
    client = FakeLambdaClient()
    monkeypatch.setattr(handler, "_get_lambda_client", lambda: client)
    return client


def _start(handler, job_repo, body, rules=(), categories=frozenset({"groceries", "coffee"})):
    _, _, rule_repo = real_repos(rules=rules)
    return handler.start_apply_rules_job(
        _post_event(body), FakeCategoryRepo(categories), rule_repo, job_repo)


# --- POST: start a job --------------------------------------------------------


def test_post_starts_a_job_and_async_invokes_the_worker(handler, worker_env):
    job_repo = real_job_repo()
    resp = _start(handler, job_repo, {})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 202
    assert body["status"] == "running" and body["jobId"]
    assert created_jobs(job_repo) == [(body["jobId"], "apply_rules")]
    assert len(worker_env.calls) == 1
    # FAIL-ON-REVERT: a synchronous "RequestResponse" invoke would wait out the whole sweep and
    # blow the 30s gateway budget — the async job's entire reason to exist.
    assert worker_env.calls[0]["InvocationType"] == "Event"
    assert worker_env.calls[0]["FunctionName"] == "abundo-apply-rules-worker"
    payload = json.loads(worker_env.calls[0]["Payload"])
    assert payload == {"jobId": body["jobId"]}


def test_post_with_an_inline_rule_passes_it_in_the_payload(handler, worker_env):
    job_repo = real_job_repo()
    resp = _start(handler, job_repo, {"rule": {"value": "COLES", "categoryId": "groceries"}})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 202
    payload = json.loads(worker_env.calls[0]["Payload"])
    assert payload["jobId"] == body["jobId"]
    # The validated inline rule carries the WHIT-558 budgetExcluded flag (default False).
    assert payload["rule"] == {"value": "COLES", "categoryId": "groceries", "budgetExcluded": False}


def test_post_rejects_a_bad_inline_rule_without_spawning_a_worker(handler, worker_env):
    job_repo = real_job_repo()
    # A value below the alphanumeric floor would file too broadly — rejected 400.
    resp = _start(handler, job_repo, {"rule": {"value": "a", "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert created_jobs(job_repo) == []          # FAIL-ON-REVERT: a validation slip spawns a worker on bad input
    assert worker_env.calls == []


def test_post_refuses_a_clashing_inline_rule(handler, worker_env):
    job_repo = real_job_repo()
    # An existing "COLES -> coffee" rule fights an inline "COLES -> groceries" over the same charges.
    resp = _start(handler, job_repo, {"rule": {"value": "COLES", "categoryId": "groceries"}},
                  rules=[_rule("COLES", category_id="coffee")])

    assert resp["statusCode"] == 409
    assert json.loads(resp["body"])["existingRule"]["categoryId"] == "coffee"
    assert created_jobs(job_repo) == [] and worker_env.calls == []


def test_post_rejects_a_missing_body(handler, worker_env):
    job_repo = real_job_repo()
    _, _, rule_repo = real_repos()
    resp = handler.start_apply_rules_job(
        _post_event(), FakeCategoryRepo({"groceries"}), rule_repo, job_repo)

    assert resp["statusCode"] == 400
    assert created_jobs(job_repo) == [] and worker_env.calls == []


def test_post_returns_500_when_the_job_row_cannot_be_written(handler, worker_env):
    job_repo = real_job_repo()

    def boom(job_id, kind="apply_rules"):
        raise handler.DatabaseError("db down")
    job_repo.create_job = boom

    resp = _start(handler, job_repo, {})
    assert resp["statusCode"] == 500
    assert worker_env.calls == []          # never dispatched a worker for a job we couldn't record


# --- GET: poll a job ----------------------------------------------------------


def test_get_returns_the_job_in_client_shape(handler):
    stored = {
        "id": "job1", "status": "running", "matched": 500, "attempted": 120,
        "filed": 118, "vanished": 0, "failed": 2, "alreadyFiled": 0, "remaining": 380,
        "createdRule": None, "error": None,
        "created_at": "t0", "updated_at": "t1", "completed_at": None,
    }
    job_repo = real_job_repo({"job1": stored})
    resp = handler.get_apply_rules_job(_get_event("job1"), job_repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body == {
        "jobId": "job1", "status": "running", "matched": 500, "attempted": 120,
        "filed": 118, "vanished": 0, "failed": 2, "alreadyFiled": 0, "remaining": 380,
        "createdRule": None, "error": None,
        "createdAt": "t0", "updatedAt": "t1", "completedAt": None,
    }


def test_get_reports_a_succeeded_job(handler):
    stored = {"id": "job2", "status": "succeeded", "matched": 3, "attempted": 3, "filed": 3,
              "vanished": 0, "failed": 0, "alreadyFiled": 0, "remaining": 0,
              "createdRule": {"id": "r1", "categoryId": "groceries"}, "error": None,
              "created_at": "t0", "updated_at": "t2", "completed_at": "t2"}
    job_repo = real_job_repo({"job2": stored})
    body = json.loads(handler.get_apply_rules_job(_get_event("job2"), job_repo)["body"])
    assert body["status"] == "succeeded" and body["filed"] == 3 and body["remaining"] == 0
    assert body["createdRule"] == {"id": "r1", "categoryId": "groceries"}
    assert body["completedAt"] == "t2"


def test_get_unknown_job_is_404(handler):
    resp = handler.get_apply_rules_job(_get_event("nope"), real_job_repo())
    assert resp["statusCode"] == 404


def test_get_missing_id_is_404(handler):
    event = api_event("GET", "/transactions/uncategorized/apply-rules/jobs/", path_params=None)
    resp = handler.get_apply_rules_job(event, real_job_repo())
    assert resp["statusCode"] == 404
