"""Tests for the per-account balances read endpoint (GET /accounts/balances) and
its handler `get_account_balances` (WHIT-212).

Handler-level tests inject a FakeAccountBalanceRepo directly. The route test drives
`lambda_handler` with the repo class monkeypatched, proving the dispatch wiring and
the DecimalEncoder JSON shaping (signed Decimal amounts -> JSON numbers, null kept).
"""

import json
from decimal import Decimal
from types import SimpleNamespace

import pytest


class FakeAccountBalanceRepo:
    """Handler-level stand-in for AccountBalanceRepository."""

    def __init__(self, rows=None):
        self._rows = rows or []
        self.list_calls = []

    def list_balances(self, account_ids):
        self.list_calls.append(list(account_ids))
        return self._rows


# --- get_account_balances (unit) ---------------------------------------------


def test_get_account_balances_asks_for_the_known_internal_ids(handler):
    repo = FakeAccountBalanceRepo()
    handler.get_account_balances(repo)
    # Queries the app's known accounts (ACCOUNT_ID_MAP's internal ids), sorted + deduped.
    assert repo.list_calls == [["anz-rewards-black-visa", "up-homeloan", "up-spending",
                                "westpac-altitude-qantas-black"]]


def test_get_account_balances_returns_the_stored_rows(handler):
    rows = [
        {"account_id": "up-spending", "amount": Decimal("96270.59"),
         "available_balance": Decimal("96270.59"), "currency": "AUD",
         "as_of": "2026-07-08T09:32:02.405Z", "account_type": "checking"},
    ]
    assert handler.get_account_balances(FakeAccountBalanceRepo(rows)) == rows


def test_get_account_balances_is_empty_before_any_poll(handler):
    assert handler.get_account_balances(FakeAccountBalanceRepo([])) == []


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

    event = {"rawPath": "/accounts/balances", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    # DecimalEncoder renders the signed amounts (and available_balance) as JSON numbers.
    assert body == [
        {"account_id": "up-homeloan", "amount": -596642.43, "available_balance": 0.0,
         "currency": "AUD", "as_of": "2026-07-08T09:29:49.358Z", "account_type": "mortgage"},
        {"account_id": "anz-rewards-black-visa", "amount": -6492.26, "available_balance": 8171.88,
         "currency": "AUD", "as_of": "2026-07-08T09:32:37.337Z", "account_type": "unknown"},
    ]


def test_route_empty_list_before_any_poll(handler, monkeypatch):
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: FakeAccountBalanceRepo([]))
    event = {"rawPath": "/accounts/balances", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


# --- POST /accounts/balances/refresh (on-demand live refresh) ----------------


class FakeRefreshRepo:
    """Handler-level stand-in supporting the refresh endpoint's throttle + upserts."""

    def __init__(self, rows=None, last=None):
        self._rows = rows or []
        self._last = last
        self.upserts = []
        self.set_calls = []
        self.list_calls = 0

    def get_last_refresh_at(self):
        return self._last

    def set_last_refresh_at(self, now):
        self.set_calls.append(now)
        self._last = now

    def upsert_balance(self, account_id, amount, available_balance, currency, as_of, account_type):
        self.upserts.append((account_id, amount, available_balance, currency, as_of, account_type))

    def list_balances(self, account_ids):
        self.list_calls += 1
        return self._rows


def _ok_payload(amount, account_type):
    return {"success": True, "data": {"amount": amount, "date": "2026-08-11T00:00:00Z",
                                      "currency": "AUD", "accountType": account_type}}


# BankSync getBalance payloads keyed by the source `aid` the handler fans out over.
_LIVE_PAYLOADS = {
    "3zVQJ8Btz_IRmqp78VrQnQ": _ok_payload("96270.59", "checking"),                       # up-spending
    "T6d8ppsYssBDFCwl1qEb0w": _ok_payload("-596642.43", "mortgage"),                     # up-homeloan
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0": _ok_payload("-6492.26", "unknown"),   # anz-rewards-black-visa
    "A3AC9195-9E8D-48B8-86D0-46D130D7F64A": _ok_payload("-230", "unknown"),              # westpac-altitude-qantas-black
}

_REFRESH_EVENT = {"rawPath": "/accounts/balances/refresh", "requestContext": {"http": {"method": "POST"}}}


def _freeze_time(handler, monkeypatch, now):
    monkeypatch.setattr(handler, "time", SimpleNamespace(time=lambda: now))


def _stub_bank(handler, monkeypatch, fetch):
    monkeypatch.setattr(handler, "get_api_key", lambda: "test-key")
    monkeypatch.setattr(handler, "fetch_balance", fetch)


def test_refresh_throttled_returns_stored_without_bank_call(handler, monkeypatch):
    rows = [{"account_id": "up-spending", "amount": Decimal("96270.59"),
             "available_balance": None, "currency": "AUD", "as_of": "d", "account_type": "checking"}]
    repo = FakeRefreshRepo(rows=rows, last=970)  # 30s ago at now=1000 -> within the 60s window
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000)
    calls = []
    _stub_bank(handler, monkeypatch, lambda *a, **k: calls.append(1))

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == [
        {"account_id": "up-spending", "amount": 96270.59, "available_balance": None,
         "currency": "AUD", "as_of": "d", "account_type": "checking"},
    ]
    assert calls == []            # no bank call while throttled
    assert repo.set_calls == []   # and no marker write


def test_refresh_live_fetches_upserts_and_arms_marker(handler, monkeypatch):
    rows = [{"account_id": "up-spending", "amount": Decimal("96270.59"),
             "available_balance": None, "currency": "AUD", "as_of": "2026-08-11T00:00:00Z",
             "account_type": "checking"}]
    repo = FakeRefreshRepo(rows=rows, last=None)  # never refreshed -> live
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000)
    _stub_bank(handler, monkeypatch, lambda bid, aid, key, **kw: _LIVE_PAYLOADS[aid])

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    # Every account was fetched + upserted, under its internal id, with signed amounts.
    upserted = {u[0]: u[1] for u in repo.upserts}
    assert upserted == {
        "up-spending": Decimal("96270.59"),
        "up-homeloan": Decimal("-596642.43"),
        "anz-rewards-black-visa": Decimal("-6492.26"),
        "westpac-altitude-qantas-black": Decimal("-230"),
    }
    assert repo.set_calls == [1000]  # marker armed at now


def test_refresh_partial_failure_upserts_successes_and_returns_200(handler, monkeypatch):
    repo = FakeRefreshRepo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000)

    def fetch(bid, aid, key, **kw):
        if aid == "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0":  # anz account down
            raise OSError("bank unreachable")
        return _LIVE_PAYLOADS[aid]

    _stub_bank(handler, monkeypatch, fetch)

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

    assert resp["statusCode"] == 200  # one account down, the others still refresh
    assert {u[0] for u in repo.upserts} == {"up-spending", "up-homeloan",
                                            "westpac-altitude-qantas-black"}
    assert repo.set_calls == [1000]   # marker armed despite the partial failure


def test_refresh_all_failed_returns_502_without_leaking_details(handler, monkeypatch):
    repo = FakeRefreshRepo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000)
    _stub_bank(handler, monkeypatch, lambda *a, **k: (_ for _ in ()).throw(OSError("secret-key leaked?")))

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

    assert resp["statusCode"] == 502
    assert json.loads(resp["body"]) == {"error": "could not refresh balances"}
    assert repo.upserts == []
    assert repo.set_calls == [1000]  # marker armed so pull-spam during an outage backs off


def test_refresh_normalise_failure_counts_as_a_failed_account(handler, monkeypatch):
    # A getBalance that returns success:false must not upsert that account (BalanceError),
    # but the other accounts still refresh -> 200.
    repo = FakeRefreshRepo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000)

    def fetch(bid, aid, key, **kw):
        if aid == "T6d8ppsYssBDFCwl1qEb0w":  # homeloan reports a failure payload
            return {"success": False, "error": "provider error"}
        return _LIVE_PAYLOADS[aid]

    _stub_bank(handler, monkeypatch, fetch)

    resp = handler.lambda_handler(_REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    assert {u[0] for u in repo.upserts} == {"up-spending", "anz-rewards-black-visa",
                                            "westpac-altitude-qantas-black"}


def test_refresh_accepts_post_with_no_body(handler, monkeypatch):
    # The route takes no request body — a bodyless POST must not 400.
    repo = FakeRefreshRepo(rows=[], last=990)  # throttled path, keeps it bank-free
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    _freeze_time(handler, monkeypatch, 1000)
    _stub_bank(handler, monkeypatch, lambda *a, **k: pytest.fail("should not fetch while throttled"))

    resp = handler.lambda_handler(_REFRESH_EVENT, None)  # no "body" key at all
    assert resp["statusCode"] == 200
