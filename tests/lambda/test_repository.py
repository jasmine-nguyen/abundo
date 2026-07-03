"""Unit tests for the webhook TransactionRepository's failure-path methods:
the WHIT-83 idempotency marker (`has_event` / `mark_event`, save-then-mark) and
the WHIT-84 uuid in the dead-letter sort key. Backed by the in-memory FakeTable."""

from datetime import datetime, timezone


def test_mark_event_makes_has_event_true(repo):
    # An unseen event reports False; mark_event writes the marker; has_event then
    # reports True (so its redelivery is deduped). (WHIT-83)
    assert repo.has_event("evt_1") is False

    repo.mark_event("evt_1")
    assert repo.has_event("evt_1") is True
    assert ("EVENT#evt_1", "EVENT") in repo._table.store


def test_has_event_is_false_for_an_unmarked_event(repo):
    # A failed delivery never calls mark_event, so the event stays unmarked and its
    # retry re-processes rather than being skipped as a duplicate.
    assert repo.has_event("never_marked") is False
    assert repo._table.store == {}


def test_save_failed_transactions_survive_same_microsecond(repo, lam, monkeypatch):
    # WHIT-84: force both failed rows to the SAME timestamp. Only the uuid in the
    # sort key keeps them from collapsing into one overwritten row. Without the uuid
    # the two SKs are identical -> FakeTable stores one -> this assertion fails.
    frozen = datetime(2026, 6, 29, 12, 0, 0, tzinfo=timezone.utc)

    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen

    monkeypatch.setattr(lam.repository, "datetime", _FrozenDatetime)

    repo.save_failed_transactions([{"id": "a"}, {"id": "b"}])

    failed = [key for key in repo._table.store if key[0] == "FAILED"]
    assert len(failed) == 2


def test_double_processing_same_posted_is_idempotent(repo, lam):
    # Concurrent-duplicate probe (WHIT-83): has_event + mark_event are NOT atomic, so
    # a truly concurrent duplicate delivery can slip past the gate twice and process
    # the same event twice. Prove that's harmless for the transaction row: writing the
    # same normalised POSTED transaction twice leaves exactly ONE row (overwrite by
    # id), never a duplicate.
    normalise = lam.banksync.BankSyncClient.normalise
    row = {
        "id": "txn_1", "date": "2026-06-29", "authorizedDate": "2026-06-29",
        "description": "COLES", "merchantName": "COLES", "amount": "-12.00",
        "accountId": "3zVQJ8Btz_IRmqp78VrQnQ", "accountName": "Up Spending",
        "category": "GROCERIES", "pending": False, "type": "PAYMENT",
        "pendingTransactionId": None,
    }
    txn = normalise(row)

    repo.insert_or_reconcile([txn])
    repo.insert_or_reconcile([txn])  # second (concurrent) delivery of the same event

    account_rows = [k for k in repo._table.store if k[0].startswith("ACCOUNT#")]
    assert len(account_rows) == 1  # overwrite by id -> exactly one row, not two


def test_concurrent_duplicate_dead_letters_are_not_deduped(repo):
    # The one NON-idempotent write in the pipeline: save_failed_transactions keys each
    # row by timestamp#uuid, so the SAME unmapped row written twice (concurrent
    # duplicate OR retry) becomes TWO dead-letter rows. Locks the residual so a future
    # dedup is a conscious decision (see edge-case critique).
    repo.save_failed_transactions([{"unmapped": "row"}])
    repo.save_failed_transactions([{"unmapped": "row"}])  # same input again

    failed = [k for k in repo._table.store if k[0] == "FAILED"]
    assert len(failed) == 2  # not deduped
