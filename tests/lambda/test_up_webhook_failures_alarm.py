"""WHIT-655: every Up webhook failure mode writes a line the merged up_webhook_failures filter matches.

The filter is one CloudWatch OR pattern (`?a ?b ?c`). A quoted term matches as a substring;
a bare term matches as a whole word. Each failure path must emit ITS OWN term, so dropping a
term from the pattern leaves that failure unalarmed and fails here.
"""

import hashlib
import hmac
import json
import logging
import re

import pytest

from _dynamo_fakes import FakeTable
from _http_fakes import UP_API_URL, http_error
from _terraform import filter_pattern

MOCK_SECRET = "mock-secret"
HOMELOAN_UUID = "fbef6cbc-09b3-4b6f-826c-6a178707a178"
MERGED_PATTERN = '?"up webhook: processing failed" ?UP_WEBHOOK_TOKEN_REJECTED ?UP_WEBHOOK_NO_DEVICE_TOKENS'


def _signed_event():
    raw = json.dumps({"data": {"attributes": {"eventType": "TRANSACTION_CREATED"},
                               "relationships": {"transaction": {"data": {"id": "txn-1"}}}}}).encode("utf-8")
    signature = hmac.new(MOCK_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return {"body": raw.decode("utf-8"), "isBase64Encoded": False,
            "headers": {"x-up-authenticity-signature": signature}}


def _up_transaction(_transaction_id):
    return {"id": "txn-1", "attributes": {"amount": {"valueInBaseUnits": 357300}},
            "relationships": {"account": {"data": {"id": HOMELOAN_UUID}}}}


class _FakeDevice:
    def __init__(self, tokens):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


def _or_terms(pattern):
    return [term.strip('"') for term in re.findall(r'\?("[^"]*"|\S+)', pattern)]


def _fetch_raises(up, monkeypatch):
    def boom(_transaction_id):
        raise RuntimeError("Up API down")
    monkeypatch.setattr(up, "fetch_transaction", boom)


def _up_rejects_token(code):
    def arrange(up, monkeypatch):
        def urlopen(request, timeout=None):
            raise http_error(code, url=UP_API_URL)
        monkeypatch.setattr(up.urllib.request, "urlopen", urlopen)
        monkeypatch.setattr(up, "_personal_access_token", "old-pat-value")
    return arrange


def _no_phone_registered(up, monkeypatch):
    monkeypatch.setattr(up, "fetch_transaction", _up_transaction)
    monkeypatch.setattr(up, "DeviceRepository", lambda: _FakeDevice([]))


@pytest.mark.parametrize("arrange, expected_term", [
    (_fetch_raises, "up webhook: processing failed"),
    (_up_rejects_token(401), "UP_WEBHOOK_TOKEN_REJECTED"),
    (_up_rejects_token(403), "UP_WEBHOOK_TOKEN_REJECTED"),
    (_no_phone_registered, "UP_WEBHOOK_NO_DEVICE_TOKENS"),
], ids=["fetch_fails", "token_rejected_401", "token_rejected_403", "no_device_tokens"])
def test_each_webhook_failure_logs_a_term_the_merged_filter_matches(lam, monkeypatch, caplog, arrange, expected_term):
    pattern = filter_pattern("up_webhook_failures")
    assert pattern == MERGED_PATTERN, f"terraform pattern changed: {pattern!r}"
    assert expected_term in _or_terms(pattern)

    up = lam.up_webhook
    notify = up.NotifyRepository()
    notify._table = FakeTable()
    monkeypatch.setattr(up, "get_signing_secret", lambda: MOCK_SECRET)
    monkeypatch.setattr(up, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(up, "DeviceRepository", lambda: _FakeDevice(["ExponentPushToken[abc]"]))
    monkeypatch.setattr(up, "send_push", lambda *a, **k: {"sent": 1, "ok": 1, "pruned": []})
    monkeypatch.setattr(up, "get_homeloan_account_id", lambda: HOMELOAN_UUID)
    arrange(up, monkeypatch)

    caplog.set_level(logging.INFO)
    up.lambda_handler(_signed_event(), None)

    messages = [record.getMessage() for record in caplog.records]
    if " " in expected_term:
        matched = [message for message in messages if expected_term in message]
    else:
        matched = [message for message in messages if expected_term in message.split()]
    assert matched, f"no logged line matches the filter term {expected_term!r}: {messages}"
