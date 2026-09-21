"""Gap tests for the async apply-rules job GET route (WHIT-537).

The impl suite (test_apply_rules_job.py) covers GET on a running job, a succeeded job, an unknown
id (404) and a missing id (404). The gap: a FAILED job that carries a partial count set AND an
error string — the shape the app shows when a background sweep dies mid-run. `_job_to_client` must
surface the error and the partial counts (camelCase), still 200 (the job exists; only its status
is terminal-failed).
"""

import json

import pytest


class _StubJobRepo:
    def __init__(self, jobs):
        self._jobs = jobs

    def get_job(self, job_id):
        return self._jobs.get(job_id)


def _get_event(job_id):
    return {
        "rawPath": f"/transactions/uncategorized/apply-rules/jobs/{job_id}",
        "requestContext": {"http": {"method": "GET"}},
        "pathParameters": {"id": job_id},
    }


def test_get_reports_a_failed_job_with_its_partial_counts_and_error(handler):
    # [A-G9] A job that failed after filing 120 of 500: 200 OK, status failed, the error string
    # surfaced, and the partial counts mapped to camelCase (remaining still 378, not reset).
    stored = {
        "id": "jobF", "status": "failed", "matched": 500, "attempted": 122,
        "filed": 120, "vanished": 1, "failed": 1, "alreadyFiled": 0, "remaining": 378,
        "createdRule": None, "error": "database temporarily unavailable",
        "created_at": "t0", "updated_at": "t1", "completed_at": "t1",
    }
    resp = handler.get_apply_rules_job(_get_event("jobF"), _StubJobRepo({"jobF": stored}))
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["status"] == "failed"
    # FAIL-ON-REVERT: drop `error` from _job_to_client and a poll can never tell the user WHY it died.
    assert body["error"] == "database temporarily unavailable"
    assert body["filed"] == 120 and body["remaining"] == 378 and body["failed"] == 1
    assert body["completedAt"] == "t1"
    assert body["createdRule"] is None


def test_get_returns_500_when_the_read_raises(handler):
    # [A-G10] A DB fault reading the job row is a 500, not a 404 — a 404 would tell the app the job
    # never existed and stop it polling a job that may still be running.
    class _Boom:
        def get_job(self, job_id):
            raise handler.DatabaseError("db down")

    resp = handler.get_apply_rules_job(_get_event("jobX"), _Boom())
    assert resp["statusCode"] == 500
