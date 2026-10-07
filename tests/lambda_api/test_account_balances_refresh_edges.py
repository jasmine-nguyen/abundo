"""Adversarial edge tests for POST /accounts/balances/refresh (WHIT — live balance
refresh). Gaps the implementer's test_account_balances.py leaves open: the throttle
boundary (< vs <=), the concurrent fan-out actually hitting every source, DB-error
propagation matching the GET, marker-armed-BEFORE-upserts ordering, timeout handling,
and a non-object getBalance payload being a per-account failure (not a total crash).

Reuses the `handler` fixture (tests/lambda_api/conftest.py) and the same fake/stub
pattern as test_account_balances.py.
"""

from decimal import Decimal

import pytest

from _balance_fakes import (
    LIVE_PAYLOADS, REFRESH_EVENT, balance_repo, balance_writes, fetch_all, fetch_all_but_homeloan, freeze_time,
    homeloan_row, marker_writes, milestone_spy, stub_bank, upserted,
)


_ALL_AIDS = set(LIVE_PAYLOADS)


# --- throttle boundary: < not <= (exactly REFRESH_THROTTLE_SECONDS refreshes) ----


def test_refresh_at_exactly_throttle_window_does_a_live_fetch(handler, monkeypatch):
    # now-last == REFRESH_THROTTLE_SECONDS is NOT throttled: the guard is
    # `< REFRESH_THROTTLE_SECONDS`, so a call exactly on the boundary refreshes.
    window = handler.REFRESH_THROTTLE_SECONDS
    repo = balance_repo(rows=[], last=1000)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000 + window)  # exactly `window` seconds later
    calls = []
    stub_bank(handler, monkeypatch, lambda bid, aid, key, **kw: (calls.append(aid), LIVE_PAYLOADS[aid])[1])

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert set(calls) == _ALL_AIDS       # it fetched — not throttled
    assert marker_writes(repo) == [1000 + window]


def test_refresh_one_second_inside_window_is_throttled(handler, monkeypatch):
    # The neighbouring point: now-last == window-1 IS throttled (no bank call, no marker
    # write). Pins the boundary at exactly `window`, not off by one.
    window = handler.REFRESH_THROTTLE_SECONDS
    repo = balance_repo(rows=[], last=1000)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000 + window - 1)
    stub_bank(handler, monkeypatch, lambda *a, **k: pytest.fail("must not fetch while throttled"))

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert marker_writes(repo) == []          # throttled: marker untouched


# --- concurrent fan-out hits EVERY source (no dedupe / short-circuit) ---------


def test_fan_out_fetches_all_configured_sources(handler, monkeypatch):
    # The endpoint must fetch each configured account exactly once — a dedupe or early-exit
    # bug would silently stop refreshing some accounts. Assert against the real
    # BALANCE_SOURCES so adding/removing a source keeps this honest.
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000)
    fetched = []
    stub_bank(handler, monkeypatch,
               lambda bid, aid, key, **kw: (fetched.append((bid, aid)), LIVE_PAYLOADS[aid])[1])

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    expected = {(s["bid"], s["aid"]) for s in handler.BALANCE_SOURCES}
    assert set(fetched) == expected
    assert len(fetched) == len(handler.BALANCE_SOURCES)   # each hit once, none deduped away


# --- DB error propagates (matches the GET), not swallowed as a fake 200/502 --


def test_db_error_reading_marker_propagates(handler, monkeypatch):
    # A DatabaseError from the repo (e.g. reading the throttle marker) is NOT swallowed into
    # a misleading 200/502 — it propagates, exactly like GET /accounts/balances.
    class BoomRepo:
        def get_last_refresh_at(self):
            raise handler.DatabaseError("dynamo down")

    monkeypatch.setattr(handler, "AccountBalanceRepository", BoomRepo)
    freeze_time(handler, monkeypatch, 1000)
    stub_bank(handler, monkeypatch, lambda *a, **k: pytest.fail("must not fetch after a repo failure"))

    with pytest.raises(handler.DatabaseError):
        handler.lambda_handler(REFRESH_EVENT, None)


# --- marker armed BEFORE the upserts (ordering) ------------------------------


def test_marker_is_armed_before_any_upsert(handler, monkeypatch):
    # The throttle marker must be set BEFORE the upsert loop: if an upsert partially
    # fails/raises, the throttle is already armed so pull-spam still backs off, and a crash
    # mid-upsert can't leave the throttle un-armed. Lock the observed order.
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000)
    stub_bank(handler, monkeypatch, fetch_all)

    handler.lambda_handler(REFRESH_EVENT, None)

    kinds = [e[0] for e in balance_writes(repo)]
    assert kinds[0] == "set"                       # marker first
    assert set(kinds[1:]) == {"upsert"}            # then only upserts
    assert balance_writes(repo)[0] == ("set", 1000)


# --- a timed-out worker is a failed account, not a crashed request -----------


def test_timeout_worker_is_treated_as_a_failed_account(handler, monkeypatch):
    # A socket/TimeoutError (an OSError subclass) from one slow account must be swallowed as
    # a per-account failure; the others still refresh -> 200.
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000)

    def fetch(bid, aid, key, **kw):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":
            raise TimeoutError("read timed out")
        return LIVE_PAYLOADS[aid]

    stub_bank(handler, monkeypatch, fetch)

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert set(upserted(repo)) == {"up-spending", "anz-rewards-black-visa",
                                            "westpac-altitude-qantas-black"}
    assert marker_writes(repo) == [1000]


def test_all_timeout_returns_502(handler, monkeypatch):
    # Every account timing out -> 502 (all failed), marker still armed.
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000)
    stub_bank(handler, monkeypatch,
               lambda *a, **k: (_ for _ in ()).throw(TimeoutError("timed out")))

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 502
    assert upserted(repo) == {}
    assert marker_writes(repo) == [1000]


# --- a non-object getBalance payload is a per-account failure, not a crash ----


def test_non_dict_payload_is_a_per_account_failure_not_a_total_crash(handler, monkeypatch):
    # BankSync returning a JSON array/string/number (not an object) for ONE account must be
    # treated like any other failed account: the others still upsert, the response is 200,
    # and the marker is armed. (Regression guard for the isinstance(payload, dict) guard in
    # shared/balance_fetch.py — without it this raises AttributeError and 500s the request.)
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1000)

    def fetch(bid, aid, key, **kw):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":
            return []        # malformed: a JSON array, not the expected object
        return LIVE_PAYLOADS[aid]

    stub_bank(handler, monkeypatch, fetch)

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert set(upserted(repo)) == {"up-spending", "anz-rewards-black-visa",
                                            "westpac-altitude-qantas-black"}
    assert marker_writes(repo) == [1000]


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
