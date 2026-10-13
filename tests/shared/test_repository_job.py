"""Tests for shared/repository_job.py — the async apply-rules job store (WHIT-537).

Run against the real conftest FakeTable so the create/update/get round-trips are exercised for
real. The behaviour that matters: a fresh job is `running` with zeroed tallies; progress merges
counts without touching status; finish stamps a terminal status + completed_at; and the TTL
attribute is a NUMERIC epoch, not an isoformat string (a string would never expire — WHIT-54).
"""


def test_expires_at_is_a_numeric_epoch_not_an_iso_string(job_repo):
    # FAIL-ON-REVERT for the TTL: DynamoDB only expires a NUMERIC epoch-seconds attribute. If
    # expires_at were written as an isoformat string (like created_at/updated_at), the row would
    # never expire and finished jobs would accumulate forever. Assert it is an int far in the
    # future (about a day out), not a string.
    from repository_job import JOB_TTL_SECONDS
    import time
    item = job_repo.create_job("job1")
    assert isinstance(item["expires_at"], int)
    assert item["expires_at"] >= int(time.time()) + JOB_TTL_SECONDS - 5


def test_get_job_returns_the_row_and_none_for_a_miss(job_repo):
    job_repo.create_job("job1")
    assert job_repo.get_job("job1")["id"] == "job1"
    assert job_repo.get_job("nope") is None


def test_update_progress_merges_counts_and_keeps_status_running(job_repo):
    job_repo.create_job("job1")
    job_repo.update_progress("job1", {"matched": 500, "attempted": 120, "filed": 118,
                                      "failed": 2, "remaining": 380})
    row = job_repo.get_job("job1")
    assert row["matched"] == 500 and row["attempted"] == 120 and row["filed"] == 118
    assert row["failed"] == 2 and row["remaining"] == 380
    assert row["status"] == "running"          # progress never flips status
    assert row["completed_at"] is None


def test_finish_job_marks_terminal_with_final_counts_and_completed_at(job_repo):
    job_repo.create_job("job1")
    job_repo.finish_job("job1", "succeeded",
                        {"matched": 10, "attempted": 10, "filed": 9, "vanished": 1, "remaining": 0},
                        created_rule={"id": "r1", "categoryId": "groceries"})
    row = job_repo.get_job("job1")
    assert row["status"] == "succeeded"
    assert row["filed"] == 9 and row["vanished"] == 1 and row["remaining"] == 0
    assert row["createdRule"] == {"id": "r1", "categoryId": "groceries"}
    assert row["error"] is None
    assert row["completed_at"] is not None


def test_finish_job_failed_carries_the_error(job_repo):
    job_repo.create_job("job1")
    job_repo.finish_job("job1", "failed", {}, error="boom")
    row = job_repo.get_job("job1")
    assert row["status"] == "failed" and row["error"] == "boom"
    assert row["completed_at"] is not None


def test_set_tool_status_writes_the_status_line_and_keeps_running(job_repo):
    job_repo.create_job("chat1", kind="ai_chat")
    job_repo.set_tool_status("chat1", "Looking at Eating Out, last 3 cycles…")
    row = job_repo.get_job("chat1")
    assert row["toolStatus"] == "Looking at Eating Out, last 3 cycles…"
    assert row["status"] == "running" and row["completed_at"] is None


def test_finish_chat_job_stores_the_reply_as_json_text(job_repo):
    # boto3 refuses Python floats, and the reply carries float amounts — so it is stored as a
    # JSON string. FAIL-ON-REVERT: storing the dict would put floats into DynamoDB.
    job_repo.create_job("chat1", kind="ai_chat")
    job_repo.finish_chat_job("chat1", "succeeded", '{"text": "You spent **$31.11**.", "card": {"value": 31.11}}')
    row = job_repo.get_job("chat1")
    assert row["status"] == "succeeded"
    assert isinstance(row["reply"], str) and '"value": 31.11' in row["reply"]
    assert row["error"] is None and row["completed_at"] is not None
