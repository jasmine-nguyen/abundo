"""Tests for ``lambda/handler.py``'s ``lambda_handler`` control flow: the verify →
dedup → process gate, and — critically — what happens when the DB write fails.

The suite's ``lam`` fixture stubs signature verification (conftest's fake
``Webhook.verify`` → ``{}``), so signature *content* is covered separately in
``test_webhook_verify.py``. Here we drive the handler by monkeypatching
``verify_and_parse`` / ``process_transaction`` / ``TransactionRepository`` so we
can steer the id, the payload, and the failure, and observe the routing.

Two tests are ``xfail(strict)`` — they encode the CORRECT behaviour for a known
data-loss bug (see Board: "BUG: BankSync webhook drops transactions when a write
fails"). They fail today and will flip to a hard failure once the bug is fixed,
which is the signal to drop the marker.
"""

import base64
import importlib.util
import json
import pathlib
from datetime import datetime, timezone

import pytest

# The real Standard-Webhooks verifier, loaded off disk (the suite's conftest
# swaps in a no-op fake), so verify_and_parse can be tested end-to-end.
_WEBHOOKS_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / "lambda" / "standardwebhooks" / "webhooks.py"
)
_spec = importlib.util.spec_from_file_location("_real_sw_webhooks_h", _WEBHOOKS_PATH)
_real_webhooks = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_real_webhooks)
_RealWebhook = _real_webhooks.Webhook
_SECRET = base64.b64encode(b"whittle-test-signing-key").decode()


class _Repo:
    """Minimal repo double. ``is_new_event`` marks an id seen on first sight and
    returns False thereafter — the real DynamoDB idempotency gate's semantics."""

    def __init__(self):
        self._seen = set()
        self.failed_batches = []

    def is_new_event(self, envelope_id: str) -> bool:
        if envelope_id in self._seen:
            return False
        self._seen.add(envelope_id)
        return True

    def save_failed_transactions(self, rows):
        self.failed_batches.append(rows)

    def insert_or_reconcile(self, txns):
        pass


def _wire(lam, monkeypatch, repo, payload):
    """Point the handler at ``repo`` and make verify return ``payload``."""
    handler = lam.handler
    monkeypatch.setattr(handler, "verify_and_parse", lambda event: payload)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    return handler


# --- the verify → dedup → process gate --------------------------------------


def test_valid_event_is_processed_and_returns_ok(lam, monkeypatch):
    handler = lam.handler
    seen = {}
    monkeypatch.setattr(handler, "process_transaction",
                        lambda payload, repo: seen.update(payload=payload))
    handler = _wire(lam, monkeypatch, _Repo(), {"id": "evt_1", "data": [{"a": 1}]})

    resp = handler.lambda_handler({}, None)

    assert resp["statusCode"] == 200 and resp["body"] == "ok"
    assert seen["payload"]["id"] == "evt_1"  # processing actually ran


def test_duplicate_event_is_skipped_without_processing(lam, monkeypatch):
    handler = lam.handler
    calls = []
    monkeypatch.setattr(handler, "process_transaction",
                        lambda payload, repo: calls.append(payload))
    repo = _Repo()
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_dup", "data": []})

    first = handler.lambda_handler({}, None)
    second = handler.lambda_handler({}, None)  # same id re-delivered

    assert first["statusCode"] == 200 and first["body"] == "ok"
    assert second["statusCode"] == 200 and second["body"] == "duplicate event - skipped"
    assert len(calls) == 1  # processed exactly once


def test_invalid_signature_returns_401(lam, monkeypatch):
    handler = lam.handler

    def boom(event):
        raise ValueError("bad signature")

    monkeypatch.setattr(handler, "verify_and_parse", boom)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _Repo())

    resp = handler.lambda_handler({}, None)
    assert resp["statusCode"] == 401


# --- verify_and_parse: real signature glue ----------------------------------


def _signed_event(data: str, *, base64_body: bool, mixed_case_headers: bool):
    """An API-Gateway-shaped event carrying a validly-signed body."""
    wh = _RealWebhook(_SECRET)
    ts = datetime.now(tz=timezone.utc)
    sig = wh.sign(msg_id="evt_1", timestamp=ts, data=data)
    hdr = {
        "webhook-id": "evt_1",
        "webhook-timestamp": str(int(ts.timestamp())),
        "webhook-signature": sig,
    }
    if mixed_case_headers:  # BankSync/API Gateway may send Title-Case headers
        hdr = {"Webhook-Id": hdr["webhook-id"],
               "Webhook-Timestamp": hdr["webhook-timestamp"],
               "Webhook-Signature": hdr["webhook-signature"]}
    body = base64.b64encode(data.encode()).decode() if base64_body else data
    return {"body": body, "headers": hdr, "isBase64Encoded": base64_body}


def _use_real_verifier(lam, monkeypatch):
    handler = lam.handler
    monkeypatch.setattr(handler, "Webhook", _RealWebhook)
    monkeypatch.setattr(handler, "_webhook_signing_secret", _SECRET)  # skip SSM
    return handler


def test_verify_and_parse_accepts_a_validly_signed_body(lam, monkeypatch):
    handler = _use_real_verifier(lam, monkeypatch)
    data = json.dumps({"id": "evt_1", "data": [{"amount": -5.5}]})
    event = _signed_event(data, base64_body=False, mixed_case_headers=True)

    assert handler.verify_and_parse(event) == {"id": "evt_1", "data": [{"amount": -5.5}]}


def test_verify_and_parse_decodes_a_base64_body(lam, monkeypatch):
    handler = _use_real_verifier(lam, monkeypatch)
    data = json.dumps({"id": "evt_1", "data": []})
    event = _signed_event(data, base64_body=True, mixed_case_headers=False)

    assert handler.verify_and_parse(event) == {"id": "evt_1", "data": []}


def test_lambda_handler_rejects_a_tampered_body_with_401(lam, monkeypatch):
    handler = _use_real_verifier(lam, monkeypatch)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _Repo())
    data = json.dumps({"id": "evt_1", "data": []})
    event = _signed_event(data, base64_body=False, mixed_case_headers=False)
    event["body"] = data + " "  # mutate after signing → signature no longer matches

    assert handler.lambda_handler(event, None)["statusCode"] == 401


# --- data-loss regressions (see Board bug card) -----------------------------


@pytest.mark.xfail(strict=True, reason="BUG: event marked seen before the write; a "
                   "failed delivery is dropped on retry. See Board bug card.")
def test_write_failure_then_retry_is_not_dropped(lam, monkeypatch):
    # First delivery's processing raises (RuntimeError — what handle_database_error
    # actually raises). BankSync retries with the same envelope id. The retry MUST
    # re-process, not get waved through as a duplicate.
    handler = lam.handler
    attempts = {"n": 0}

    def flaky_process(payload, repo):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("Database write failed")

    monkeypatch.setattr(handler, "process_transaction", flaky_process)
    handler = _wire(lam, monkeypatch, _Repo(), {"id": "evt_1", "data": [{"a": 1}]})

    handler.lambda_handler({}, None)  # delivery 1 → write fails
    handler.lambda_handler({}, None)  # delivery 2 → retry

    assert attempts["n"] >= 2  # today: 1 (retry skipped as duplicate) → data lost


@pytest.mark.xfail(strict=True, reason="BUG: a ClientError during insert is swallowed "
                   "inside process_transaction and the handler returns 200 'ok' with "
                   "nothing written — BankSync never retries. See Board bug card.")
def test_client_error_during_insert_is_not_reported_as_ok(lam, monkeypatch):
    # Use the REAL process_transaction so the ClientError→swallow path runs. A row
    # that normalises cleanly reaches insert_or_reconcile, which raises ClientError.
    import botocore.exceptions  # the conftest fake ClientError

    handler = lam.handler

    class _RaisingRepo(_Repo):
        def insert_or_reconcile(self, txns):
            raise botocore.exceptions.ClientError()

    valid_row = {
        "id": "B", "date": "2026-06-29", "authorizedDate": "2026-06-29",
        "description": "SQ *KKV INTERNATIONAL PTY", "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": "-5.50", "accountId": "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0",
        "accountName": "ANZ Rewards Black Visa", "category": "FOOD_AND_DRINK",
        "pending": False, "type": "PAYMENT", "pendingTransactionId": None,
    }
    monkeypatch.setattr(handler, "verify_and_parse",
                        lambda e: {"id": "evt_1", "data": [valid_row]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _RaisingRepo())

    resp = handler.lambda_handler({}, None)
    # A failed write must not masquerade as success.
    assert not (resp["statusCode"] == 200 and resp["body"] == "ok")
