"""Tests for the per-account balances read endpoint (GET /accounts/balances, WHIT-212) and the
on-demand live refresh (POST /accounts/balances/refresh).

The route tests drive `lambda_handler` with the repo class monkeypatched, proving the dispatch
wiring and the JSON shaping (signed Decimal amounts -> JSON numbers, null kept).
"""

import json
import urllib.request
from decimal import Decimal

import pytest

from _api_event import api_event
from _balance_fakes import (
    CHECKPOINT_GOAL, CHECKPOINT_PUSH_TITLE, LIVE_PAYLOADS, REFRESH_EVENT, BrokenGoalsRepo, balance_repo,
    fetch_all, fetch_all_but_homeloan, freeze_time, homeloan_row, marker_writes, milestone_spy, spending_row,
    stub_bank, stub_refresh_side_effects, upserted,
)
from _dynamo_fakes import FakeTable
from _http_fakes import FakeResponse
from _milestone_fakes import FakeGoalsRepo, goal_checkpoint_repo


class FakeAccountBalanceRepo:
    """Handler-level stand-in for AccountBalanceRepository."""

    def __init__(self, rows=None):
        self._rows = rows or []
        self.list_calls = []

    def list_balances(self, account_ids):
        self.list_calls.append(list(account_ids))
        return self._rows


# --- GET /accounts/balances (route) ------------------------------------------


def test_route_serves_signed_balances_as_json_numbers(handler, monkeypatch):
    rows = [
        {"account_id": "up-homeloan", "amount": Decimal("-596642.43"),
         "available_balance": Decimal("0"), "currency": "AUD",
         "as_of": "2026-07-08T09:29:49.358Z", "account_type": "mortgage"},
        {"account_id": "anz-rewards-black-visa", "amount": Decimal("-6492.26"),
         "available_balance": Decimal("8171.88"), "currency": "AUD",
         "as_of": "2026-07-08T09:32:37.337Z", "account_type": "unknown"},
    ]
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: FakeAccountBalanceRepo(rows))

    event = api_event("GET", "/accounts/balances")
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    # The JSON response renders the signed amounts (and available_balance) as JSON numbers.
    assert body == [
        {"account_id": "up-homeloan", "amount": -596642.43, "available_balance": 0.0,
         "currency": "AUD", "as_of": "2026-07-08T09:29:49.358Z", "account_type": "mortgage"},
        {"account_id": "anz-rewards-black-visa", "amount": -6492.26, "available_balance": 8171.88,
         "currency": "AUD", "as_of": "2026-07-08T09:32:37.337Z", "account_type": "unknown"},
    ]


# --- POST /accounts/balances/refresh (on-demand live refresh) ----------------


_STORED_SPENDING = {"account_id": "up-spending", "amount": Decimal("96270.59"),
                    "available_balance": None, "currency": "AUD", "as_of": "d", "account_type": "checking"}


@pytest.mark.parametrize(
    ("seconds_since_last", "throttled"),
    [(30, True), (59, True), (60, False)],
    ids=["well-inside-window", "one-second-inside-window", "exactly-on-window"],
)
def test_refresh_throttled_returns_stored_without_bank_call(handler, monkeypatch, seconds_since_last, throttled):
    # The guard is `< REFRESH_THROTTLE_SECONDS` (60): exactly on the window refreshes live.
    repo = balance_repo(rows=[_STORED_SPENDING], last=1000)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000 + seconds_since_last)
    calls = []
    stub_bank(handler, monkeypatch, lambda bid, aid, key, **kw: (calls.append(aid), LIVE_PAYLOADS[aid])[1])

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    if throttled:
        assert json.loads(resp["body"]) == [
            {"account_id": "up-spending", "amount": 96270.59, "available_balance": None,
             "currency": "AUD", "as_of": "d", "account_type": "checking"},
        ]
        assert calls == []
        assert marker_writes(repo) == []
        return
    assert set(calls) == set(LIVE_PAYLOADS)
    assert marker_writes(repo) == [1000 + seconds_since_last]


def test_refresh_live_fetches_upserts_and_arms_marker(handler, monkeypatch):
    rows = [{"account_id": "up-spending", "amount": Decimal("96270.59"),
             "available_balance": None, "currency": "AUD", "as_of": "2026-08-11T00:00:00Z",
             "account_type": "checking"}]
    repo = balance_repo(rows=rows, last=None)  # never refreshed -> live
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000)
    stub_bank(handler, monkeypatch, fetch_all)

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    # Every account was fetched + upserted, under its internal id, with signed amounts.
    assert upserted(repo) == {
        "up-spending": Decimal("96270.59"),
        "up-homeloan": Decimal("-596642.43"),
        "anz-rewards-black-visa": Decimal("-6492.26"),
        "westpac-altitude-qantas-black": Decimal("-230"),
    }
    assert marker_writes(repo) == [1000]  # marker armed at now


def _raise_unreachable():
    raise OSError("bank unreachable")


@pytest.mark.parametrize(
    "bad_reply",
    [_raise_unreachable, lambda: {"success": False, "error": "provider error"}, lambda: []],
    ids=["fetch-raises", "success-false-payload", "non-object-payload"],
)
def test_refresh_partial_failure_upserts_successes_and_returns_200(handler, monkeypatch, bad_reply):
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000)

    def fetch(bid, aid, key, **kw):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":  # home loan fails
            return bad_reply()
        return LIVE_PAYLOADS[aid]

    stub_bank(handler, monkeypatch, fetch)

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200  # one account down, the others still refresh
    assert set(upserted(repo)) == {"up-spending", "anz-rewards-black-visa", "westpac-altitude-qantas-black"}
    assert marker_writes(repo) == [1000]   # marker armed despite the partial failure


def test_refresh_all_failed_returns_502_without_leaking_details(handler, monkeypatch):
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000)
    stub_bank(handler, monkeypatch, lambda *a, **k: (_ for _ in ()).throw(OSError("secret-key leaked?")))

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 502
    assert json.loads(resp["body"]) == {"error": "could not refresh balances"}
    assert upserted(repo) == {}
    assert marker_writes(repo) == [1000]  # marker armed so pull-spam during an outage backs off


def test_refresh_requests_each_balance_from_banksync_with_the_api_ua_and_timeout(handler, monkeypatch):
    # WHIT-832: through the REAL shared fetch_balance. A stale keyword the shared signature no
    # longer takes (e.g. `base_url=`) would fail every account live.
    requests = []

    def fake_urlopen(req, timeout=None):
        requests.append((req, timeout))
        aid = req.full_url.split("/accounts/")[1].split("/")[0]
        return FakeResponse(LIVE_PAYLOADS[aid])

    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1_000_000)
    stub_bank(handler, monkeypatch, handler.fetch_balance)
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    expected_urls = {
        f"https://api.banksync.io/v1/banks/{source['bid']}/accounts/{source['aid']}/balances"
        for source in handler.BALANCE_SOURCES
    }
    assert {req.full_url for req, _ in requests} == expected_urls
    for req, timeout in requests:
        assert req.get_method() == "GET"
        assert req.get_header("X-api-key") == "test-key"
        assert req.get_header("User-agent") == handler.BANKSYNC_USER_AGENT
        assert timeout == handler.REFRESH_FETCH_TIMEOUT_SECONDS


def test_get_api_key_reads_the_banksync_path(handler, monkeypatch):
    # WHIT-454 landmine: lambda_api reads BOTH the BankSync and Anthropic keys in one process, so
    # the wrong path would fetch the Anthropic key for the balance refresh.
    import api_key
    api_key._cache.clear()  # never inherit a cached key from a sibling test
    calls = []
    monkeypatch.setattr(api_key, "get_param", lambda path: calls.append(path) or "bank-key")

    assert handler.get_api_key() == "bank-key"
    assert calls == [handler.BANKSYNC_API_KEY_PATH]
    assert handler.BANKSYNC_API_KEY_PATH == "/abundo/banksync-api-key"


# --- WHIT-792: the refresh's home-loan milestone check is best-effort ---------


def _refresh_with_milestone_spy(handler, monkeypatch, repo, fetch, milestone_raises):
    """Run one live refresh; return (response, [(old, new)] the milestone helper got)."""
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000)
    stub_bank(handler, monkeypatch, fetch)
    calls = []
    monkeypatch.setattr(handler, "notify_homeloan_milestone", milestone_spy(calls, milestone_raises))
    return handler.lambda_handler(REFRESH_EVENT, None), calls


def _repo_owing(amount):
    return lambda: balance_repo(rows=[homeloan_row(amount)])


def _repo_whose_prior_read_fails():
    """The first list_balances (the prior read) raises; the final response read still succeeds."""
    repo = balance_repo(rows=[homeloan_row("-600000")])
    real_list = repo.list_balances
    reads = []

    def list_balances(account_ids):
        reads.append(account_ids)
        if len(reads) == 1:
            raise RuntimeError("dynamo throttled")
        return real_list(account_ids)

    repo.list_balances = list_balances
    return repo


_NEW_HOMELOAN = Decimal("-596642.43")
_ALL_IDS = {"up-spending", "up-homeloan", "anz-rewards-black-visa", "westpac-altitude-qantas-black"}


@pytest.mark.parametrize(
    ("make_repo", "fetch", "milestone_raises", "expected_calls", "expected_stored"),
    [
        # [A1] The prior balance read fails: still 200, every balance stored, old passed as None.
        (_repo_whose_prior_read_fails, fetch_all, False, [(None, _NEW_HOMELOAN)], _ALL_IDS),
        # [A2] First-ever reading (no stored home-loan row): old is None (the seed guard).
        (lambda: balance_repo(rows=[]), fetch_all, False, [(None, _NEW_HOMELOAN)], _ALL_IDS),
        # [A3] The home-loan fetch fails: the others store, the milestone check never runs.
        (_repo_owing("-600000"), fetch_all_but_homeloan, False, [], _ALL_IDS - {"up-homeloan"}),
        # [A4] The milestone push blows up: the refresh still answers 200 with balances stored.
        (_repo_owing("-600000"), fetch_all, True, [(Decimal("-600000"), _NEW_HOMELOAN)], _ALL_IDS),
        # A repayment seen first by a refresh reaches the milestone check with old and new owed.
        (_repo_owing("-600000"), fetch_all, False, [(Decimal("-600000"), _NEW_HOMELOAN)], _ALL_IDS),
    ],
    ids=["prior-read-fails", "first-ever-reading", "homeloan-fetch-fails", "milestone-push-raises",
         "crossing-reaches-milestone-check"],
)
def test_refresh_home_loan_milestone_check_never_breaks_the_refresh(
    handler, monkeypatch, make_repo, fetch, milestone_raises, expected_calls, expected_stored
):
    repo = make_repo()

    resp, calls = _refresh_with_milestone_spy(handler, monkeypatch, repo, fetch, milestone_raises)

    assert resp["statusCode"] == 200
    assert set(upserted(repo)) == expected_stored
    assert calls == expected_calls


# --- WHIT-802: pull-to-refresh runs the goal-checkpoint check too -------------


def _goals_repo(handler):
    repo = handler.GoalsRepository()
    repo._table = FakeTable()
    repo.upsert_goal("g1", dict(CHECKPOINT_GOAL))
    return repo


@pytest.mark.parametrize(
    ("stored_spending", "last_refresh_at", "refresh_times", "expected_pushes"),
    [
        # 90,000 -> 96,270.59 crosses the 95,000 checkpoint: one push; a later refresh adds none.
        ("90000", None, (10_000, 20_000), [CHECKPOINT_PUSH_TITLE]),
        # 96,000 -> 96,270.59 crosses nothing.
        ("96000", None, (10_000,), []),
        # Throttled: no bank call, no push.
        ("90000", 9_999, (10_000,), []),
    ],
    ids=["crossing-fires-once", "no-crossing", "throttled"],
)
def test_refresh_celebrates_a_goal_checkpoint_crossing_once(
    handler, monkeypatch, stored_spending, last_refresh_at, refresh_times, expected_pushes
):
    accounts = balance_repo(rows=[spending_row(stored_spending)], last=last_refresh_at)
    goals = _goals_repo(handler)
    pushes = []
    bank_calls = []
    stub_bank(handler, monkeypatch, lambda bid, aid, key, **kw: bank_calls.append(aid) or LIVE_PAYLOADS[aid])
    stub_refresh_side_effects(handler, monkeypatch, accounts=accounts, goals=goals,
                              notify=goal_checkpoint_repo(), pushes=pushes)

    assert 20_000 - 10_000 >= handler.REFRESH_THROTTLE_SECONDS
    for now in refresh_times:
        freeze_time(handler, monkeypatch, now)
        assert handler.lambda_handler(REFRESH_EVENT, None)["statusCode"] == 200

    assert pushes == expected_pushes
    if last_refresh_at is not None:
        assert bank_calls == []


@pytest.mark.parametrize(
    ("fetch", "milestone_raises", "goals", "expected_milestone_calls", "expected_pushes"),
    [
        # [A1] Home-loan fetch fails: no milestone check, but the goal check still runs.
        (fetch_all_but_homeloan, False, lambda: FakeGoalsRepo({"g1": dict(CHECKPOINT_GOAL)}), 0,
         [CHECKPOINT_PUSH_TITLE]),
        # [A2] The milestone check raises: the goal check still runs.
        (fetch_all, True, lambda: FakeGoalsRepo({"g1": dict(CHECKPOINT_GOAL)}), 1, [CHECKPOINT_PUSH_TITLE]),
        # [A3] The goal read raises: the milestone check still ran.
        (fetch_all, False, BrokenGoalsRepo, 1, []),
    ],
    ids=["homeloan-fetch-fails", "milestone-raises", "goal-read-raises"],
)
def test_refresh_runs_milestone_and_goal_checks_independently(
    handler, monkeypatch, fetch, milestone_raises, goals, expected_milestone_calls, expected_pushes
):
    accounts = balance_repo(rows=[spending_row("90000")])
    milestone_calls = []
    pushes = []
    stub_bank(handler, monkeypatch, fetch)
    stub_refresh_side_effects(handler, monkeypatch, accounts=accounts, goals=goals(),
                              notify=goal_checkpoint_repo(), pushes=pushes)
    monkeypatch.setattr(handler, "notify_homeloan_milestone", milestone_spy(milestone_calls, milestone_raises))
    freeze_time(handler, monkeypatch, 10_000)

    assert handler.lambda_handler(REFRESH_EVENT, None)["statusCode"] == 200

    assert len(milestone_calls) == expected_milestone_calls
    assert pushes == expected_pushes
