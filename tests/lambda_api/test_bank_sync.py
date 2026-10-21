"""POST /transactions/sync (ABU-106): a pull asks BankSync for new transactions.

Drives `lambda_handler` with BankSync's HTTP (urllib.request.urlopen) and the handler's clock
faked, over the real AccountBalanceRepository (its cooldown marker) on a FakeTable.
"""

import json
import urllib.request
from types import SimpleNamespace

import pytest

from _api_event import api_event
from _balance_fakes import balance_repo
from _http_fakes import FakeResponse, http_error

SYNC_EVENT = api_event("POST", "/transactions/sync")
FEEDS = ("ZDlL4aShYkOd8A3dw8Tb", "LwO4ZvpH5SMBhEkAO2br", "Glb3YbhSmBJCvi97TaJt")
MAX_STATUS_CHECKS = 4
WAIT_PLUS_GRACE_SECONDS = 22


class FakeClock:
    """time.time / time.monotonic that only move when the code sleeps."""

    def __init__(self, now=1000.0):
        self.start = now
        self.now = now

    def sleep(self, seconds):
        self.now += seconds

    def elapsed(self):
        return self.now - self.start


def fake_bank(trigger_reply, job_reply):
    """A BankSync stand-in. ``trigger_reply(feed_id)`` / ``job_reply(feed_id)`` return a payload's
    `data` dict or raise. Every request is logged as (method, path, body)."""
    calls = []

    def urlopen(req, timeout=None):
        path = req.full_url.removeprefix("https://api.banksync.io")
        calls.append((req.get_method(), path, req.data))
        feed_id = path.split("/")[3]
        if path.endswith("/sync"):
            return FakeResponse({"data": trigger_reply(feed_id)})
        return FakeResponse({"data": job_reply(feed_id)})

    return urlopen, calls


def started(feed_id):
    return {"id": f"job-{feed_id}"}


def job(status, created=0):
    return lambda feed_id: {"status": status, "deliverySummary": {"created": created}}


def raise_for(code, only_feed=None):
    def reply(feed_id):
        if only_feed is None or feed_id == only_feed:
            raise http_error(code)
        return started(feed_id)
    return reply


def first_feed_fails(feed_id):
    status = "failed" if feed_id == FEEDS[0] else "completed"
    return {"status": status, "deliverySummary": {"created": 0}}


def rate_limited(feed_id):
    raise http_error(429)


@pytest.mark.parametrize(
    ("trigger_reply", "job_reply", "expected_code", "expected_status"),
    [
        (started, job("completed"), 200, "done"),
        (started, job("completed", created=2), 200, "done"),
        (raise_for(409, only_feed=FEEDS[1]), job("completed"), 200, "syncing"),
        (started, first_feed_fails, 200, "failed"),
        (started, job("in_progress"), 200, "syncing"),
        (started, rate_limited, 200, "syncing"),
        (raise_for(500), job("completed"), 502, None),
    ],
    ids=["all-completed", "completed-with-new-transactions", "one-already-syncing", "one-job-failed",
         "bank-too-slow", "status-check-rate-limited", "every-trigger-failed"],
)
def test_pull_syncs_every_feed_within_budget_then_cools_down(
    handler, monkeypatch, trigger_reply, job_reply, expected_code, expected_status,
):
    repo = balance_repo()
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    monkeypatch.setattr(handler, "get_api_key", lambda: "test-key")
    clock = FakeClock()
    monkeypatch.setattr(handler, "time", SimpleNamespace(
        time=lambda: clock.now, monotonic=lambda: clock.now, sleep=clock.sleep))
    urlopen, calls = fake_bank(trigger_reply, job_reply)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    resp = handler.lambda_handler(SYNC_EVENT, None)

    assert resp["statusCode"] == expected_code
    body = json.loads(resp["body"])
    if expected_status is None:
        assert "error" in body
    else:
        assert body == {"status": expected_status}
    triggers = [(path, data) for method, path, data in calls if method == "POST"]
    assert sorted(triggers) == sorted((f"/v1/feeds/{fid}/sync", b"") for fid in FEEDS)  # incremental, no force-cancel
    assert len([c for c in calls if c[0] == "GET"]) <= MAX_STATUS_CHECKS
    assert clock.elapsed() <= WAIT_PLUS_GRACE_SECONDS

    # A second pull straight away skips BankSync entirely.
    bank_calls_before = len(calls)
    again = handler.lambda_handler(SYNC_EVENT, None)
    assert again["statusCode"] == 200
    assert json.loads(again["body"]) == {"status": "cooldown"}
    assert len(calls) == bank_calls_before

    # Once the 2-minute cooldown has passed, a pull syncs again.
    clock.now += 120
    handler.lambda_handler(SYNC_EVENT, None)
    assert len([c for c in calls[bank_calls_before:] if c[0] == "POST"]) == len(FEEDS)


def _pull(handler, monkeypatch, clock, urlopen):
    """One pull against `urlopen` on a fresh repo with `clock` as the handler's time."""
    monkeypatch.setattr(handler, "AccountBalanceRepository", balance_repo)
    monkeypatch.setattr(handler, "get_api_key", lambda: "test-key")
    monkeypatch.setattr(handler, "time", SimpleNamespace(
        time=lambda: clock.now, monotonic=lambda: clock.now, sleep=clock.sleep))
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return handler.lambda_handler(SYNC_EVENT, None)


def test_a_slow_job_check_never_runs_past_the_wait_deadline(handler, monkeypatch):
    clock = FakeClock()
    check_ends = []

    def urlopen(req, timeout=None):
        if req.get_method() == "POST":
            return FakeResponse({"data": {"id": "job"}})
        check_ends.append(clock.now + timeout)
        raise TimeoutError("timed out")  # the bank sat on the check until its time limit

    resp = _pull(handler, monkeypatch, clock, urlopen)

    assert json.loads(resp["body"]) == {"status": "syncing"}
    assert check_ends and max(check_ends) <= clock.start + 20


def test_the_webhook_grace_is_spent_only_when_the_bank_reports_new_transactions(handler, monkeypatch):
    elapsed = {}
    for created in (0, 3):
        clock = FakeClock()
        urlopen, _ = fake_bank(started, job("completed", created=created))
        _pull(handler, monkeypatch, clock, urlopen)
        elapsed[created] = clock.elapsed()

    assert elapsed[3] - elapsed[0] == 2


def test_a_rejected_key_is_forgotten_so_the_next_pull_rereads_it(handler, monkeypatch):
    forgotten = []
    monkeypatch.setattr(handler, "forget_api_key", forgotten.append)
    urlopen, _ = fake_bank(raise_for(401), job("completed"))

    resp = _pull(handler, monkeypatch, FakeClock(), urlopen)

    assert resp["statusCode"] == 502
    assert set(forgotten) == {handler.BANKSYNC_API_KEY_PATH}
