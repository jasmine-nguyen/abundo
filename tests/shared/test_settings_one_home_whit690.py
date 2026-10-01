"""WHIT-690: the job and push-receipt expiry times, and the filing-habit day floor, live in their
one settings file and are imported from there — no module keeps a local copy to stay
"free" of the settings file any more.

Each write still stamps the same expiry (now + one day); the value now comes from
shared/constants.py. MIN_FILING_HABIT_DAYS is API-only, so it lives in lambda_api/api_constants.py.
"""

import pathlib
import sys
import time

from _ast_bindings import _top_level_binding_list
from _lambda_api_constants import api_constant

_ROOT = pathlib.Path(__file__).resolve().parents[2]
ONE_DAY_SECONDS = 86400


def test_job_store_write_expires_a_day_later_using_the_shared_setting(shared, job_repo):
    constants = sys.modules["constants"]
    assert constants.JOB_TTL_SECONDS == ONE_DAY_SECONDS
    assert "JOB_TTL_SECONDS" not in _top_level_binding_list(_ROOT / "shared" / "repository_job.py")

    before = int(time.time())
    item = job_repo.create_job("job1")
    after = int(time.time())

    assert before + ONE_DAY_SECONDS <= item["expires_at"] <= after + ONE_DAY_SECONDS + 1


def test_push_receipt_write_expires_a_day_later_using_the_shared_setting(shared, monkeypatch):
    constants = sys.modules["constants"]
    assert constants.RECEIPT_TTL_SECONDS == ONE_DAY_SECONDS
    assert "RECEIPT_TTL_SECONDS" not in _top_level_binding_list(
        _ROOT / "shared" / "repository_push_receipt.py")

    class _FakePutTable:
        def __init__(self):
            self.items = []

        def put_item(self, Item):
            self.items.append(Item)

    monkeypatch.setattr(shared.push_receipt.time, "time", lambda: 1_000_000)
    repo = shared.push_receipt.PushReceiptRepository()
    repo._table = _FakePutTable()

    repo.put("rcpt-1", "ExpoPushToken[a]")

    (item,) = repo._table.items
    assert item["expires_at"] == 1_000_000 + ONE_DAY_SECONDS


def test_filing_habit_day_floor_lives_in_the_api_settings_file():
    assert api_constant("MIN_FILING_HABIT_DAYS") == 4
    filing_habits = _ROOT / "lambda_api" / "filing_habits.py"
    assert "MIN_FILING_HABIT_DAYS" not in _top_level_binding_list(filing_habits)
    assert "from api_constants import" in filing_habits.read_text()
