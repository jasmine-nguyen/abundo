"""WHIT-655 QA: the failure paths the merged filter must still catch beyond the three named markers.

Before the merge, up_webhook_errors caught every "processing failed" line. These drive the other
ways a validly-signed delivery fails (Up 5xx, network down, Expo refusing the push) and the
ways it must NOT count (unsigned scanner noise, a non-repayment), against the pattern read out
of monitoring.tf.
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


def _event(signed=True):
    raw = json.dumps({"data": {"attributes": {"eventType": "TRANSACTION_CREATED"},
                               "relationships": {"transaction": {"data": {"id": "txn-1"}}}}}).encode("utf-8")
    headers = {}
    if signed:
        headers["x-up-authenticity-signature"] = hmac.new(MOCK_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    else:
        headers["x-up-authenticity-signature"] = "0" * 64
    return {"body": raw.decode("utf-8"), "isBase64Encoded": False, "headers": headers}


def _transaction(account_id=HOMELOAN_UUID, cents=357300):
    return {"id": "txn-1", "attributes": {"amount": {"valueInBaseUnits": cents}},
            "relationships": {"account": {"data": {"id": account_id}}}}


class _FakeDevice:
    def __init__(self, tokens):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


def _matches_filter(messages):
    """CloudWatch OR pattern: a quoted term matches as a substring, a bare term as a whole word."""
    terms = re.findall(r'\?("[^"]*"|\S+)', filter_pattern("up_webhook_failures"))
    assert terms, "the merged filter is no longer a ?-OR pattern"
    matched = []
    for message in messages:
        for term in terms:
            if term.startswith('"') and term.strip('"') in message:
                matched.append(message)
            if not term.startswith('"') and term in message.split():
                matched.append(message)
    return matched


def _urlopen_raising(error):
    def urlopen(request, timeout=None):
        raise error
    return urlopen


@pytest.fixture
def up(lam, monkeypatch):
    module = lam.up_webhook
    notify = module.NotifyRepository()
    notify._table = FakeTable()
    monkeypatch.setattr(module, "get_signing_secret", lambda: MOCK_SECRET)
    monkeypatch.setattr(module, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(module, "DeviceRepository", lambda: _FakeDevice(["ExponentPushToken[abc]"]))
    monkeypatch.setattr(module, "send_push", lambda *a, **k: {"sent": 1, "ok": 1, "pruned": []})
    lam.api_key._cache[module.UP_PERSONAL_ACCESS_TOKEN_PATH] = "pat-value"
    monkeypatch.setattr(module, "get_homeloan_account_id", lambda: HOMELOAN_UUID)
    return module


def _run(up, caplog, event=None):
    caplog.set_level(logging.INFO)
    response = up.lambda_handler(event or _event(), None)
    return response, [record.getMessage() for record in caplog.records]


# [A8] (P0) Up answering 5xx / the network being down is a fetch failure → must still page.
@pytest.mark.parametrize("error", [
    http_error(500, url=UP_API_URL),
    urllib.error.URLError("connection refused"),
    TimeoutError("timed out"),
], ids=["up_500", "network_down", "timeout"])
def test_other_fetch_failures_match_the_merged_filter(up, monkeypatch, caplog, error):
    monkeypatch.setattr(up.urllib.request, "urlopen", _urlopen_raising(error))
    response, messages = _run(up, caplog)
    assert response["statusCode"] == 500
    assert _matches_filter(messages), messages


# [A9] (P0) Expo refusing the push (ok == 0) raises → "processing failed" → must still page.
def test_push_not_accepted_by_expo_matches_the_merged_filter(up, monkeypatch, caplog):
    monkeypatch.setattr(up, "fetch_transaction", lambda _id: _transaction())
    monkeypatch.setattr(up, "send_push", lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})
    response, messages = _run(up, caplog)
    assert response["statusCode"] == 500
    assert _matches_filter(messages), messages


# [A10] (P0) Don't make the flappy alarm noisier: a successful push, a skipped non-repayment and
# unsigned scanner traffic write nothing the merged filter counts.
def test_healthy_and_scanner_traffic_do_not_match_the_merged_filter(up, monkeypatch, caplog):
    monkeypatch.setattr(up, "fetch_transaction", lambda _id: _transaction())
    response, messages = _run(up, caplog)
    assert response["statusCode"] == 200
    assert _matches_filter(messages) == [], messages
    caplog.clear()

    monkeypatch.setattr(up, "fetch_transaction", lambda _id: _transaction(account_id="someone-else"))
    response, messages = _run(up, caplog)
    assert response["statusCode"] == 200
    assert _matches_filter(messages) == [], messages
    caplog.clear()

    response, messages = _run(up, caplog, _event(signed=False))
    assert response["statusCode"] == 401
    assert _matches_filter(messages) == [], messages


# [A11] (P1) A token rejection logs both its own marker AND "processing failed" — two datapoints in
# one hour, still one alarm (threshold 1) and one email. Pins that the merged alarm sums them.
def test_token_rejection_counts_under_two_terms_of_the_same_metric(up, monkeypatch, caplog):
    monkeypatch.setattr(up.urllib.request, "urlopen",
                        _urlopen_raising(http_error(401, url=UP_API_URL)))
    _, messages = _run(up, caplog)
    assert len(_matches_filter(messages)) == 2, messages
