"""ABU-43: the server's replies match the shared samples the app's tests read.

tests/fixtures/api_response_contract.json holds the reply words the app acts on. These tests
prove the REAL handler and repository produce them; src/__tests__/persistCategoryBatch.logic.test.ts
proves the app reads them. Renaming a word on only one side turns one of the suites red.
"""

import json
import pathlib

from _api_event import api_event
from _feed_fakes import _row, real_repos

_FIXTURE = json.loads(
    (pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "api_response_contract.json").read_text()
)


def test_batch_category_reply_matches_the_shared_sample(handler):
    sample = _FIXTURE["batchCategory"]
    rows = [_row(seed["account_id"], "2026-07-01", seed["transaction_id"]) for seed in sample["seed"]]
    _, transaction_repo, _ = real_repos({"a": rows})

    response = handler.patch_transactions_batch(
        api_event("PATCH", "/transactions", body=sample["request"]), transaction_repo
    )

    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == sample["response"]


def test_job_status_words_match_the_shared_sample(handler):
    import repository_job

    assert {
        "running": repository_job.STATUS_RUNNING,
        "succeeded": repository_job.STATUS_SUCCEEDED,
        "failed": repository_job.STATUS_FAILED,
    } == _FIXTURE["jobStatuses"]
