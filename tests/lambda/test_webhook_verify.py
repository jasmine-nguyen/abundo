"""Tests for the vendored Standard Webhooks verifier (``lambda/standardwebhooks/
webhooks.py``) — the signature check that guards the ONLY write path into the DB.

The webhook lambda suite's ``conftest.py`` stubs ``Webhook.verify`` to always
return ``{}`` (so the handler imports without AWS), which means the real HMAC
verification, timestamp tolerance, and header checks run in *no* other test.
Here we load the real module in isolation — it's pure stdlib (hmac/base64/json),
no relative imports — and exercise it directly.
"""

import base64
import importlib.util
import json
import pathlib
from datetime import datetime, timedelta, timezone

import pytest

# Load the real webhooks.py straight off disk under a private module name so it
# can't collide with (or be shadowed by) the conftest ``standardwebhooks`` fake.
_WEBHOOKS_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / "lambda" / "standardwebhooks" / "webhooks.py"
)
_spec = importlib.util.spec_from_file_location("_real_sw_webhooks", _WEBHOOKS_PATH)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
Webhook = _mod.Webhook
WebhookVerificationError = _mod.WebhookVerificationError

# A base64 secret is what BankSync/Standard-Webhooks hand you.
_SECRET = base64.b64encode(b"whittle-test-signing-key").decode()
_OTHER_SECRET = base64.b64encode(b"a-different-key-entirely").decode()


def _headers(wh: "Webhook", msg_id: str, data: str, ts: datetime | None = None):
    """Build a validly-signed Standard-Webhooks header set for ``data``."""
    ts = ts or datetime.now(tz=timezone.utc)
    return {
        "webhook-id": msg_id,
        "webhook-timestamp": str(int(ts.timestamp())),
        "webhook-signature": wh.sign(msg_id=msg_id, timestamp=ts, data=data),
    }


def test_round_trip_valid_signature_returns_parsed_payload():
    wh = Webhook(_SECRET)
    data = json.dumps({"id": "evt_1", "data": [{"amount": -5.5}]})
    out = wh.verify(data, _headers(wh, "evt_1", data))
    assert out == {"id": "evt_1", "data": [{"amount": -5.5}]}  # returns json.loads(data)


def test_bad_signature_is_rejected():
    wh = Webhook(_SECRET)
    forger = Webhook(_OTHER_SECRET)  # signs with the wrong key
    data = json.dumps({"id": "evt_1", "data": []})
    bad = _headers(forger, "evt_1", data)  # valid shape, wrong signature
    with pytest.raises(WebhookVerificationError):
        wh.verify(data, bad)


def test_tampered_body_is_rejected():
    wh = Webhook(_SECRET)
    data = json.dumps({"id": "evt_1", "data": []})
    headers = _headers(wh, "evt_1", data)
    with pytest.raises(WebhookVerificationError):
        wh.verify(data + " ", headers)  # body changed after signing → no match


def test_missing_headers_are_rejected():
    wh = Webhook(_SECRET)
    with pytest.raises(WebhookVerificationError):
        wh.verify(json.dumps({"id": "x"}), {})


def test_timestamp_too_old_is_rejected():
    wh = Webhook(_SECRET)
    data = json.dumps({"id": "evt_1", "data": []})
    stale = datetime.now(tz=timezone.utc) - timedelta(minutes=6)  # outside ±5 min
    with pytest.raises(WebhookVerificationError):
        wh.verify(data, _headers(wh, "evt_1", data, ts=stale))


def test_timestamp_too_new_is_rejected():
    wh = Webhook(_SECRET)
    data = json.dumps({"id": "evt_1", "data": []})
    future = datetime.now(tz=timezone.utc) + timedelta(minutes=6)
    with pytest.raises(WebhookVerificationError):
        wh.verify(data, _headers(wh, "evt_1", data, ts=future))


def test_whsec_prefixed_secret_decodes_to_the_same_key():
    # BankSync may hand the secret with a ``whsec_`` prefix; it must verify the
    # same as the bare base64 form.
    plain = Webhook(_SECRET)
    prefixed = Webhook("whsec_" + _SECRET)
    data = json.dumps({"id": "evt_1", "data": []})
    headers = _headers(plain, "evt_1", data)
    assert prefixed.verify(data, headers) == {"id": "evt_1", "data": []}


def test_empty_secret_raises():
    with pytest.raises(RuntimeError):
        Webhook("")


def test_first_matching_v1_signature_in_a_space_list_passes():
    # Standard Webhooks allows a space-separated list of versioned signatures
    # (key rotation). A junk sig followed by the real one must still verify.
    wh = Webhook(_SECRET)
    data = json.dumps({"id": "evt_1", "data": []})
    good = _headers(wh, "evt_1", data)
    good["webhook-signature"] = "v1,Zm9v " + good["webhook-signature"]  # junk then real
    assert wh.verify(data, good) == {"id": "evt_1", "data": []}
