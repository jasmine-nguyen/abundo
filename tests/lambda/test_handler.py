"""Tests for ``lambda/handler.py`` — the BankSync webhook, the only write path
into DynamoDB.

Two concerns:

1. **Signature handling is our contract, not the library's.** ``standardwebhooks``
   is a pinned third-party dependency (``lambda/requirements.txt``); we don't
   unit-test its internals. We DO test that our ``verify_and_parse`` glue
   (base64 body decode, header lowercasing) and ``lambda_handler`` reject a bad
   / stale / unsigned request with a 401 — using real signatures from the real
   library.
2. **The verify → dedup → process control flow**, including what happens when the
   DB write fails.

The suite's ``lam`` fixture stubs ``standardwebhooks`` while importing the handler
(so it imports without AWS); these tests monkeypatch ``handler.Webhook`` back to
the real class and set a known secret, so real HMAC verification runs.

The "data-loss regressions" section locks in the WHIT-83 fix (a failed write
leaves the event unmarked so BankSync's retry re-processes it, and a failed insert
surfaces as 500 rather than a false 200 "ok").
"""

import base64
import json
import logging
from datetime import datetime, timezone

import pytest

from _dynamo_fakes import FakeTable
from standardwebhooks.webhooks import Webhook as _RealWebhook

_SECRET = base64.b64encode(b"abundo-test-signing-key").decode()


def _real_repo(lam):
    """The webhook's own TransactionRepository over the shared FakeTable, so the dedup marker is
    the real has_event / mark_event (save-then-mark)."""
    repo = lam.repository.TransactionRepository()
    repo._table = FakeTable()
    return repo


def _wire(lam, monkeypatch, repo, payload):
    """Point the handler at ``repo`` and make verify return ``payload``."""
    handler = lam.handler
    monkeypatch.setattr(handler, "verify_and_parse", lambda event: payload)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    return handler


# --- the verify → dedup → process gate --------------------------------------


def test_summary_event_without_data_key_is_acked_not_500(lam, monkeypatch):
    # A BankSync `sync.completed` summary delivery carries NO "data" key (unlike a
    # transaction event). It must be treated as zero rows and acked with 200 — not
    # KeyError'd into a 500 that BankSync then retries forever (WHIT-302 cutover).
    # Runs the REAL process_transaction: fail-on-revert — restore `payload["data"]`
    # and this goes 500.
    handler = _wire(lam, monkeypatch, _real_repo(lam), {"id": "evt_summary"})  # note: no "data"

    resp = handler.lambda_handler({}, None)

    assert resp == {"statusCode": 200, "body": "ok"}


# --- observability: per-delivery log line ------------------------------------


def test_summary_delivery_logs_keys_and_allow_listed_fields_only(lam, monkeypatch, caplog):
    # WHIT-606: a row-less delivery logs its shape so a stalled feed can be diagnosed, but only
    # allow-listed plain values — an unknown field's value never reaches the logs.
    handler = lam.handler
    monkeypatch.setattr(handler, "process_transaction", lambda payload, repo: None)
    payload = {
        "id": "evt_sum", "data": [], "status": "failed", "error": "consent expired",
        "account_number": "123-456", "job": {"state": "error", "feed": "f1"},
    }
    handler = _wire(lam, monkeypatch, _real_repo(lam), payload)

    with caplog.at_level(logging.INFO, logger="handler"):
        handler.lambda_handler({}, None)

    summary_line = next(r.getMessage() for r in caplog.records if "summary:" in r.getMessage())
    assert "'status': 'failed'" in summary_line
    assert "'error': 'consent expired'" in summary_line
    assert "account_number" in summary_line          # the key is logged...
    assert "123-456" not in summary_line             # ...its value is not
    assert "'job': ['feed', 'state']" in summary_line
    assert "'state': 'error'" not in summary_line   # nested values aren't logged either


def test_summary_delivery_hides_an_allow_listed_key_holding_an_object(lam, caplog):
    payload = {"id": "evt_obj", "data": [], "error": {"detail": "card 4111-1111 declined"},
               "timestamp": 1790000000}

    with caplog.at_level(logging.INFO, logger="handler"):
        lam.handler.log_summary_delivery(payload)

    assert "4111-1111" not in caplog.text
    assert "'error': ['detail']" in caplog.text
    assert "'timestamp': '1790000000'" in caplog.text


# --- signature glue: real verification through our handler -------------------


def _signed_event(data: str, *, base64_body: bool, mixed_case_headers: bool,
                  ts: datetime | None = None):
    """An API-Gateway-shaped event carrying a validly-signed body."""
    wh = _RealWebhook(_SECRET)
    ts = ts or datetime.now(tz=timezone.utc)
    sig = wh.sign(msg_id="evt_1", timestamp=ts, data=data)
    hdr = {
        "webhook-id": "evt_1",
        "webhook-timestamp": str(int(ts.timestamp())),
        "webhook-signature": sig,
    }
    if mixed_case_headers:  # BankSync / API Gateway may send Title-Case headers
        hdr = {k.title(): v for k, v in hdr.items()}
    body = base64.b64encode(data.encode()).decode() if base64_body else data
    return {"body": body, "headers": hdr, "isBase64Encoded": base64_body}


def _use_real_verifier(lam, monkeypatch):
    handler = lam.handler
    monkeypatch.setattr(handler, "Webhook", _RealWebhook)
    lam.api_key._cache[handler.BANKSYNC_WEBHOOK_SECRET_PATH] = _SECRET  # skip SSM
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


def test_tampered_body_is_rejected_with_401(lam, monkeypatch):
    handler = _use_real_verifier(lam, monkeypatch)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _real_repo(lam))
    data = json.dumps({"id": "evt_1", "data": []})
    event = _signed_event(data, base64_body=False, mixed_case_headers=False)
    event["body"] = data + " "  # mutate after signing → signature no longer matches

    assert handler.lambda_handler(event, None)["statusCode"] == 401


def test_unsigned_request_is_rejected_with_401(lam, monkeypatch):
    handler = _use_real_verifier(lam, monkeypatch)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _real_repo(lam))
    event = {"body": json.dumps({"id": "evt_1"}), "headers": {}, "isBase64Encoded": False}

    assert handler.lambda_handler(event, None)["statusCode"] == 401


def test_stale_timestamp_is_rejected_with_401(lam, monkeypatch):
    handler = _use_real_verifier(lam, monkeypatch)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _real_repo(lam))
    data = json.dumps({"id": "evt_1", "data": []})
    # Validly signed, but the timestamp is outside the ±5-minute replay window.
    stale = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
    event = _signed_event(data, base64_body=False, mixed_case_headers=False, ts=stale)

    assert handler.lambda_handler(event, None)["statusCode"] == 401


# --- data-loss regressions (see Board bug card) -----------------------------


def test_client_error_during_insert_is_not_reported_as_ok(lam, monkeypatch):
    # Use the REAL process_transaction so the real insert path runs. A row that
    # normalises cleanly reaches insert_or_reconcile, which raises ClientError; with
    # the swallow removed, that must surface as a 500 (not a false 200 "ok").
    import botocore.exceptions  # the conftest fake ClientError

    handler = lam.handler

    def raising_insert(txns, *, is_unfiled=None):
        raise botocore.exceptions.ClientError()

    repo = _real_repo(lam)
    monkeypatch.setattr(repo, "insert_or_reconcile", raising_insert)

    valid_row = {
        "id": "B", "date": "2026-06-29", "authorizedDate": "2026-06-29",
        "description": "SQ *KKV INTERNATIONAL PTY", "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": "-5.50", "accountId": "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0",
        "accountName": "ANZ Rewards Black Visa", "category": "FOOD_AND_DRINK",
        "pending": False, "type": "PAYMENT", "pendingTransactionId": None,
    }
    monkeypatch.setattr(handler, "verify_and_parse",
                        lambda e: {"id": "evt_1", "data": [valid_row]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)

    resp = handler.lambda_handler({}, None)
    # A failed write must honestly return 500 (→ BankSync retries), not masquerade
    # as a 200 "ok" that means nothing was written.
    assert resp["statusCode"] == 500


# --- save-then-mark specifics (WHIT-83) -------------------------------------


def test_mark_event_failure_after_write_retries_without_loss(lam, monkeypatch):
    # The write succeeds but mark_event (called AFTER, at handler.py:60) fails on a
    # transient DB blip. mark_event sits OUTSIDE the try/except, so the error is
    # UNCAUGHT and propagates out of lambda_handler -> BankSync sees a failure and
    # retries. The event was never marked, so the retry re-processes (idempotent
    # overwrite) and this time marks it. Nothing is dropped. Locks current behaviour;
    # a clean 500 here would be an improvement (see edge-case critique).
    handler = lam.handler
    repo = _real_repo(lam)
    writes = {"n": 0}

    def counting_process(payload, repo_):
        writes["n"] += 1  # the write itself succeeded

    monkeypatch.setattr(handler, "process_transaction", counting_process)

    calls = {"n": 0}
    real_mark = repo.mark_event

    def flaky_mark(envelope_id):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("mark_event failed")  # transient DynamoDB error
        real_mark(envelope_id)

    monkeypatch.setattr(repo, "mark_event", flaky_mark)
    h = _wire(lam, monkeypatch, repo, {"id": "evt_1", "data": []})

    # Delivery 1: write ok, marking fails -> uncaught -> BankSync retries.
    with pytest.raises(RuntimeError):
        h.lambda_handler({}, None)
    assert repo.has_event("evt_1") is False  # not marked -> retry will re-process

    # Delivery 2 (retry): re-processes and marks successfully. No loss.
    resp2 = h.lambda_handler({}, None)
    assert resp2 == {"statusCode": 200, "body": "ok"}
    assert writes["n"] == 2                   # re-processed, nothing dropped
    assert repo.has_event("evt_1") is True


def test_dedup_and_retry_through_real_repository(lam, repo, monkeypatch):
    # Integration guard: drive the handler through the REAL has_event / mark_event
    # (the `repo` fixture), so a method rename or a gate-semantics
    # regression is caught end-to-end. On the reverted mark-before-write code the
    # marker would exist after delivery 1 -> the first assertion below fails.
    handler = lam.handler
    attempts = {"n": 0}

    def flaky(payload, repo_):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("write failed")

    monkeypatch.setattr(handler, "process_transaction", flaky)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "verify_and_parse", lambda e: {"id": "evt_1", "data": []})

    r1 = handler.lambda_handler({}, None)  # write fails -> NOT marked
    assert r1["statusCode"] == 500
    assert ("EVENT#evt_1", "EVENT") not in repo._table.store  # real repo: no marker

    r2 = handler.lambda_handler({}, None)  # retry re-processes -> marks
    assert r2 == {"statusCode": 200, "body": "ok"}
    assert attempts["n"] == 2
    assert ("EVENT#evt_1", "EVENT") in repo._table.store       # real marker written

    r3 = handler.lambda_handler({}, None)  # redelivery deduped by real has_event
    assert r3["body"] == "duplicate event - skipped"
    assert attempts["n"] == 2                                  # not re-processed
