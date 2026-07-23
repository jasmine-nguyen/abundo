"""Adversarial edge-case tests for the direct Up webhook (lambda/up_webhook.py, WHIT-313).

Independent QA half — deliberately NOT re-covering the implementer's 28 cases in
test_up_webhook.py (helper units, both 401s, PING/other-event acks, qualify/skip
matrix, dedupe, no-tokens, mark-on-landing, both error-to-500 paths). These lock the
GAPS: the base64 body and real header-casing through the *full* handler, the
sign-over-raw-bytes contract, a real PING (no transaction relationship), a partial
fetched transaction becoming a clean 500 (not a crash / not a push), and the
int(valueInBaseUnits) coercion. Uses the shared `lam` fixture (patch on up_webhook).
"""

import base64
import hashlib
import hmac
import json

import pytest

MOCK_SECRET = "mock-secret"
HOMELOAN_UUID = "fbef6cbc-09b3-4b6f-826c-6a178707a178"
SIGNATURE_KEY = "x-up-authenticity-signature"


def _sign(raw: bytes) -> str:
    return hmac.new(MOCK_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()


def _created_payload(transaction_id="txn-1") -> dict:
    return {
        "data": {
            "attributes": {"eventType": "TRANSACTION_CREATED"},
            "relationships": {"transaction": {"data": {"id": transaction_id}}},
        }
    }


def _up_transaction(account_id=HOMELOAN_UUID, cents=357300, transaction_id="txn-1") -> dict:
    return {
        "id": transaction_id,
        "attributes": {"amount": {"valueInBaseUnits": cents}},
        "relationships": {"account": {"data": {"id": account_id}}},
    }


class _FakeNotify:
    def __init__(self, fired=None):
        self.fired = set(fired or [])
        self.marked = []

    def fired_repayments(self):
        return set(self.fired)

    def mark_repayment_fired(self, transaction_id):
        self.marked.append(transaction_id)
        self.fired.add(transaction_id)

    def mark_repayment_push(self, amount_cents, txn_id, fired_at=None):
        pass


class _FakeDevice:
    def __init__(self, tokens):
        self._tokens = tokens

    def list_tokens(self):
        return list(self._tokens)


@pytest.fixture
def wired(lam, monkeypatch):
    """up_webhook with the signing secret + repos + send_push patched (one token,
    nothing fired, send accepts one). fetch_transaction defaults to a qualifying loan
    credit; tests override it to inject the shape they exercise."""
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


# --- [A-E1] base64 body through the FULL handler ---------------------------
# Implementer unit-tests extract_raw_body(base64) in isolation but never runs the
# whole handler with isBase64Encoded=True — so nothing proves signature-verify +
# json.loads operate on the DECODED bytes end-to-end. If the base64 branch regressed,
# verify_signature would run over the still-encoded string and 401 instead of pushing.
def test_base64_encoded_body_pushes_end_to_end(wired):
    raw = json.dumps(_created_payload()).encode("utf-8")
    event = {
        "body": base64.b64encode(raw).decode("utf-8"),
        "isBase64Encoded": True,
        "headers": {SIGNATURE_KEY: _sign(raw)},  # signed over the DECODED bytes
    }
    assert wired.up.lambda_handler(event, None) == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1
    assert wired.notify.marked == ["txn-1"]


# --- [A-E2] the header exactly as Up sends it (mixed case) -----------------
# The implementer's _event helper always sets the lower-cased key, so the handler's
# `{k.lower(): v}` normalisation is never actually exercised. Up sends
# "X-Up-Authenticity-Signature"; drop the .lower() and this 401s.
def test_real_up_header_casing_is_accepted(wired):
    raw = json.dumps(_created_payload()).encode("utf-8")
    event = {
        "body": raw.decode("utf-8"),
        "isBase64Encoded": False,
        "headers": {"X-Up-Authenticity-Signature": _sign(raw)},
    }
    assert wired.up.lambda_handler(event, None) == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1


# --- [A-E3] signature is verified over the EXACT raw bytes ------------------
# Up signs the literal delivered bytes. This body has non-canonical spacing that
# json.dumps would never reproduce; the signature is over those exact bytes. If the
# code ever verified over a re-serialised payload (json.loads → json.dumps), the digest
# would differ and this would 401. Proves the "raw, not re-serialised" contract.
def test_signature_verified_over_exact_raw_bytes(wired):
    raw = (
        b'{"data" :   {"attributes": {"eventType":"TRANSACTION_CREATED"} ,'
        b'"relationships":{"transaction":{"data":{"id":"txn-1"}}}}  }'
    )
    # sanity: still valid JSON with the same meaning, just odd whitespace.
    assert json.loads(raw)["data"]["attributes"]["eventType"] == "TRANSACTION_CREATED"
    event = {"body": raw.decode("utf-8"), "isBase64Encoded": False,
             "headers": {SIGNATURE_KEY: _sign(raw)}}
    assert wired.up.lambda_handler(event, None) == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1


# --- [A-E4] a REAL Up PING (no transaction relationship) -------------------
# Up's registration PING has NO `relationships.transaction` — only a webhook link. The
# implementer's PING test smuggles in a transaction id, so it can't catch a regression
# that calls get_transaction_id before the eventType short-circuit. This payload would
# KeyError → 500 if the order flipped; it must ack 200 with no fetch/push.
def test_real_ping_without_transaction_relationship_is_acked(wired, monkeypatch):
    def _boom(*a, **k):
        raise AssertionError("fetch must not run for a PING")

    monkeypatch.setattr(wired.up, "fetch_transaction", _boom)
    payload = {"data": {"attributes": {"eventType": "PING"},
                        "relationships": {"webhook": {"data": {"id": "wh-1"}}}}}
    raw = json.dumps(payload).encode("utf-8")
    event = {"body": raw.decode("utf-8"), "isBase64Encoded": False,
             "headers": {SIGNATURE_KEY: _sign(raw)}}
    assert wired.up.lambda_handler(event, None) == wired.up.OK_RESPONSE
    assert wired.sent == []
    assert wired.notify.marked == []


# --- [A-E5] a partial fetched transaction → clean 500, no push -------------
# If Up ever returns a transaction missing relationships/account (or a shape change),
# is_qualifying_repayment raises KeyError. Because it runs INSIDE the handler's try, it
# must surface as the clean ERROR_RESPONSE (Up retries) — never a push, never a mark,
# never an uncaught crash. Locks the guard around the qualify/notify block.
def test_partial_transaction_missing_account_returns_500(wired, monkeypatch):
    partial = {"id": "txn-1", "attributes": {"amount": {"valueInBaseUnits": 357300}}}
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: partial)
    result = wired.up.lambda_handler(_signed(_created_payload()), None)
    assert result == wired.up.ERROR_RESPONSE
    assert wired.sent == []
    assert wired.notify.marked == []


# --- [A-E6] valueInBaseUnits coercion --------------------------------------
# Up sends valueInBaseUnits as a JSON integer, but the code defensively wraps it in
# int(). Lock that coercion: a string amount still qualifies. Remove the int() and a
# str >= int comparison raises TypeError in Python 3.
def test_value_in_base_units_string_is_coerced(lam):
    txn = _up_transaction(cents="357300")  # a string, as some JSON:API encoders emit
    assert lam.up_webhook.is_qualifying_repayment(txn) is True


def _signed(payload: dict) -> dict:
    raw = json.dumps(payload).encode("utf-8")
    return {"body": raw.decode("utf-8"), "isBase64Encoded": False,
            "headers": {SIGNATURE_KEY: _sign(raw)}}
