"""Tests for the async apply-rules job routes (WHIT-537):
  POST /transactions/uncategorized/apply-rules/jobs  — start a background sweep (202 + jobId)
  GET  /transactions/uncategorized/apply-rules/jobs/{id} — poll its status

The POST validates the request synchronously (so a bad rule never spawns a worker), writes a job
row, and async-invokes the worker. The safety-critical property: the invoke is InvocationType
"Event" (fire-and-return) so the POST returns well inside the 30s gateway window.
"""

import json

import pytest

from _feed_fakes import FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _rule(value, category_id="groceries", rule_id="r1"):
    return {"id": rule_id, "field": "description", "operator": "contains", "value": value,
            "category_id": category_id}


def _post_event(body=None):
    event = {
        "rawPath": "/transactions/uncategorized/apply-rules/jobs",
        "requestContext": {"http": {"method": "POST"}},
    }
    if body is not None:
        event["body"] = json.dumps(body)
    return event


def _get_event(job_id):
    return {
        "rawPath": f"/transactions/uncategorized/apply-rules/jobs/{job_id}",
        "requestContext": {"http": {"method": "GET"}},
        "pathParameters": {"id": job_id},
    }


class FakeJobRepo:
    """In-memory job store recording creates / progress / finishes."""

    def __init__(self, jobs=None):
        self.jobs = dict(jobs or {})
        self.created = []
        self.finished = []

    def create_job(self, job_id, kind="apply_rules"):
        item = {"id": job_id, "kind": kind, "status": "running",
                "matched": 0, "attempted": 0, "filed": 0, "vanished": 0,
                "failed": 0, "alreadyFiled": 0, "remaining": 0,
                "createdRule": None, "error": None,
                "created_at": "t0", "updated_at": "t0", "completed_at": None}
        self.jobs[job_id] = item
        self.created.append(job_id)
        return item

    def get_job(self, job_id):
        return self.jobs.get(job_id)

    def update_progress(self, job_id, counts):
        self.jobs.setdefault(job_id, {"id": job_id}).update(counts)

    def finish_job(self, job_id, status, counts, created_rule=None, error=None):
        self.finished.append((job_id, status, error))
        self.jobs.setdefault(job_id, {"id": job_id}).update(
            {"status": status, "error": error, "createdRule": created_rule, **counts})


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
    return handler.start_apply_rules_job(
        _post_event(body), FakeCategoryRepo(categories),
        FakeRuleRepo(rules=list(rules)), job_repo)


# --- POST: start a job --------------------------------------------------------


def test_post_starts_a_job_and_async_invokes_the_worker(handler, worker_env):
    job_repo = FakeJobRepo()
    resp = _start(handler, job_repo, {})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 202
    assert body["status"] == "running" and body["jobId"]
    assert job_repo.created == [body["jobId"]]
    assert len(worker_env.calls) == 1
    # FAIL-ON-REVERT: a synchronous "RequestResponse" invoke would wait out the whole sweep and
    # blow the 30s gateway budget — the async job's entire reason to exist.
    assert worker_env.calls[0]["InvocationType"] == "Event"
    assert worker_env.calls[0]["FunctionName"] == "abundo-apply-rules-worker"
    payload = json.loads(worker_env.calls[0]["Payload"])
    assert payload == {"jobId": body["jobId"]}


def test_post_with_an_inline_rule_passes_it_in_the_payload(handler, worker_env):
    job_repo = FakeJobRepo()
    resp = _start(handler, job_repo, {"rule": {"value": "COLES", "categoryId": "groceries"}})
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 202
    payload = json.loads(worker_env.calls[0]["Payload"])
    assert payload["jobId"] == body["jobId"]
    assert payload["rule"] == {"value": "COLES", "categoryId": "groceries"}


def test_post_rejects_a_bad_inline_rule_without_spawning_a_worker(handler, worker_env):
    job_repo = FakeJobRepo()
    # A value below the alphanumeric floor would file too broadly — rejected 400.
    resp = _start(handler, job_repo, {"rule": {"value": "a", "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert job_repo.created == []          # FAIL-ON-REVERT: a validation slip spawns a worker on bad input
    assert worker_env.calls == []


def test_post_refuses_a_clashing_inline_rule(handler, worker_env):
    job_repo = FakeJobRepo()
    # An existing "COLES -> coffee" rule fights an inline "COLES -> groceries" over the same charges.
    resp = _start(handler, job_repo, {"rule": {"value": "COLES", "categoryId": "groceries"}},
                  rules=[_rule("COLES", category_id="coffee")])

    assert resp["statusCode"] == 409
    assert json.loads(resp["body"])["existingRule"]["categoryId"] == "coffee"
    assert job_repo.created == [] and worker_env.calls == []


def test_post_rejects_a_missing_body(handler, worker_env):
    job_repo = FakeJobRepo()
    resp = handler.start_apply_rules_job(
        _post_event(), FakeCategoryRepo({"groceries"}), FakeRuleRepo(rules=[]), job_repo)

    assert resp["statusCode"] == 400
    assert job_repo.created == [] and worker_env.calls == []


def test_post_returns_502_and_fails_the_job_when_the_invoke_cannot_be_dispatched(handler, worker_env, monkeypatch):
    def throttled(payload):
        raise RuntimeError("throttled")
    monkeypatch.setattr(handler, "_invoke_apply_rules_worker", throttled)
    job_repo = FakeJobRepo()
    resp = _start(handler, job_repo, {})

    assert resp["statusCode"] == 502
    assert len(job_repo.created) == 1
    # The job it created is marked failed so a poll sees it end, not hang at "running".
    assert job_repo.finished and job_repo.finished[0][1] == "failed"


def test_post_returns_500_when_the_job_row_cannot_be_written(handler, worker_env):
    job_repo = FakeJobRepo()

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
    job_repo = FakeJobRepo(jobs={"job1": stored})
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
    job_repo = FakeJobRepo(jobs={"job2": stored})
    body = json.loads(handler.get_apply_rules_job(_get_event("job2"), job_repo)["body"])
    assert body["status"] == "succeeded" and body["filed"] == 3 and body["remaining"] == 0
    assert body["createdRule"] == {"id": "r1", "categoryId": "groceries"}
    assert body["completedAt"] == "t2"


def test_get_unknown_job_is_404(handler):
    resp = handler.get_apply_rules_job(_get_event("nope"), FakeJobRepo())
    assert resp["statusCode"] == 404


def test_get_missing_id_is_404(handler):
    event = {"rawPath": "/transactions/uncategorized/apply-rules/jobs/",
             "requestContext": {"http": {"method": "GET"}}, "pathParameters": None}
    resp = handler.get_apply_rules_job(event, FakeJobRepo())
    assert resp["statusCode"] == 404
