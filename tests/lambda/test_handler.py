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
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from _deadletter_fakes import _txn_store
from _dynamo_fakes import FakeTable
from _terraform import filter_pattern, matching
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


def _ingest_repo(lam, monkeypatch):
    """A real webhook repo, with rule lookups on the shared rule-ingest fakes."""
    from _rule_ingest_fakes import FakeRuleStore, SubscriptionCategories
    monkeypatch.setattr(lam.handler, "RuleRepository", FakeRuleStore)
    monkeypatch.setattr(lam.handler, "CategoryRepository", SubscriptionCategories)
    return _real_repo(lam)


def _delivery_row(transaction_id, account_id):
    """One raw BankSync delivery row for `account_id` (a BankSync account id)."""
    return {
        "id": transaction_id, "date": "2026-10-12", "authorizedDate": "2026-10-12",
        "description": "WOOLWORTHS", "merchantName": "WOOLWORTHS", "amount": "-5.50",
        "accountId": account_id, "accountName": "Bank", "category": "FOOD_AND_DRINK",
        "pending": False, "type": "PAYMENT", "pendingTransactionId": None,
    }


def test_delivery_records_bank_sync_time_for_its_accounts_only(lam, monkeypatch):
    # WHIT-858: a delivery with rows notes, per account, when the bank last sent transactions.
    # Only the delivered accounts get a note; a later row-less summary adds none.
    repo = _ingest_repo(lam, monkeypatch)

    before = int(time.time())
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_rows", "data": [
        _delivery_row("t1", "3zVQJ8Btz_IRmqp78VrQnQ"),               # up-spending
        _delivery_row("t2", "CC6EE20D-4931-4B10-86CA-EADD45A062DC"), # westpac-altitude-qantas-black
        _delivery_row("t3", "3zVQJ8Btz_IRmqp78VrQnQ"),
    ]})
    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}
    after = int(time.time())

    _wire(lam, monkeypatch, repo, {"id": "evt_summary", "data": []})
    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}

    synced = repo.get_bank_synced_at()
    assert set(synced) == {"up-spending", "westpac-altitude-qantas-black"}
    assert all(before <= synced_at <= after for synced_at in synced.values())


def _row_missing_amount(transaction_id):
    row = _delivery_row(transaction_id, "3zVQJ8Btz_IRmqp78VrQnQ")
    del row["amount"]
    return row


@pytest.mark.parametrize("rows, dead_lettered", [
    ([_delivery_row("t1", "not-a-real-account")], 1),
    ([_delivery_row("t1", "3zVQJ8Btz_IRmqp78VrQnQ")], 0),  # up-spending
    # [A2] an unknown account and a missing field in one delivery, beside a good row: ONE line
    # (one alarm datapoint) that counts both failed rows.
    ([_delivery_row("t1", "not-a-real-account"), _row_missing_amount("t2"),
      _delivery_row("t3", "3zVQJ8Btz_IRmqp78VrQnQ")], 2),
], ids=["unknown_account", "mapped_account", "mixed_delivery"])
def test_dead_lettered_rows_log_a_line_the_dead_letter_alarm_matches(lam, monkeypatch, caplog, rows,
                                                                      dead_lettered):
    # ABU-32: the bank is still told 200 for a row we can't file, so only this log line (and the
    # alarm counting it) says the FAILED pile has rows. Healthy traffic must stay quiet.
    caplog.set_level(logging.INFO)
    repo = _ingest_repo(lam, monkeypatch)
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_rows", "data": rows})

    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}

    messages = [record.getMessage() for record in caplog.records]
    marked = matching(messages, filter_pattern("dead_lettered_transactions"))
    assert len(marked) == min(dead_lettered, 1), messages
    assert all(f": {dead_lettered} rows" in message for message in marked), marked
    assert len([key for key in repo._table.store if key[0] == "FAILED"]) == dead_lettered


def test_a_failed_dead_letter_save_logs_no_alarm_line_and_500s(lam, monkeypatch, caplog):
    # [A3] ABU-32: the marker means the rows really are in the FAILED pile. A failed save 500s
    # (BankSync retries) and must not claim rows were saved.
    caplog.set_level(logging.INFO)
    repo = _ingest_repo(lam, monkeypatch)

    def _save_fails(rows):
        raise RuntimeError("dynamo down")

    monkeypatch.setattr(repo, "save_failed_transactions", _save_fails)
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_rows", "data": [_delivery_row("t1", "not-a-real-account")]})

    assert handler.lambda_handler({}, None)["statusCode"] == 500

    messages = [record.getMessage() for record in caplog.records]
    assert matching(messages, filter_pattern("dead_lettered_transactions")) == [], messages


def test_a_delivery_of_only_dropped_rows_still_records_bank_sync(lam, monkeypatch):
    # [A1] WHIT-858: a re-sent row the user deleted and a $0.00 row are never written, but they
    # still prove the bank delivered for their accounts.
    repo = _ingest_repo(lam, monkeypatch)
    repo.delete_transaction("ACCOUNT#up-spending", "TXN#t1")
    zero_row = {**_delivery_row("t2", "CC6EE20D-4931-4B10-86CA-EADD45A062DC"), "amount": "0.00"}
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_dropped", "data": [
        _delivery_row("t1", "3zVQJ8Btz_IRmqp78VrQnQ"), zero_row,
    ]})

    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}
    assert ("ACCOUNT#up-spending", "TXN#t1") not in repo._table.store
    assert set(repo.get_bank_synced_at()) == {"up-spending", "westpac-altitude-qantas-black"}


def test_bank_sync_marker_failure_still_writes_rows_and_acks(lam, monkeypatch):
    # WHIT-858: the "bank synced" note is best-effort — failing to write it never fails the delivery.
    repo = _ingest_repo(lam, monkeypatch)

    def broken_mark(account_ids, now):
        raise RuntimeError("marker write failed")

    monkeypatch.setattr(repo, "mark_bank_synced", broken_mark)
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_rows", "data": [_delivery_row("t1","3zVQJ8Btz_IRmqp78VrQnQ")]})

    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}
    assert ("ACCOUNT#up-spending", "TXN#t1") in repo._table.store
    assert repo.has_event("evt_rows") is True


# --- ABU-41: one bounded pending-pool read per bank message ------------------


def test_settlement_reads_the_pending_pool_once_bounded_to_recent_dates(lam, monkeypatch):
    # A posted charge settles its 9-day-old pending twin while budget alerts are live (a device
    # token and a target), so both the alert preview and the write need the pending pool.
    # It must be read once, through the date-index, from 30 days back, and never by scanning
    # the whole account. Fail-on-revert: the old double read makes 1 → 2 and hits ACCOUNT#.
    import spend
    from _budget_alert_fakes import notify_repo
    from _budget_endpoint_fakes import _FakeBudgetRepo, _FakeCategoryRepo, _FakePayCycleRepo
    from _milestone_fakes import FakeDeviceRepo

    repo = _ingest_repo(lam, monkeypatch)
    handler = lam.handler
    today = spend.melbourne_today()
    monkeypatch.setattr(handler, "CategoryRepository",
                        lambda: _FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]))
    monkeypatch.setattr(handler, "DeviceRepository", lambda: FakeDeviceRepo(("ExpoPushToken[a]",)))
    monkeypatch.setattr(handler, "BudgetRepository",
                        lambda: _FakeBudgetRepo({"groceries": {"target": Decimal("1000")}}))
    monkeypatch.setattr(handler, "PayCycleRepository",
                        lambda: _FakePayCycleRepo(length=14, last_pay_date=(today - timedelta(days=12)).isoformat()))
    monkeypatch.setattr(handler, "NotifyRepository", notify_repo)
    monkeypatch.setattr(lam.budget_alerts, "send_push",
                        lambda *a, **k: {"sent": 1, "ok": 1, "pruned": []})

    swiped = (today - timedelta(days=9)).isoformat()
    pending = lam.banksync.normalise({**_delivery_row("p1", "3zVQJ8Btz_IRmqp78VrQnQ"),
                                      "date": swiped, "authorizedDate": swiped, "pending": True})
    pending["category"] = "groceries"
    repo.insert_transactions([pending])
    repo._table.queries.clear()

    posted = {**_delivery_row("s1", "3zVQJ8Btz_IRmqp78VrQnQ"),
              "date": (today - timedelta(days=7)).isoformat(), "authorizedDate": swiped}
    _wire(lam, monkeypatch, repo, {"id": "evt_settle", "data": [posted]})

    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}

    store = repo._table.store
    assert ("ACCOUNT#up-spending", "TXN#p1") not in store
    assert store[("ACCOUNT#up-spending", "TXN#s1")]["category"] == "groceries"

    lookback_start = (today - timedelta(days=30)).isoformat()
    conditions = [query["KeyConditionExpression"].conditions for query in repo._table.queries]
    assert not [c for c in conditions if ("pk", "eq", "ACCOUNT#up-spending") in c]
    pending_reads = [query for query in repo._table.queries
                     if ("date", "gte", lookback_start) in query["KeyConditionExpression"].conditions]
    assert len(pending_reads) == 1
    assert pending_reads[0]["IndexName"] == "date-index"
    assert ("account_id", "eq", "up-spending") in pending_reads[0]["KeyConditionExpression"].conditions


def test_pending_pool_read_failure_fails_the_message_without_writing(lam, monkeypatch):
    # The pool read sits outside the best-effort alert block: if it fails, the message must
    # 500 (BankSync retries), nothing is written and the event stays unmarked.
    # Fail-on-revert: swallow the read error (or move it into the alert try) and this acks 200.
    repo = _ingest_repo(lam, monkeypatch)

    def failing_read(*_args):
        raise lam.age_out.DatabaseError("Database read failed: throttled")

    monkeypatch.setattr(repo, "get_transactions_by_date_range", failing_read)
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_pool", "data": [
        _delivery_row("s1", "3zVQJ8Btz_IRmqp78VrQnQ")]})

    assert handler.lambda_handler({}, None)["statusCode"] == 500
    assert ("ACCOUNT#up-spending", "TXN#s1") not in repo._table.store
    assert repo.has_event("evt_pool") is False


# --- ABU-60: the same row twice in one bank message ---------------------------

_UP_SPENDING = "3zVQJ8Btz_IRmqp78VrQnQ"


def test_a_row_sent_twice_in_one_message_is_stored_once_and_acked(lam, monkeypatch):
    # DynamoDB rejects a batch write holding one key twice, so an un-deduped repeat 500s the
    # message and BankSync re-sends it forever.
    repo = _ingest_repo(lam, monkeypatch)
    pending = {**_delivery_row("p1", _UP_SPENDING), "pending": True}
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_repeat", "data": [pending, pending]})

    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}
    stored = [key for key in repo._table.store if key[1] == "TXN#p1"]
    assert stored == [("ACCOUNT#up-spending", "TXN#p1")]
    assert repo.has_event("evt_repeat") is True


def test_a_repeated_posted_row_settles_one_pending_and_leaves_the_other(lam, monkeypatch):
    # Posted P is the exact twin of pending A; pending B only matches P through the looser tip
    # tier. A second copy of P must not claim (and delete) B as well.
    repo = _ingest_repo(lam, monkeypatch)
    row = {**_delivery_row("P", _UP_SPENDING), "merchantName": "WOOLWORTHS METRO",
           "description": "WOOLWORTHS METRO"}
    repo.insert_transactions([
        lam.banksync.normalise({**row, "id": "A", "pending": True}),
        lam.banksync.normalise({**row, "id": "B", "pending": True, "amount": "-5.00"}),
    ])
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_repeat_posted", "data": [row, row]})

    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}
    store = repo._table.store
    assert ("ACCOUNT#up-spending", "TXN#A") not in store
    assert ("ACCOUNT#up-spending", "TXN#P") in store
    assert ("ACCOUNT#up-spending", "TXN#B") in store


def test_a_pending_resent_after_its_settlement_is_not_brought_back(lam, monkeypatch):
    # ABU-36: posted P settles (and deletes) pending A; a later re-send of A must not re-create
    # it, or A and P both count toward spend.
    from datetime import date
    monkeypatch.setattr(lam.repository, "melbourne_today", lambda: date(2026, 10, 13))
    repo = _ingest_repo(lam, monkeypatch)
    posted = _delivery_row("P", _UP_SPENDING)
    pending = {**posted, "id": "A", "pending": True}
    repo.insert_transactions([lam.banksync.normalise(pending)])

    handler = _wire(lam, monkeypatch, repo, {"id": "evt_settle", "data": [posted]})
    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_resend", "data": [pending]})
    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}

    assert list(_txn_store(repo)) == [("ACCOUNT#up-spending", "TXN#P")]


def test_a_repeated_row_keeps_the_last_copy(lam, monkeypatch):
    repo = _ingest_repo(lam, monkeypatch)
    first = {**_delivery_row("p1", _UP_SPENDING), "pending": True, "amount": "-5.50"}
    last = {**first, "amount": "-7.25"}
    handler = _wire(lam, monkeypatch, repo, {"id": "evt_repeat_last", "data": [first, last]})

    assert handler.lambda_handler({}, None) == {"statusCode": 200, "body": "ok"}
    assert repo._table.store[("ACCOUNT#up-spending", "TXN#p1")]["amount"] == Decimal("-7.25")


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

    def raising_insert(txns, *, is_unfiled=None, pending_pools=None):
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
    # [A2] WHIT-858: no "bank synced" note for a delivery that wasn't written.
    assert repo.get_bank_synced_at() == {}


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
