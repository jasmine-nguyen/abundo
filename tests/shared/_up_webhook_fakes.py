"""Shared setup for the Up webhook tests (tests/lambda/test_up_webhook*.py).

The signing secret, the home-loan ID, an HMAC signer, the webhook envelope + signed event
builders and a sample Up transaction. The fake phone is `_milestone_fakes.FakeDeviceRepo`.
Stdlib only, so it's safe to import before the `lam` fixture loads the lambda modules.
Resolved by pytest.ini's `pythonpath = tests/shared`.
"""

import base64
import hashlib
import hmac
import json

MOCK_SECRET = "mock-secret"
# Mirrors the handler's fallback home-loan ID (lambda/up_webhook.py UP_HOMELOAN_ACCOUNT_ID).
HOMELOAN_ID = "fbef6cbc-09b3-4b6f-826c-6a178707a178"
SIGNATURE_KEY = "x-up-authenticity-signature"


def sign(raw: bytes) -> str:
    return hmac.new(MOCK_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()


def webhook_payload(event_type="TRANSACTION_CREATED", transaction_id="txn-1") -> dict:
    """The thin webhook envelope Up POSTs — carries the event type + transaction id."""
    return {
        "data": {
            "attributes": {"eventType": event_type},
            "relationships": {"transaction": {"data": {"id": transaction_id}}},
        }
    }


def up_transaction(account_id=HOMELOAN_ID, cents=357300, transaction_id="txn-1") -> dict:
    """The full transaction fetch_transaction returns (Up's `data` object)."""
    return {
        "id": transaction_id,
        "attributes": {"amount": {"valueInBaseUnits": cents}},
        "relationships": {"account": {"data": {"id": account_id}}},
    }


def signed_event(payload: dict, *, header=True, is_base64=False) -> dict:
    raw = json.dumps(payload).encode("utf-8")
    body = base64.b64encode(raw).decode("utf-8") if is_base64 else raw.decode("utf-8")
    headers = {SIGNATURE_KEY: sign(raw)} if header else {}
    return {"body": body, "isBase64Encoded": is_base64, "headers": headers}
