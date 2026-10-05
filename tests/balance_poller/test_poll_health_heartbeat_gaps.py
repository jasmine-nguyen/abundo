"""WHIT-645: the other ways a balance poll can fall short also log no heartbeat.

A failed home-loan read (every account still stored) or a failed API-key fetch must not
emit BALANCE_POLL_ALL_STORED, or the balance-poll alarm would never page for them.
"""

import logging

from _http_fakes import FakeResponse

_HEARTBEAT = "BALANCE_POLL_ALL_STORED"


class _FailingHomeLoanRepo:
    def get_balance(self, account_id):
        return None

    def upsert_balance(self, account_id, balance, as_of, currency):
        raise RuntimeError("DynamoDB unavailable")


class _FakeAccountRepo:
    def list_balances(self, account_ids):
        return []

    def upsert_balance(self, account_id, amount, available_balance, currency, as_of, account_type):
        pass


def _payload(aid, amount, account_type):
    return {"success": True, "data": {
        "date": "2026-09-28T00:00:00.000Z", "accountId": aid, "accountType": account_type,
        "amount": amount, "availableBalance": 0, "currency": "AUD",
    }}


_PAYLOADS_BY_AID = {
    "3zVQJ8Btz_IRmqp78VrQnQ": _payload("3zVQJ8Btz_IRmqp78VrQnQ", 96270.59, "checking"),
    "T6d8ppsYssBDFCwl1qEb0w": _payload("T6d8ppsYssBDFCwl1qEb0w", -596642.43, "mortgage"),
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0":
        _payload("9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0", -6492.26, "unknown"),
    "A3AC9195-9E8D-48B8-86D0-46D130D7F64A":
        _payload("A3AC9195-9E8D-48B8-86D0-46D130D7F64A", -230, "unknown"),
}


def _urlopen(req, timeout=None):
    for aid, payload in _PAYLOADS_BY_AID.items():
        if aid in req.full_url:
            return FakeResponse(payload)
    raise AssertionError(f"no stub payload for {req.full_url}")


def _heartbeat_logged(caplog):
    return any(_HEARTBEAT in r.getMessage() for r in caplog.records)


def test_a_failed_home_loan_read_logs_no_heartbeat_even_when_every_account_stored(handler, monkeypatch, caplog):
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: _FailingHomeLoanRepo())
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: _FakeAccountRepo())
    monkeypatch.setattr(handler.urllib.request, "urlopen", _urlopen)
    caplog.set_level(logging.INFO)

    result = handler.lambda_handler({}, None)

    assert result == {"homeloan_stored": False, "accounts_stored": 4}
    assert not _heartbeat_logged(caplog)


def test_a_failed_api_key_fetch_logs_no_heartbeat(handler, monkeypatch, caplog):
    def get_api_key():
        raise RuntimeError("SSM throttled")

    monkeypatch.setattr(handler, "get_api_key", get_api_key)
    caplog.set_level(logging.INFO)

    result = handler.lambda_handler({}, None)

    assert result == {"homeloan_stored": False, "accounts_stored": 0}
    assert not _heartbeat_logged(caplog)
