"""WHIT-655: every Up webhook failure mode writes a line the merged up_webhook_failures filter matches.

The filter is one CloudWatch OR pattern (`?a ?b ?c`). A quoted term matches as a substring;
a bare term matches as a whole word. Each failure path must emit ITS OWN term, so dropping a
term from the pattern leaves that failure unalarmed and fails here. Healthy traffic and
unsigned scanner noise must match nothing, so the alarm stays quiet.
"""

import hashlib
import hmac
import json
import logging
import re
import urllib.error

import pytest

from _dynamo_fakes import FakeTable
from _http_fakes import UP_API_URL, http_error
from _terraform import filter_pattern

MOCK_SECRET = "mock-secret"
HOMELOAN_UUID = "fbef6cbc-09b3-4b6f-826c-6a178707a178"


def _signed_event(signed=True):
    raw = json.dumps({"data": {"attributes": {"eventType": "TRANSACTION_CREATED"},
                               "relationships": {"transaction": {"data": {"id": "txn-1"}}}}}).encode("utf-8")
    signature = "0" * 64
    if signed:
        signature = hmac.new(MOCK_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return {"body": raw.decode("utf-8"), "isBase64Encoded": False,
            "headers": {"x-up-authenticity-signature": signature}}


def _up_transaction(_transaction_id, account_id=HOMELOAN_UUID):
    return {"id": "txn-1", "attributes": {"amount": {"valueInBaseUnits": 357300}},
            "relationships": {"account": {"data": {"id": account_id}}}}


class _FakeDevice:
    def __init__(self, tokens):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


def _or_terms(pattern):
    return [term.strip('"') for term in re.findall(r'\?("[^"]*"|\S+)', pattern)]


def _matching(messages, term):
    if " " in term:
        return [message for message in messages if term in message]
    return [message for message in messages if term in message.split()]


@pytest.fixture
def up(lam, monkeypatch):
    module = lam.up_webhook
    notify = module.NotifyRepository()
    notify._table = FakeTable()
    monkeypatch.setattr(module, "get_signing_secret", lambda: MOCK_SECRET)
    monkeypatch.setattr(module, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(module, "DeviceRepository", lambda: _FakeDevice(["ExponentPushToken[abc]"]))
    monkeypatch.setattr(module, "send_push", lambda *a, **k: {"sent": 1, "ok": 1, "pruned": []})
    monkeypatch.setattr(module, "get_homeloan_account_id", lambda: HOMELOAN_UUID)
    return module


def _run(up, caplog, event=None):
    caplog.set_level(logging.INFO)
    response = up.lambda_handler(event or _signed_event(), None)
    return response, [record.getMessage() for record in caplog.records]


def _fetch_raises(up, monkeypatch):
    def boom(_transaction_id):
        raise RuntimeError("Up API down")
    monkeypatch.setattr(up, "fetch_transaction", boom)


def _urlopen_raises(error):
    def arrange(up, monkeypatch):
        def urlopen(request, timeout=None):
            raise error
        monkeypatch.setattr(up.urllib.request, "urlopen", urlopen)
    return arrange


def _no_phone_registered(up, monkeypatch):
    monkeypatch.setattr(up, "fetch_transaction", _up_transaction)
    monkeypatch.setattr(up, "DeviceRepository", lambda: _FakeDevice([]))


def _expo_refuses_the_push(up, monkeypatch):
    monkeypatch.setattr(up, "fetch_transaction", _up_transaction)
    monkeypatch.setattr(up, "send_push", lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})


@pytest.mark.parametrize("arrange, expected_term, status", [
    (_fetch_raises, "up webhook: processing failed", 500),
    (_urlopen_raises(http_error(500, url=UP_API_URL)), "up webhook: processing failed", 500),
    (_urlopen_raises(urllib.error.URLError("connection refused")), "up webhook: processing failed", 500),
    (_urlopen_raises(TimeoutError("timed out")), "up webhook: processing failed", 500),
    (_expo_refuses_the_push, "up webhook: processing failed", 500),
    (_urlopen_raises(http_error(401, url=UP_API_URL)), "UP_WEBHOOK_TOKEN_REJECTED", 500),
    (_urlopen_raises(http_error(403, url=UP_API_URL)), "UP_WEBHOOK_TOKEN_REJECTED", 500),
    (_no_phone_registered, "UP_WEBHOOK_NO_DEVICE_TOKENS", 200),
], ids=["fetch_fails", "up_500", "network_down", "timeout", "expo_refuses_push",
        "token_rejected_401", "token_rejected_403", "no_device_tokens"])
def test_each_webhook_failure_logs_a_term_the_merged_filter_matches(up, monkeypatch, caplog, arrange, expected_term,
                                                                      status):
    assert expected_term in _or_terms(filter_pattern("up_webhook_failures"))
    arrange(up, monkeypatch)

    response, messages = _run(up, caplog)

    assert response["statusCode"] == status
    assert _matching(messages, expected_term), f"no logged line matches the filter term {expected_term!r}: {messages}"


def test_healthy_and_scanner_traffic_do_not_match_the_merged_filter(up, monkeypatch, caplog):
    # Don't make the flappy alarm noisier: a successful push, a skipped non-repayment and
    # unsigned scanner traffic write nothing the merged filter counts.
    terms = _or_terms(filter_pattern("up_webhook_failures"))

    def matched(messages):
        return [message for term in terms for message in _matching(messages, term)]

    monkeypatch.setattr(up, "fetch_transaction", _up_transaction)
    response, messages = _run(up, caplog)
    assert response["statusCode"] == 200
    assert matched(messages) == [], messages
    caplog.clear()

    monkeypatch.setattr(up, "fetch_transaction", lambda _id: _up_transaction(_id, account_id="someone-else"))
    response, messages = _run(up, caplog)
    assert response["statusCode"] == 200
    assert matched(messages) == [], messages
    caplog.clear()

    response, messages = _run(up, caplog, _signed_event(signed=False))
    assert response["statusCode"] == 401
    assert matched(messages) == [], messages
