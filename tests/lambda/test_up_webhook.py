"""Tests for the direct Up-bank webhook (lambda/up_webhook.py, WHIT-313).

No network, no AWS: the signing secret, fetch_transaction, send_push, and the
device/notify repositories are all patched on the up_webhook module. A helper signs
an event with a known secret so verify_signature (the real code) accepts it. Covers
every branch — both 401 paths, PING/other-event acknowledge, qualify vs skip, dedupe,
no-tokens, mark-on-landing, and both error-to-500 paths.
"""

import base64
import hashlib
import hmac
import json
import logging

import pytest

MOCK_SECRET = "mock-secret"
HOMELOAN_UUID = "fbef6cbc-09b3-4b6f-826c-6a178707a178"
SIGNATURE_KEY = "x-up-authenticity-signature"


def _sign(raw: bytes) -> str:
    return hmac.new(MOCK_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()


def _webhook_payload(event_type="TRANSACTION_CREATED", transaction_id="txn-1") -> dict:
    """The thin webhook envelope Up POSTs — carries the event type + transaction id."""
    return {
        "data": {
            "attributes": {"eventType": event_type},
            "relationships": {"transaction": {"data": {"id": transaction_id}}},
        }
    }


def _up_transaction(account_id=HOMELOAN_UUID, cents=357300, transaction_id="txn-1") -> dict:
    """The full transaction fetch_transaction returns (Up's `data` object)."""
    return {
        "id": transaction_id,
        "attributes": {"amount": {"valueInBaseUnits": cents}},
        "relationships": {"account": {"data": {"id": account_id}}},
    }


def _event(payload: dict, *, header=True, is_base64=False) -> dict:
    raw = json.dumps(payload).encode("utf-8")
    body = base64.b64encode(raw).decode("utf-8") if is_base64 else raw.decode("utf-8")
    headers = {SIGNATURE_KEY: _sign(raw)} if header else {}
    return {"body": body, "isBase64Encoded": is_base64, "headers": headers}


class _FakeNotify:
    def __init__(self, fired=None):
        self.fired = set(fired or [])
        self.marked = []

    def fired_repayments(self):
        return set(self.fired)

    def mark_repayment_fired(self, transaction_id):
        self.marked.append(transaction_id)
        self.fired.add(transaction_id)


class _FakeDevice:
    def __init__(self, tokens):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


@pytest.fixture
def wired(lam, monkeypatch):
    """up_webhook with the signing secret + repositories + send_push patched.

    Returns the module plus the recording fakes so a test can assert on them. Default:
    one registered token, nothing previously fired, send_push accepts one (ok=1)."""
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_signing_secret", lambda: MOCK_SECRET)

    notify = _FakeNotify()
    device = _FakeDevice(["ExponentPushToken[abc]"])
    monkeypatch.setattr(up, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(up, "DeviceRepository", lambda: device)

    sent = []

    def fake_send_push(title, body, tokens, data=None):
        sent.append({"title": title, "body": body, "tokens": list(tokens), "data": data})
        return {"sent": len(tokens), "ok": 1, "pruned": []}

    monkeypatch.setattr(up, "send_push", fake_send_push)
    monkeypatch.setattr(up, "fetch_transaction", lambda _id: _up_transaction())

    return type("Wired", (), {"up": up, "notify": notify, "device": device, "sent": sent})


# --- helper-level ----------------------------------------------------------

def test_extract_raw_body_plain(lam):
    event = {"body": '{"a": 1}', "isBase64Encoded": False}
    assert lam.up_webhook.extract_raw_body(event) == b'{"a": 1}'


def test_extract_raw_body_base64(lam):
    encoded = base64.b64encode(b'{"a": 1}').decode("utf-8")
    event = {"body": encoded, "isBase64Encoded": True}
    assert lam.up_webhook.extract_raw_body(event) == b'{"a": 1}'


def test_verify_signature_success(lam, monkeypatch):
    monkeypatch.setattr(lam.up_webhook, "get_signing_secret", lambda: MOCK_SECRET)
    raw = b'{"hello": "up"}'
    assert lam.up_webhook.verify_signature(raw, _sign(raw)) is True


def test_verify_signature_failure(lam, monkeypatch):
    monkeypatch.setattr(lam.up_webhook, "get_signing_secret", lambda: MOCK_SECRET)
    assert lam.up_webhook.verify_signature(b'{"hello": "up"}', "not-the-signature") is False


def test_get_transaction_id(lam):
    assert lam.up_webhook.get_transaction_id(_webhook_payload(transaction_id="txn-9")) == "txn-9"


def test_is_qualifying_repayment_true(lam):
    assert lam.up_webhook.is_qualifying_repayment(_up_transaction(cents=357300)) is True


def test_is_qualifying_repayment_wrong_account(lam):
    txn = _up_transaction(account_id="some-other-account", cents=357300)
    assert lam.up_webhook.is_qualifying_repayment(txn) is False


def test_is_qualifying_repayment_sub_floor(lam):
    # $5 < the $10 floor.
    assert lam.up_webhook.is_qualifying_repayment(_up_transaction(cents=500)) is False


def test_is_qualifying_repayment_negative_interest(lam):
    assert lam.up_webhook.is_qualifying_repayment(_up_transaction(cents=-234828)) is False


def test_is_qualifying_repayment_boundary_is_inclusive(lam):
    # Exactly $10 (1000 cents) qualifies.
    assert lam.up_webhook.is_qualifying_repayment(_up_transaction(cents=1000)) is True


def test_get_signing_secret_caches(lam, monkeypatch):
    up = lam.up_webhook
    monkeypatch.setattr(up, "_signing_secret", None)
    calls = []
    monkeypatch.setattr(up, "get_param", lambda path: calls.append(path) or "secret-value")
    assert up.get_signing_secret() == "secret-value"
    assert up.get_signing_secret() == "secret-value"  # cached: get_param not called again
    assert calls == [up.UP_WEBHOOK_SIGNING_SECRET_PATH]


def test_get_personal_access_token_caches(lam, monkeypatch):
    up = lam.up_webhook
    monkeypatch.setattr(up, "_personal_access_token", None)
    calls = []
    monkeypatch.setattr(up, "get_param", lambda path: calls.append(path) or "pat-value")
    assert up.get_personal_access_token() == "pat-value"
    assert up.get_personal_access_token() == "pat-value"  # cached
    assert calls == [up.UP_PERSONAL_ACCESS_TOKEN_PATH]


class _FakeHTTPResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def test_fetch_transaction_calls_up_with_bearer_token(lam, monkeypatch):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_personal_access_token", lambda: "up-token")
    captured = {}

    def fake_urlopen(request):
        captured["url"] = request.full_url
        captured["auth"] = request.get_header("Authorization")
        return _FakeHTTPResponse({"data": {"id": "txn-1", "attributes": {"x": 1}}})

    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    result = up.fetch_transaction("txn-1")
    assert result == {"id": "txn-1", "attributes": {"x": 1}}
    assert captured["url"].endswith("/transactions/txn-1")
    assert captured["auth"] == "Bearer up-token"


# --- handler branches ------------------------------------------------------

def test_ping_returns_200_without_fetch(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction", _boom("fetch should not run for PING"))
    result = wired.up.lambda_handler(_event(_webhook_payload(event_type="PING")), None)
    assert result == wired.up.OK_RESPONSE
    assert wired.sent == []


def test_other_event_returns_200_without_fetch(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction", _boom("fetch should not run"))
    event = _event(_webhook_payload(event_type="TRANSACTION_SETTLED"))
    assert wired.up.lambda_handler(event, None) == wired.up.OK_RESPONSE
    assert wired.sent == []


def test_missing_signature_header_returns_401(wired):
    event = _event(_webhook_payload(), header=False)
    assert wired.up.lambda_handler(event, None) == wired.up.UNAUTHORISED_RESPONSE
    assert wired.sent == []


def test_bad_signature_returns_401(wired):
    event = _event(_webhook_payload())
    event["headers"][SIGNATURE_KEY] = "wrong-signature"
    assert wired.up.lambda_handler(event, None) == wired.up.UNAUTHORISED_RESPONSE
    assert wired.sent == []


def test_missing_header_logs_unauthorised_marker(lam, caplog):
    # WHIT-316: the greppable diagnostic breadcrumb on the reject path.
    caplog.set_level(logging.WARNING)
    lam.up_webhook.lambda_handler(_event(_webhook_payload(), header=False), None)
    assert "UP_WEBHOOK_UNAUTHORISED" in caplog.text


def test_bad_signature_logs_unauthorised_marker(lam, monkeypatch, caplog):
    monkeypatch.setattr(lam.up_webhook, "get_signing_secret", lambda: MOCK_SECRET)
    caplog.set_level(logging.WARNING)
    event = _event(_webhook_payload())
    event["headers"][SIGNATURE_KEY] = "wrong-signature"
    lam.up_webhook.lambda_handler(event, None)
    assert "UP_WEBHOOK_UNAUTHORISED" in caplog.text


def test_processing_failure_logs_error_marker(lam, monkeypatch, caplog):
    # The 500-path log line the CloudWatch alarm (WHIT-316) matches on.
    monkeypatch.setattr(lam.up_webhook, "get_signing_secret", lambda: MOCK_SECRET)
    caplog.set_level(logging.ERROR)
    raw = b"not valid json"
    event = {"body": raw.decode("utf-8"), "isBase64Encoded": False,
             "headers": {SIGNATURE_KEY: _sign(raw)}}
    lam.up_webhook.lambda_handler(event, None)
    assert "up webhook: processing failed" in caplog.text


def test_qualifying_repayment_sends_one_push_and_marks(wired):
    result = wired.up.lambda_handler(_event(_webhook_payload()), None)
    assert result == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1
    assert "$3,573 toward the mortgage" in wired.sent[0]["body"]
    # WHIT-321: the push carries the deep-link destination so a tap opens /mortgage.
    assert wired.sent[0]["data"] == {"type": "repayment"}
    assert wired.notify.marked == ["txn-1"]


def test_wrong_account_does_not_push(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction",
                        lambda _id: _up_transaction(account_id="anz-card"))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert wired.sent == []
    assert wired.notify.marked == []


def test_sub_floor_amount_does_not_push(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: _up_transaction(cents=500))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert wired.sent == []


def test_negative_interest_debit_does_not_push(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: _up_transaction(cents=-234828))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert wired.sent == []


def test_boundary_amount_pushes(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: _up_transaction(cents=1000))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1


def test_already_fired_id_skips(lam, monkeypatch):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_signing_secret", lambda: MOCK_SECRET)
    notify = _FakeNotify(fired={"txn-1"})
    monkeypatch.setattr(up, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(up, "DeviceRepository", lambda: _FakeDevice(["ExponentPushToken[abc]"]))
    sent = []
    monkeypatch.setattr(up, "send_push", lambda *a: sent.append(a) or {"ok": 1})
    monkeypatch.setattr(up, "fetch_transaction", lambda _id: _up_transaction())

    assert up.lambda_handler(_event(_webhook_payload()), None) == up.OK_RESPONSE
    assert sent == []
    assert notify.marked == []


def test_no_device_tokens_short_circuits(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "DeviceRepository", lambda: _FakeDevice([]))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert wired.sent == []
    assert wired.notify.marked == []


def test_send_push_not_accepted_returns_500_and_not_marked(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "send_push", lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})
    result = wired.up.lambda_handler(_event(_webhook_payload()), None)
    assert result == wired.up.ERROR_RESPONSE
    assert wired.notify.marked == []


def test_fetch_raises_returns_500(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction", _boom("Up API down"))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.ERROR_RESPONSE
    assert wired.sent == []


def test_send_push_raises_returns_500(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "send_push", _boom("Expo down"))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.ERROR_RESPONSE
    assert wired.notify.marked == []


def test_malformed_signed_body_returns_500(lam, monkeypatch):
    # A validly-signed but non-JSON body must surface as the clean logged 500 (Up
    # retries), not an uncaught crash. Signs the raw bytes so it passes verification.
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_signing_secret", lambda: MOCK_SECRET)
    raw = b"this is not json"
    event = {"body": raw.decode("utf-8"), "isBase64Encoded": False,
             "headers": {SIGNATURE_KEY: _sign(raw)}}
    assert up.lambda_handler(event, None) == up.ERROR_RESPONSE


def test_missing_event_type_returns_500(lam, monkeypatch):
    # A signed body whose JSON lacks data.attributes.eventType → clean 500, not a crash.
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_signing_secret", lambda: MOCK_SECRET)
    raw = json.dumps({"data": {"attributes": {}}}).encode("utf-8")
    event = {"body": raw.decode("utf-8"), "isBase64Encoded": False,
             "headers": {SIGNATURE_KEY: _sign(raw)}}
    assert up.lambda_handler(event, None) == up.ERROR_RESPONSE


def test_any_positive_credit_over_floor_false_fires(wired, monkeypatch):
    # Accepted-for-scope (WHIT-313): the qualifier is account + amount only, so a
    # non-repayment positive credit >= $10 on the loan (e.g. a redraw reversal or an
    # interest refund) also fires. Documented here so the risk stays visible.
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: _up_transaction(cents=5000))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1


def _boom(message):
    def _raise(*args, **kwargs):
        raise RuntimeError(message)
    return _raise
