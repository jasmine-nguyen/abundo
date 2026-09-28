"""Adversarial edge tests for POST /accounts/balances/refresh (WHIT — live balance
refresh). Gaps the implementer's test_account_balances.py leaves open: the throttle
boundary (< vs <=), the concurrent fan-out actually hitting every source, DB-error
propagation matching the GET, marker-armed-BEFORE-upserts ordering, timeout handling,
and a non-object getBalance payload being a per-account failure (not a total crash).

Reuses the `handler` fixture (tests/lambda_api/conftest.py) and the same fake/stub
pattern as test_account_balances.py.
"""

from types import SimpleNamespace

import pytest

from _balance_fakes import balance_repo, balance_writes, marker_writes, upserted


# --- fakes / stubs (mirror test_account_balances.py) -------------------------


def _ok_payload(amount, account_type="checking"):
    return {"success": True, "data": {"amount": amount, "date": "2026-08-11T00:00:00Z",
                                      "currency": "AUD", "accountType": account_type}}


_LIVE_PAYLOADS = {
    "3zVQJ8Btz_IRmqp78VrQnQ": _ok_payload("96270.59", "checking"),                       # up-spending
    "T6d8ppsYssBDFCwl1qEb0w": _ok_payload("-596642.43", "mortgage"),                     # up-homeloan
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": _ok_payload("-6492.26", "unknown"),   # anz
    "A3AC9195-9E8D-48B8-86D0-46D130D7F64A": _ok_payload("-230", "unknown"),              # westpac
}
_ALL_AIDS = set(_LIVE_PAYLOADS)

_REFRESH_EVENT = {"rawPath": "/accounts/balances/refresh",
                  "requestContext": {"http": {"method": "POST"}}}


def _freeze_time(handler, monkeypatch, now):
    monkeypatch.setattr(handler, "time", SimpleNamespace(time=lambda: now))


def _stub_bank(handler, monkeypatch, fetch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "test-key")
    monkeypatch.setattr(handler, "fetch_balance", fetch)


# --- throttle boundary: < not <= (exactly REFRESH_THROTTLE_SECONDS refreshes) ----


def test_refresh_at_exactly_throttle_window_does_a_live_fetch(handler, monkeypatch):
    # now-last == REFRESH_THROTTLE_SECONDS is NOT throttled: the guard is
    # `< REFRESH_THROTTLE_SECONDS`, so a call exactly on the boundary refreshes.
    window = handler.REFRESH_THROTTLE_SECONDS
    repo = balance_repo(rows=[], last=1000)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000 + window)  # exactly `window` seconds later
    calls = []
    _stub_bank(handler, monkeypatch, lambda bid, aid, key, **kw: (calls.append(aid), _LIVE_PAYLOADS[aid])[1])

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert set(calls) == _ALL_AIDS       # it fetched — not throttled
    assert marker_writes(repo) == [1000 + window]


def test_refresh_one_second_inside_window_is_throttled(handler, monkeypatch):
    # The neighbouring point: now-last == window-1 IS throttled (no bank call, no marker
    # write). Pins the boundary at exactly `window`, not off by one.
    window = handler.REFRESH_THROTTLE_SECONDS
    repo = balance_repo(rows=[], last=1000)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000 + window - 1)
    _stub_bank(handler, monkeypatch, lambda *a, **k: pytest.fail("must not fetch while throttled"))

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert marker_writes(repo) == []          # throttled: marker untouched


# --- concurrent fan-out hits EVERY source (no dedupe / short-circuit) ---------


def test_fan_out_fetches_all_configured_sources(handler, monkeypatch):
    # The endpoint must fetch each configured account exactly once — a dedupe or early-exit
    # bug would silently stop refreshing some accounts. Assert against the real
    # BALANCE_SOURCES so adding/removing a source keeps this honest.
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000)
    fetched = []
    _stub_bank(handler, monkeypatch,
               lambda bid, aid, key, **kw: (fetched.append((bid, aid)), _LIVE_PAYLOADS[aid])[1])

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

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
    _freeze_time(handler, monkeypatch, 1000)
    _stub_bank(handler, monkeypatch, lambda *a, **k: pytest.fail("must not fetch after a repo failure"))

    with pytest.raises(handler.DatabaseError):
        handler.lambda_handler(_REFRESH_EVENT, None)


# --- marker armed BEFORE the upserts (ordering) ------------------------------


def test_marker_is_armed_before_any_upsert(handler, monkeypatch):
    # The throttle marker must be set BEFORE the upsert loop: if an upsert partially
    # fails/raises, the throttle is already armed so pull-spam still backs off, and a crash
    # mid-upsert can't leave the throttle un-armed. Lock the observed order.
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000)
    _stub_bank(handler, monkeypatch, lambda bid, aid, key, **kw: _LIVE_PAYLOADS[aid])

    handler.lambda_handler(_REFRESH_EVENT, None)

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
    _freeze_time(handler, monkeypatch, 1000)

    def fetch(bid, aid, key, **kw):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":
            raise TimeoutError("read timed out")
        return _LIVE_PAYLOADS[aid]

    _stub_bank(handler, monkeypatch, fetch)

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert set(upserted(repo)) == {"up-spending", "anz-rewards-black-visa",
                                            "westpac-altitude-qantas-black"}
    assert marker_writes(repo) == [1000]


def test_all_timeout_returns_502(handler, monkeypatch):
    # Every account timing out -> 502 (all failed), marker still armed.
    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000)
    _stub_bank(handler, monkeypatch,
               lambda *a, **k: (_ for _ in ()).throw(TimeoutError("timed out")))

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

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
    _freeze_time(handler, monkeypatch, 1000)

    def fetch(bid, aid, key, **kw):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":
            return []        # malformed: a JSON array, not the expected object
        return _LIVE_PAYLOADS[aid]

    _stub_bank(handler, monkeypatch, fetch)

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert set(upserted(repo)) == {"up-spending", "anz-rewards-black-visa",
                                            "westpac-altitude-qantas-black"}
    assert marker_writes(repo) == [1000]
