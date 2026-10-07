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
import http.client
import urllib.error
from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable
from _http_fakes import UP_API_URL, FakeResponse, http_error

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


def _notify(up, fired=()):
    """The REAL NotifyRepository over a FakeTable, with ``fired`` repayment ids already marked.
    The write log is cleared after that setup, so ``_marked`` / ``_pushes`` see only the handler."""
    notify = up.NotifyRepository()
    notify._table = FakeTable()
    _already_fired(notify, *fired)
    return notify


def _already_fired(notify, *transaction_ids):
    for transaction_id in transaction_ids:
        notify.mark_repayment_fired(transaction_id)
    notify._table.update_calls.clear()
    notify._table.update_keys.clear()


def _added(notify, pk):
    return [member for key, (_expression, _names, values)
            in zip(notify._table.update_keys, notify._table.update_calls)
            if key["pk"] == pk for member in sorted(values[":m"])]


def _marked(notify):
    """The repayment ids the handler marked as notified, in order."""
    return _added(notify, "NOTIFY#REPAYMENT")


def _pushes(notify):
    """(amount_cents, txn_id) of each push recorded for the WHIT-317 miss-detector."""
    pushes = []
    for token in _added(notify, "NOTIFY#REPAYPUSH"):
        _fired_at, amount_cents, transaction_id = token.split("#", 2)
        pushes.append((int(amount_cents), transaction_id))
    return pushes


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

    notify = _notify(up)
    device = _FakeDevice(["ExponentPushToken[abc]"])
    monkeypatch.setattr(up, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(up, "DeviceRepository", lambda: device)

    sent = []

    def fake_send_push(title, body, tokens, data=None):
        sent.append({"title": title, "body": body, "tokens": list(tokens), "data": data})
        return {"sent": len(tokens), "ok": 1, "pruned": []}

    monkeypatch.setattr(up, "send_push", fake_send_push)
    monkeypatch.setattr(up, "fetch_transaction", lambda _id: _up_transaction())
    monkeypatch.setattr(up, "get_homeloan_account_id", lambda: HOMELOAN_UUID)

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


@pytest.fixture
def skip_up(lam, monkeypatch):
    """up_webhook with the home-loan lookup stubbed, so repayment_skip_reason stays offline."""
    monkeypatch.setattr(lam.up_webhook, "get_homeloan_account_id", lambda: HOMELOAN_UUID)
    return lam.up_webhook


def test_repayment_skip_reason_none_for_qualifying(skip_up):
    assert skip_up.repayment_skip_reason(_up_transaction(cents=357300)) is None


def test_repayment_skip_reason_wrong_account(skip_up):
    txn = _up_transaction(account_id="some-other-account", cents=357300)
    assert skip_up.repayment_skip_reason(txn) == "not_homeloan_account"


def test_repayment_skip_reason_sub_floor(skip_up):
    # $5 < the $10 floor.
    assert skip_up.repayment_skip_reason(_up_transaction(cents=500)) == "below_floor"


def test_repayment_skip_reason_negative_interest(skip_up):
    assert skip_up.repayment_skip_reason(_up_transaction(cents=-234828)) == "below_floor"


def test_repayment_skip_reason_boundary_is_inclusive(skip_up):
    # Exactly $10 (1000 cents) qualifies.
    assert skip_up.repayment_skip_reason(_up_transaction(cents=1000)) is None


def test_up_secrets_read_their_own_ssm_paths(lam, monkeypatch):
    up = lam.up_webhook
    monkeypatch.setattr(lam.api_key, "get_param", lambda path: f"value-of-{path}")
    assert up.get_signing_secret() == f"value-of-{up.UP_WEBHOOK_SIGNING_SECRET_PATH}"
    assert up.get_personal_access_token() == f"value-of-{up.UP_PERSONAL_ACCESS_TOKEN_PATH}"


def test_fetch_transaction_calls_up_with_bearer_token(lam, monkeypatch):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_personal_access_token", lambda: "up-token")
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["auth"] = request.get_header("Authorization")
        captured["timeout"] = timeout
        return FakeResponse({"data": {"id": "txn-1", "attributes": {"x": 1}}})

    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    result = up.fetch_transaction("txn-1")
    assert result == {"id": "txn-1", "attributes": {"x": 1}}
    assert captured["url"].endswith("/transactions/txn-1")
    assert captured["auth"] == "Bearer up-token"
    assert captured["timeout"] == 10


# --- WHIT-616: fetch failures are named, a dead token is dropped --------------

def _marker_records(caplog, marker, level=None):
    """Records whose message carries `marker` as a bare word — how a CloudWatch text
    filter term matches."""
    return [r for r in caplog.records
            if marker in r.getMessage().split() and (level is None or r.levelno == level)]


def _urlopen_raising(error):
    def _raise(request, timeout=None):
        raise error
    return _raise


@pytest.fixture
def fetch_wired(lam, monkeypatch, request):
    """`wired`, but with the REAL fetch_transaction and a cached token, so a test
    patches urlopen and the marker code actually runs."""
    real_fetch = lam.up_webhook.fetch_transaction
    real_homeloan_lookup = lam.up_webhook.get_homeloan_account_id
    wired = request.getfixturevalue("wired")
    wired.real_homeloan_lookup = real_homeloan_lookup
    monkeypatch.setattr(wired.up, "fetch_transaction", real_fetch)
    lam.api_key._cache[lam.up_webhook.UP_PERSONAL_ACCESS_TOKEN_PATH] = "old-pat-value"
    return wired


@pytest.mark.parametrize("code", [401, 403])
def test_up_401_logs_token_rejected_marker_and_returns_500(fetch_wired, monkeypatch, caplog, code):
    up = fetch_wired.up
    monkeypatch.setattr(up.urllib.request, "urlopen", _urlopen_raising(http_error(code, url=UP_API_URL)))
    caplog.set_level(logging.INFO)
    assert up.lambda_handler(_event(_webhook_payload()), None) == up.ERROR_RESPONSE
    assert _marker_records(caplog, "UP_WEBHOOK_TOKEN_REJECTED", logging.ERROR)
    assert "old-pat-value" not in caplog.text  # the token itself is never logged
    assert "up webhook: processing failed" in caplog.text
    assert fetch_wired.sent == []


@pytest.mark.parametrize("code", [401, 403])
def test_token_rejected_clears_cached_token(fetch_wired, lam, monkeypatch, code):
    up = fetch_wired.up
    monkeypatch.setattr(up.urllib.request, "urlopen", _urlopen_raising(http_error(code, url=UP_API_URL)))
    calls = []
    monkeypatch.setattr(lam.api_key, "get_param", lambda path: calls.append(path) or "new")
    up.lambda_handler(_event(_webhook_payload()), None)
    assert up.UP_PERSONAL_ACCESS_TOKEN_PATH not in lam.api_key._cache
    assert up.get_personal_access_token() == "new"
    assert calls == [up.UP_PERSONAL_ACCESS_TOKEN_PATH]


@pytest.mark.parametrize("code", [404, 500])
def test_up_non_auth_error_logs_fetch_failed_not_token_rejected(fetch_wired, lam, monkeypatch, caplog, code):
    up = fetch_wired.up
    monkeypatch.setattr(up.urllib.request, "urlopen", _urlopen_raising(http_error(code, url=UP_API_URL)))
    caplog.set_level(logging.INFO)
    assert up.lambda_handler(_event(_webhook_payload()), None) == up.ERROR_RESPONSE
    assert _marker_records(caplog, "UP_WEBHOOK_FETCH_FAILED", logging.ERROR)
    assert not _marker_records(caplog, "UP_WEBHOOK_TOKEN_REJECTED")
    # a non-auth error keeps the cached token
    assert lam.api_key._cache[up.UP_PERSONAL_ACCESS_TOKEN_PATH] == "old-pat-value"


@pytest.mark.parametrize("error", [urllib.error.URLError("timed out"), TimeoutError()])
def test_up_unreachable_logs_fetch_failed(fetch_wired, monkeypatch, caplog, error):
    up = fetch_wired.up
    monkeypatch.setattr(up.urllib.request, "urlopen", _urlopen_raising(error))
    caplog.set_level(logging.INFO)
    assert up.lambda_handler(_event(_webhook_payload()), None) == up.ERROR_RESPONSE
    assert _marker_records(caplog, "UP_WEBHOOK_FETCH_FAILED", logging.ERROR)
    assert not _marker_records(caplog, "UP_WEBHOOK_TOKEN_REJECTED")


# --- handler branches ------------------------------------------------------

def test_ping_returns_200_without_fetch(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction", _boom("fetch should not run for PING"))
    result = wired.up.lambda_handler(_event(_webhook_payload(event_type="PING")), None)
    assert result == wired.up.OK_RESPONSE
    assert wired.sent == []


def test_other_event_returns_200_without_fetch(wired, monkeypatch, caplog):
    monkeypatch.setattr(wired.up, "fetch_transaction", _boom("fetch should not run"))
    caplog.set_level(logging.INFO)
    event = _event(_webhook_payload(event_type="TRANSACTION_SETTLED"))
    assert wired.up.lambda_handler(event, None) == wired.up.OK_RESPONSE
    assert wired.sent == []
    assert _skip_reasons(caplog) == ["not_transaction_created"]


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


def _skip_reasons(caplog):
    return [word.split("=", 1)[1]
            for record in _marker_records(caplog, "UP_WEBHOOK_SKIP", logging.INFO)
            for word in record.getMessage().split() if word.startswith("reason=")]


def test_qualifying_repayment_sends_one_push_and_marks(wired):
    result = wired.up.lambda_handler(_event(_webhook_payload()), None)
    assert result == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1
    assert "$3,573 toward the mortgage" in wired.sent[0]["body"]
    # WHIT-321: the push carries the deep-link destination so a tap opens /mortgage.
    assert wired.sent[0]["data"] == {"type": "repayment"}
    assert _marked(wired.notify) == ["txn-1"]


def test_wrong_account_does_not_push(wired, monkeypatch, caplog):
    monkeypatch.setattr(wired.up, "fetch_transaction",
                        lambda _id: _up_transaction(account_id="anz-card"))
    caplog.set_level(logging.INFO)
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert wired.sent == []
    assert _marked(wired.notify) == []
    assert _skip_reasons(caplog) == ["not_homeloan_account"]


def test_sub_floor_amount_does_not_push(wired, monkeypatch, caplog):
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: _up_transaction(cents=500))
    caplog.set_level(logging.INFO)
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert wired.sent == []
    assert _skip_reasons(caplog) == ["below_floor"]


def test_negative_interest_debit_does_not_push(wired, monkeypatch, caplog):
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: _up_transaction(cents=-234828))
    caplog.set_level(logging.INFO)
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert wired.sent == []
    assert _skip_reasons(caplog) == ["below_floor"]


def test_boundary_amount_pushes(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: _up_transaction(cents=1000))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1


def test_qualifying_repayment_records_push_marker(wired):
    # WHIT-317: a successful push records (amount_cents, txn_id) so the poller's precise
    # miss-detector can match this repayment. Cents come straight from valueInBaseUnits.
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert _pushes(wired.notify) == [(357300, "txn-1")]


def test_failed_push_records_no_marker(wired, monkeypatch, caplog):
    # Mark-on-landing: if Expo didn't accept the push, neither the dedup id nor the
    # miss-detector marker is written (the 500 lets Up retry), and nothing claims it was sent.
    monkeypatch.setattr(wired.up, "send_push", lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})
    caplog.set_level(logging.INFO)
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.ERROR_RESPONSE
    assert _pushes(wired.notify) == []
    assert not _marker_records(caplog, "UP_WEBHOOK_PUSH_SENT")


def test_successful_push_logs_push_sent(wired, caplog):
    # WHIT-616: a push that reached Expo leaves one INFO breadcrumb, logged after the
    # miss-detector marker is written, and no skip line.
    caplog.set_level(logging.INFO)
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    [record] = _marker_records(caplog, "UP_WEBHOOK_PUSH_SENT", logging.INFO)
    message = record.getMessage()
    assert "transaction=txn-1" in message.split()
    assert "amount_cents=357300" in message.split()
    assert _pushes(wired.notify) == [(357300, "txn-1")]
    assert not _marker_records(caplog, "UP_WEBHOOK_SKIP")


def test_already_fired_id_skips(lam, monkeypatch, caplog):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_signing_secret", lambda: MOCK_SECRET)
    notify = _notify(up, fired={"txn-1"})
    monkeypatch.setattr(up, "NotifyRepository", lambda: notify)
    monkeypatch.setattr(up, "DeviceRepository", lambda: _FakeDevice(["ExponentPushToken[abc]"]))
    sent = []
    monkeypatch.setattr(up, "send_push", lambda *a: sent.append(a) or {"ok": 1})
    monkeypatch.setattr(up, "fetch_transaction", lambda _id: _up_transaction())
    monkeypatch.setattr(up, "get_homeloan_account_id", lambda: HOMELOAN_UUID)
    caplog.set_level(logging.INFO)

    assert up.lambda_handler(_event(_webhook_payload()), None) == up.OK_RESPONSE
    assert sent == []
    assert _marked(notify) == []
    assert _skip_reasons(caplog) == ["already_notified"]


def test_no_device_tokens_short_circuits(wired, monkeypatch, caplog):
    monkeypatch.setattr(wired.up, "DeviceRepository", lambda: _FakeDevice([]))
    caplog.set_level(logging.INFO)
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert wired.sent == []
    assert _marked(wired.notify) == []
    assert _pushes(wired.notify) == []
    assert _marker_records(caplog, "UP_WEBHOOK_NO_DEVICE_TOKENS", logging.ERROR)
    assert not _marker_records(caplog, "UP_WEBHOOK_SKIP")


def test_send_push_not_accepted_returns_500_and_not_marked(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "send_push", lambda *a, **k: {"sent": 1, "ok": 0, "pruned": []})
    result = wired.up.lambda_handler(_event(_webhook_payload()), None)
    assert result == wired.up.ERROR_RESPONSE
    assert _marked(wired.notify) == []


def test_fetch_raises_returns_500(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "fetch_transaction", _boom("Up API down"))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.ERROR_RESPONSE
    assert wired.sent == []


def test_send_push_raises_returns_500(wired, monkeypatch):
    monkeypatch.setattr(wired.up, "send_push", _boom("Expo down"))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.ERROR_RESPONSE
    assert _marked(wired.notify) == []


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


def test_qualifying_repayment_logs_no_skip(wired, caplog):
    caplog.set_level(logging.INFO)
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert not _marker_records(caplog, "UP_WEBHOOK_SKIP")


# WHIT-655: the merged up_webhook_failures filter's pattern-matches-emitted-line tests live in
# test_up_webhook_failures_alarm.py; the merged alarm's wiring is pinned in
# tests/shared/test_alarm_budget.py.


def test_any_positive_credit_over_floor_false_fires(wired, monkeypatch):
    # Accepted-for-scope (WHIT-313): the qualifier is account + amount only, so a
    # non-repayment positive credit >= $10 on the loan (e.g. a redraw reversal or an
    # interest refund) also fires. Documented here so the risk stays visible.
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: _up_transaction(cents=5000))
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1


# --- adversarial edges: full-handler paths the units above don't exercise ----


# [E1] base64 body through the FULL handler.
# The unit tests extract_raw_body(base64) in isolation but never run the whole handler
# with isBase64Encoded=True — so nothing proves signature-verify + json.loads operate on
# the DECODED bytes end-to-end. If the base64 branch regressed, verify_signature would run
# over the still-encoded string and 401 instead of pushing.
def test_base64_encoded_body_pushes_end_to_end(wired):
    raw = json.dumps(_webhook_payload()).encode("utf-8")
    event = {
        "body": base64.b64encode(raw).decode("utf-8"),
        "isBase64Encoded": True,
        "headers": {SIGNATURE_KEY: _sign(raw)},  # signed over the DECODED bytes
    }
    assert wired.up.lambda_handler(event, None) == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1
    assert _marked(wired.notify) == ["txn-1"]


# [E2] the header exactly as Up sends it (mixed case).
# The _event helper always sets the lower-cased key, so the handler's `{k.lower(): v}`
# normalisation is never actually exercised. Up sends "X-Up-Authenticity-Signature";
# drop the .lower() and this 401s.
def test_real_up_header_casing_is_accepted(wired):
    raw = json.dumps(_webhook_payload()).encode("utf-8")
    event = {
        "body": raw.decode("utf-8"),
        "isBase64Encoded": False,
        "headers": {"X-Up-Authenticity-Signature": _sign(raw)},
    }
    assert wired.up.lambda_handler(event, None) == wired.up.OK_RESPONSE
    assert len(wired.sent) == 1


# [E3] signature is verified over the EXACT raw bytes.
# Up signs the literal delivered bytes. This body has non-canonical spacing that
# json.dumps would never reproduce; the signature is over those exact bytes. If the code
# ever verified over a re-serialised payload (json.loads → json.dumps), the digest would
# differ and this would 401. Proves the "raw, not re-serialised" contract.
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


# [E4] a REAL Up PING (no transaction relationship).
# Up's registration PING has NO `relationships.transaction` — only a webhook link. The
# unit PING test smuggles in a transaction id, so it can't catch a regression that calls
# get_transaction_id before the eventType short-circuit. This payload would KeyError → 500
# if the order flipped; it must ack 200 with no fetch/push.
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
    assert _marked(wired.notify) == []


# [E5] a partial fetched transaction → clean 500, no push.
# If Up ever returns a transaction missing relationships/account (or a shape change),
# repayment_skip_reason raises KeyError. Because it runs INSIDE the handler's try, it must
# surface as the clean ERROR_RESPONSE (Up retries) — never a push, never a mark, never an
# uncaught crash. Locks the guard around the qualify/notify block.
def test_partial_transaction_missing_account_returns_500(wired, monkeypatch):
    partial = {"id": "txn-1", "attributes": {"amount": {"valueInBaseUnits": 357300}}}
    monkeypatch.setattr(wired.up, "fetch_transaction", lambda _id: partial)
    result = wired.up.lambda_handler(_event(_webhook_payload()), None)
    assert result == wired.up.ERROR_RESPONSE
    assert wired.sent == []
    assert _marked(wired.notify) == []


# [E6] valueInBaseUnits coercion.
# Up sends valueInBaseUnits as a JSON integer, but the code defensively wraps it in int().
# Lock that coercion: a string amount still qualifies. Remove the int() and a str >= int
# comparison raises TypeError in Python 3.
def test_value_in_base_units_string_is_coerced(skip_up):
    txn = _up_transaction(cents="357300")  # a string, as some JSON:API encoders emit
    assert skip_up.repayment_skip_reason(txn) is None


def _boom(message):
    def _raise(*args, **kwargs):
        raise RuntimeError(message)
    return _raise


# --- QA (WHIT-616): adversarial edges the tests above don't pin --------------

# [A1] Dedupe is checked BEFORE the device list. A retried/duplicate delivery of an
# already-pushed repayment must log a plain skip — never the NO_DEVICE_TOKENS alarm marker,
# or every Up redelivery after a phone unregisters would page.
def test_already_notified_wins_over_no_device_tokens(wired, monkeypatch, caplog):
    _already_fired(wired.notify, "txn-1")
    monkeypatch.setattr(wired.up, "DeviceRepository", lambda: _FakeDevice([]))
    caplog.set_level(logging.INFO)
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    assert _skip_reasons(caplog) == ["already_notified"]
    assert not _marker_records(caplog, "UP_WEBHOOK_NO_DEVICE_TOKENS")


# [A2] End-to-end token recovery on a warm container: delivery 1 is rejected with the
# cached (revoked) token; Jas replaces it in SSM; Up's retry must send the NEW token and push.
def test_replaced_token_is_used_on_next_delivery(fetch_wired, lam, monkeypatch):
    up = fetch_wired.up
    ssm = {"value": "old-pat-value"}
    monkeypatch.setattr(lam.api_key, "get_param", lambda path: ssm["value"])
    seen = []

    def fake_urlopen(request, timeout=None):
        auth = request.get_header("Authorization")
        seen.append(auth)
        if auth == "Bearer old-pat-value":
            raise http_error(401, url=UP_API_URL)
        return FakeResponse({"data": _up_transaction()})

    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    assert up.lambda_handler(_event(_webhook_payload()), None) == up.ERROR_RESPONSE
    ssm["value"] = "new-pat-value"
    assert up.lambda_handler(_event(_webhook_payload()), None) == up.OK_RESPONSE
    assert seen == ["Bearer old-pat-value", "Bearer new-pat-value"]
    assert len(fetch_wired.sent) == 1


# [A4] "Any other fetch failure logs UP_WEBHOOK_FETCH_FAILED". Up (or a proxy) dropping the
# connection raises http.client.RemoteDisconnected (a ConnectionResetError, NOT a URLError);
# a truncated body raises http.client.IncompleteRead. Both currently bypass the marker.
@pytest.mark.parametrize("error", [http.client.RemoteDisconnected("closed"),
                                   http.client.IncompleteRead(b"{")])
def test_dropped_connection_logs_fetch_failed(fetch_wired, monkeypatch, caplog, error):
    up = fetch_wired.up
    monkeypatch.setattr(up.urllib.request, "urlopen", _urlopen_raising(error))
    caplog.set_level(logging.INFO)
    assert up.lambda_handler(_event(_webhook_payload()), None) == up.ERROR_RESPONSE
    assert _marker_records(caplog, "UP_WEBHOOK_FETCH_FAILED", logging.ERROR)


# [A5] Every delivery that gets past the signature ends in exactly ONE outcome line, so a
# CloudWatch search on the transaction id tells the whole story.
_OUTCOMES = ("UP_WEBHOOK_SKIP", "UP_WEBHOOK_NO_DEVICE_TOKENS", "UP_WEBHOOK_PUSH_SENT")


@pytest.mark.parametrize("setup, expected", [
    (lambda w, mp: None, "UP_WEBHOOK_PUSH_SENT"),
    (lambda w, mp: mp.setattr(w.up, "DeviceRepository", lambda: _FakeDevice([])),
     "UP_WEBHOOK_NO_DEVICE_TOKENS"),
    (lambda w, mp: _already_fired(w.notify, "txn-1"), "UP_WEBHOOK_SKIP"),
    (lambda w, mp: mp.setattr(w.up, "fetch_transaction", lambda _id: _up_transaction(cents=1)),
     "UP_WEBHOOK_SKIP"),
    (lambda w, mp: mp.setattr(w.up, "fetch_transaction",
                              lambda _id: _up_transaction(account_id="x")), "UP_WEBHOOK_SKIP"),
], ids=["sent", "no_tokens", "already", "below_floor", "wrong_account"])
def test_each_delivery_logs_exactly_one_outcome(wired, monkeypatch, caplog, setup, expected):
    setup(wired, monkeypatch)
    caplog.set_level(logging.INFO)
    assert wired.up.lambda_handler(_event(_webhook_payload()), None) == wired.up.OK_RESPONSE
    outcomes = [m for m in _OUTCOMES for r in caplog.records if m in r.getMessage().split()]
    assert outcomes == [expected]


# --- WHIT-618: the home loan is found by account type, with a fixed-id fallback ---

@pytest.mark.parametrize("body", [{"items": []}, {"data": [{"id": "loan-x"}]}],
                         ids=["no_data", "no_attributes"])
def test_homeloan_lookup_with_unexpected_shape_falls_back_unsaved(lam, monkeypatch, caplog, body):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_personal_access_token", lambda: "up-token")
    calls = []

    def fake_urlopen(request, timeout=None):
        calls.append(request)
        return FakeResponse(body)

    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    caplog.set_level(logging.INFO)

    assert up.get_homeloan_account_id() == HOMELOAN_UUID
    assert up.get_homeloan_account_id() == HOMELOAN_UUID
    [first, _second] = _marker_records(caplog, "UP_WEBHOOK_HOMELOAN_LOOKUP_FALLBACK")
    assert "reason=lookup_failed" in first.getMessage().split()
    assert len(calls) == 2


def test_homeloan_lookup_token_failure_falls_back(lam, monkeypatch, caplog):
    up = lam.up_webhook
    monkeypatch.setattr(up, "get_personal_access_token", _boom("SSM down"))
    caplog.set_level(logging.INFO)
    assert up.get_homeloan_account_id() == HOMELOAN_UUID
    [record] = _marker_records(caplog, "UP_WEBHOOK_HOMELOAN_LOOKUP_FALLBACK")
    assert "reason=lookup_failed" in record.getMessage().split()


def test_homeloan_lookup_failure_still_pushes_on_fixed_id(fetch_wired, monkeypatch, caplog):
    up = fetch_wired.up
    monkeypatch.setattr(up, "get_homeloan_account_id", fetch_wired.real_homeloan_lookup)

    def fake_urlopen(request, timeout=None):
        if "/transactions/" in request.full_url:
            return FakeResponse({"data": _up_transaction()})
        raise http_error(500, url=UP_API_URL)

    monkeypatch.setattr(up.urllib.request, "urlopen", fake_urlopen)
    caplog.set_level(logging.INFO)
    assert up.lambda_handler(_event(_webhook_payload()), None) == up.OK_RESPONSE
    assert len(fetch_wired.sent) == 1
    assert _marker_records(caplog, "UP_WEBHOOK_HOMELOAN_LOOKUP_FALLBACK", logging.WARNING)


@pytest.mark.parametrize("amount, shown", [
    ("3667", "$3,667"),
    ("3667.50", "$3,668"),        # cents round to whole dollars
    ("3668.50", "$3,668"),        # Decimal rounds half to even
    ("1000000", "$1,000,000"),
    ("10.00", "$10"),
])
def test_repayment_push_copy(lam, amount, shown):
    title, body = lam.up_webhook.build_repayment_push(Decimal(amount))
    assert title == "Nice one! Another chunk down"
    assert f"{shown} toward the mortgage" in body
