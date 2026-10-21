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
    `data` dict or raise. Every request is logged as (method, path, body). A job check must read
    the job its feed's trigger started."""
    calls = []
    job_ids = {}

    def urlopen(req, timeout=None):
        path = req.full_url.removeprefix("https://api.banksync.io")
        calls.append((req.get_method(), path, req.data))
        feed_id = path.split("/")[3]
        if path.endswith("/sync"):
            data = trigger_reply(feed_id)
            job_ids[feed_id] = data["id"]
            return FakeResponse({"data": data})
        assert path == f"/v1/feeds/{feed_id}/jobs/{job_ids[feed_id]}"
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


def _pull(handler, monkeypatch, clock, urlopen, make_repo=balance_repo):
    """One pull against `urlopen` on a fresh repo with `clock` as the handler's time."""
    monkeypatch.setattr(handler, "AccountBalanceRepository", make_repo)
    monkeypatch.setattr(handler, "get_api_key", lambda: "test-key")
    monkeypatch.setattr(handler, "time", SimpleNamespace(
        time=lambda: clock.now, monotonic=lambda: clock.now, sleep=clock.sleep))
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return handler.lambda_handler(SYNC_EVENT, None)


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
    clock = FakeClock()
    urlopen, calls = fake_bank(trigger_reply, job_reply)

    resp = _pull(handler, monkeypatch, clock, urlopen, make_repo=lambda: repo)

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
    monkeypatch.setattr(handler.feed_sync, "forget_api_key", forgotten.append)
    urlopen, _ = fake_bank(raise_for(401), job("completed"))

    resp = _pull(handler, monkeypatch, FakeClock(), urlopen)

    assert resp["statusCode"] == 502
    assert set(forgotten) == {handler.BANKSYNC_API_KEY_PATH}


def _timed_bank(clock, job_reply, trigger_reply=started):
    """fake_bank that also logs each job check as (seconds since start, feed_id)."""
    urlopen, calls = fake_bank(trigger_reply, job_reply)
    checks = []

    def timed(req, timeout=None):
        if req.get_method() == "GET":
            checks.append((clock.elapsed(), req.full_url.split("/")[5]))
        return urlopen(req, timeout)

    return timed, calls, checks


def spending_done_first_round(feed_id):
    status = "completed" if feed_id == FEEDS[0] else "in_progress"
    return {"status": status, "deliverySummary": {"created": 0}}


def spending_done_second_check():
    """The spending feed finishes (with 1 new transaction) on its 2nd check; the others on their 1st."""
    seen = {}

    def reply(feed_id):
        seen[feed_id] = seen.get(feed_id, 0) + 1
        if feed_id == FEEDS[0] and seen[feed_id] < 2:
            return {"status": "in_progress", "deliverySummary": {"created": 0}}
        return {"status": "completed", "deliverySummary": {"created": int(feed_id == FEEDS[0])}}
    return reply


# [A1] Decision A: 4 checks a pull. Round one (~8s) checks every job; the one left goes at ~16s to
# the spending feed, or to the next unfinished feed once spending has finished.
@pytest.mark.parametrize(
    ("job_reply", "second_round_feed"),
    [(job("in_progress"), FEEDS[0]), (spending_done_first_round, FEEDS[1])],
    ids=["spending-feed-gets-first-pick", "next-unfinished-feed-when-spending-done"],
)
def test_the_check_cap_is_spent_once_per_job_then_on_the_spending_feed(
    handler, monkeypatch, job_reply, second_round_feed,
):
    clock = FakeClock()
    urlopen, calls, checks = _timed_bank(clock, job_reply)

    resp = _pull(handler, monkeypatch, clock, urlopen)

    assert json.loads(resp["body"]) == {"status": "syncing"}
    assert sorted(feed for at, feed in checks if at == 8) == sorted(FEEDS)
    assert [feed for at, feed in checks if at == 16] == [second_round_feed]
    assert len(checks) == MAX_STATUS_CHECKS


# [A2] A job still running at the first check that finishes by the second ends "done", and its new
# transactions still get the webhook grace before the answer.
def test_a_job_that_finishes_on_its_second_check_ends_done(handler, monkeypatch):
    clock = FakeClock()
    urlopen, _, checks = _timed_bank(clock, spending_done_second_check())

    resp = _pull(handler, monkeypatch, clock, urlopen)

    assert json.loads(resp["body"]) == {"status": "done"}
    assert [feed for at, feed in checks if at == 16] == [FEEDS[0]]
    assert clock.elapsed() == 16 + 2


def per_feed_trigger(errors_by_feed):
    def reply(feed_id):
        if feed_id in errors_by_feed:
            raise http_error(errors_by_feed[feed_id])
        return started(feed_id)
    return reply


# [A3] Outcome rules: every feed already syncing → "syncing" with no job checks; one trigger failing
# while the others finish is "done" (critic tweak); a cancelled job is "failed"; paused isn't finished.
@pytest.mark.parametrize(
    ("trigger_reply", "job_reply", "expected_status", "expected_checks"),
    [
        (raise_for(409), job("completed"), "syncing", 0),
        (per_feed_trigger({FEEDS[1]: 500}), job("completed"), "done", 2),
        (per_feed_trigger({FEEDS[1]: 500, FEEDS[2]: 409}), job("completed"), "syncing", 1),
        (started, job("cancelled"), "failed", 3),
        (started, job("paused"), "syncing", MAX_STATUS_CHECKS),
    ],
    ids=["every-feed-already-syncing", "one-trigger-failed-rest-done", "failed-and-409-and-done",
         "job-cancelled", "job-paused"],
)
def test_pull_outcome_rules(handler, monkeypatch, trigger_reply, job_reply, expected_status, expected_checks):
    urlopen, calls = fake_bank(trigger_reply, job_reply)

    resp = _pull(handler, monkeypatch, FakeClock(), urlopen)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"status": expected_status}
    assert len([c for c in calls if c[0] == "GET"]) == expected_checks


# [A4] The pull's cooldown has its own marker: a balance refresh a second ago must not skip the
# bank sync, and the sync must not touch the balance-refresh throttle.
def test_the_bank_sync_cooldown_is_separate_from_the_balance_refresh_throttle(handler, monkeypatch):
    clock = FakeClock()
    repo = balance_repo(last=int(clock.now) - 1)
    urlopen, _ = fake_bank(started, job("completed"))

    resp = _pull(handler, monkeypatch, clock, urlopen, make_repo=lambda: repo)

    assert json.loads(resp["body"]) == {"status": "done"}
    assert repo.get_last_refresh_at() == int(clock.start) - 1
    assert repo.get_last_bank_sync_at() == int(clock.start)
