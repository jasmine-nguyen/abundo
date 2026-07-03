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
surfaces as 500 rather than a false 200 "ok") and the WHIT-84 dead-letter uuid.
"""

import base64
import json
from datetime import datetime, timezone

import pytest

from standardwebhooks.webhooks import Webhook as _RealWebhook

_SECRET = base64.b64encode(b"whittle-test-signing-key").decode()


class _Repo:
    """Minimal repo double mirroring the real save-then-mark semantics: has_event
    reports whether an id was marked; mark_event marks it (called only after a
    successful write)."""

    def __init__(self):
        self._seen = set()
        self.failed_batches = []

    def has_event(self, envelope_id: str) -> bool:
        return envelope_id in self._seen

    def mark_event(self, envelope_id: str) -> None:
        self._seen.add(envelope_id)

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
    handler = _wire(lam, monkeypatch, _Repo(), {"id": "evt_dup", "data": []})

    first = handler.lambda_handler({}, None)
    second = handler.lambda_handler({}, None)  # same id re-delivered

    assert first["statusCode"] == 200 and first["body"] == "ok"
    assert second["statusCode"] == 200 and second["body"] == "duplicate event - skipped"
    assert len(calls) == 1  # processed exactly once


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


def test_tampered_body_is_rejected_with_401(lam, monkeypatch):
    handler = _use_real_verifier(lam, monkeypatch)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _Repo())
    data = json.dumps({"id": "evt_1", "data": []})
    event = _signed_event(data, base64_body=False, mixed_case_headers=False)
    event["body"] = data + " "  # mutate after signing → signature no longer matches

    assert handler.lambda_handler(event, None)["statusCode"] == 401


def test_unsigned_request_is_rejected_with_401(lam, monkeypatch):
    handler = _use_real_verifier(lam, monkeypatch)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _Repo())
    event = {"body": json.dumps({"id": "evt_1"}), "headers": {}, "isBase64Encoded": False}

    assert handler.lambda_handler(event, None)["statusCode"] == 401


def test_stale_timestamp_is_rejected_with_401(lam, monkeypatch):
    handler = _use_real_verifier(lam, monkeypatch)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _Repo())
    data = json.dumps({"id": "evt_1", "data": []})
    # Validly signed, but the timestamp is outside the ±5-minute replay window.
    stale = datetime.fromtimestamp(1_700_000_000, tz=timezone.utc)
    event = _signed_event(data, base64_body=False, mixed_case_headers=False, ts=stale)

    assert handler.lambda_handler(event, None)["statusCode"] == 401


# --- data-loss regressions (see Board bug card) -----------------------------


def test_write_failure_then_retry_is_not_dropped(lam, monkeypatch):
    # First delivery's processing raises (RuntimeError — what handle_database_error
    # actually raises). BankSync retries with the same envelope id. The retry MUST
    # re-process, not get waved through as a duplicate (WHIT-83).
    handler = lam.handler
    attempts = {"n": 0}

    def flaky_process(payload, repo):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("Database write failed")

    monkeypatch.setattr(handler, "process_transaction", flaky_process)
    handler = _wire(lam, monkeypatch, _Repo(), {"id": "evt_1", "data": [{"a": 1}]})

    resp1 = handler.lambda_handler({}, None)  # delivery 1 → write fails
    resp2 = handler.lambda_handler({}, None)  # delivery 2 → retry re-processes

    assert attempts["n"] == 2                          # retry re-processed (event never marked)
    assert resp1["statusCode"] == 500                  # failure surfaced → BankSync retries
    assert resp2 == {"statusCode": 200, "body": "ok"}  # retry succeeded, nothing dropped


def test_failing_event_is_not_marked_seen(lam, monkeypatch):
    # WHIT-83 boundary: a failed event must be left UNMARKED (so its retry
    # re-processes), while a sibling event that succeeded stays marked (its
    # redelivery is deduped). save-then-mark gives this for free — no rollback.
    handler = lam.handler
    repo = _Repo()

    def selective_process(payload, repo):
        if payload["id"] == "evt_fail":
            raise RuntimeError("write failed")

    monkeypatch.setattr(handler, "process_transaction", selective_process)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)

    # evt_ok processes cleanly → gets marked.
    monkeypatch.setattr(handler, "verify_and_parse", lambda e: {"id": "evt_ok", "data": []})
    assert handler.lambda_handler({}, None)["statusCode"] == 200

    # evt_fail fails → is never marked.
    monkeypatch.setattr(handler, "verify_and_parse", lambda e: {"id": "evt_fail", "data": []})
    assert handler.lambda_handler({}, None)["statusCode"] == 500

    assert "evt_ok" in repo._seen        # succeeded → marked
    assert "evt_fail" not in repo._seen  # failed → left unmarked for the retry

    # Redelivery: evt_ok is still deduped, evt_fail re-processes (and fails again).
    monkeypatch.setattr(handler, "verify_and_parse", lambda e: {"id": "evt_ok", "data": []})
    assert handler.lambda_handler({}, None)["body"] == "duplicate event - skipped"
    monkeypatch.setattr(handler, "verify_and_parse", lambda e: {"id": "evt_fail", "data": []})
    assert handler.lambda_handler({}, None)["statusCode"] == 500


def test_dead_letter_rows_accumulate_across_retries(lam, repo, monkeypatch):
    # WHIT-83/84 residual (documented, accepted): a write that fails AFTER
    # save_failed_transactions already ran re-writes the dead-letter row on every
    # BankSync retry (fresh uuid each time), so dead-letter rows ACCUMULATE — they
    # are not deduped across retries. Locks the behaviour so a future dedup is a
    # conscious decision, not a surprise. (This depends on the WHIT-83 fix: on the
    # old mark-before-write code the retry would be deduped and only ONE row written.)
    handler = lam.handler

    def boom_insert(txns):
        raise RuntimeError("insert failed")  # fails AFTER save_failed_transactions

    monkeypatch.setattr(repo, "insert_or_reconcile", boom_insert)
    # An unmapped row (no "id") → routed to save_failed_transactions before the insert.
    monkeypatch.setattr(handler, "verify_and_parse",
                        lambda e: {"id": "evt_1", "data": [{"unmapped": "row"}]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)

    r1 = handler.lambda_handler({}, None)   # delivery 1: dead-letter written, insert fails
    r2 = handler.lambda_handler({}, None)   # retry: dead-letter written AGAIN, insert fails

    assert r1["statusCode"] == 500 and r2["statusCode"] == 500
    failed = [k for k in repo._table.store if k[0] == "FAILED"]
    assert len(failed) == 2  # same input, two rows — NOT deduped across retries


def test_client_error_during_insert_is_not_reported_as_ok(lam, monkeypatch):
    # Use the REAL process_transaction so the real insert path runs. A row that
    # normalises cleanly reaches insert_or_reconcile, which raises ClientError; with
    # the swallow removed, that must surface as a 500 (not a false 200 "ok").
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
    repo = _Repo()
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
    # (FakeTable), not the _Repo double, so a method rename or a gate-semantics
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
