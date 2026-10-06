"""WHIT-618: the Up webhook finds the home loan by account type, not a hardcoded ID.

Up's HTTP calls (urlopen) are faked at the network boundary; the real
fetch_transaction and get_homeloan_account_id run.
"""

import hashlib
import hmac
import json
import logging
import urllib.error

import pytest

from _dynamo_fakes import FakeTable
from _http_fakes import FakeResponse

MOCK_SECRET = "mock-secret"
OLD_HOMELOAN_ID = "fbef6cbc-09b3-4b6f-826c-6a178707a178"
NEW_HOMELOAN_ID = "0a1b2c3d-renumbered-home-loan"
SIGNATURE_KEY = "x-up-authenticity-signature"


class _FakeDevice:
    def list_tokens(self):
        return ["ExponentPushToken[abc]"]


def _accounts_response(*home_loan_ids):
    data = [{"id": "spending-account", "type": "accounts",
             "attributes": {"accountType": "TRANSACTIONAL", "displayName": "Spending"}}]
    data += [{"id": account_id, "type": "accounts",
              "attributes": {"accountType": "HOME_LOAN", "displayName": "Home Loan"}}
             for account_id in home_loan_ids]
    return {"data": data}


def _transaction_response(transaction_id, account_id, cents=357300):
    return {"data": {
        "id": transaction_id,
        "attributes": {"amount": {"valueInBaseUnits": cents}},
        "relationships": {"account": {"data": {"id": account_id}}},
    }}


def _event(transaction_id):
    payload = {"data": {
        "attributes": {"eventType": "TRANSACTION_CREATED"},
        "relationships": {"transaction": {"data": {"id": transaction_id}}},
    }}
    raw = json.dumps(payload).encode("utf-8")
    signature = hmac.new(MOCK_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return {"body": raw.decode("utf-8"), "isBase64Encoded": False,
            "headers": {SIGNATURE_KEY: signature}}


def _markers(caplog, marker):
    return [r for r in caplog.records if marker in r.getMessage().split()]


def test_repayment_on_renumbered_home_loan_still_sends_push(lam, monkeypatch, caplog):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_signing_secret", lambda: MOCK_SECRET)
    lam.api_key._cache[up.UP_PERSONAL_ACCESS_TOKEN_PATH] = "up-token"
    notify = up.NotifyRepository()
    notify._table = FakeTable()
    monkeypatch.setattr(up, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(up, "DeviceRepository", lambda: _FakeDevice())

    sent = []

    def fake_send_push(title, body, tokens, data=None):
        sent.append(title)
        return {"sent": len(tokens), "ok": 1, "pruned": []}

    monkeypatch.setattr(up, "send_push", fake_send_push)

    transactions = {
        "txn-new": _transaction_response("txn-new", NEW_HOMELOAN_ID),
        "txn-old": _transaction_response("txn-old", OLD_HOMELOAN_ID),
    }

    def fake_urlopen(request, timeout=None):
        url = request.full_url
        if "/transactions/" in url:
            return FakeResponse(transactions[url.rsplit("/", 1)[-1]])
        assert "/accounts" in url
        return FakeResponse(_accounts_response(NEW_HOMELOAN_ID))

    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    caplog.set_level(logging.INFO)

    assert up.lambda_handler(_event("txn-new"), None) == up.OK_RESPONSE
    assert len(sent) == 1

    assert up.lambda_handler(_event("txn-old"), None) == up.OK_RESPONSE
    assert len(sent) == 1
    assert "reason=not_homeloan_account transaction=txn-old" in caplog.text


def test_get_homeloan_account_id_falls_back_then_reads_up_once(lam, monkeypatch, caplog):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_personal_access_token", lambda: "up-token")
    responses = [
        urllib.error.URLError("connection refused"),
        _accounts_response(),
        _accounts_response("loan-a", "loan-b"),
        _accounts_response(NEW_HOMELOAN_ID),
    ]
    requests = []

    def fake_urlopen(request, timeout=None):
        requests.append(request)
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return FakeResponse(response)

    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    caplog.set_level(logging.INFO)

    assert up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    assert up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    assert up.get_homeloan_account_id() == OLD_HOMELOAN_ID
    fallbacks = [r.getMessage() for r in _markers(caplog, "UP_WEBHOOK_HOMELOAN_LOOKUP_FALLBACK")]
    assert len(fallbacks) == 3
    assert "reason=lookup_failed" in fallbacks[0]
    assert "reason=none_found" in fallbacks[1]
    assert "reason=several_found" in fallbacks[2]

    assert up.get_homeloan_account_id() == NEW_HOMELOAN_ID
    assert _markers(caplog, "UP_WEBHOOK_HOMELOAN_ID_CHANGED")
    assert up.get_homeloan_account_id() == NEW_HOMELOAN_ID
    assert len(requests) == 4  # the real answer is saved; a fallback is not

    assert "/accounts" in requests[0].full_url
    assert "HOME_LOAN" in requests[0].full_url
    assert requests[0].get_header("Authorization") == "Bearer up-token"


@pytest.fixture(autouse=True)
def _no_real_ssm(lam, monkeypatch):
    monkeypatch.setattr(lam.api_key, "get_param", lambda path: "fake-secret")
