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


# --- WHIT-82: get_pending_transactions_for_account paginates -----------------
# DynamoDB caps a query at 1MB/page and applies the status filter per page. A
# pending row beyond page 1 must still be found, or reconciliation silently misses
# it. FakeTable.page_size forces the paging; pages are cut BEFORE the filter runs.


def _put(repo, account_id, txn_id, status):
    """Insert a minimal transaction row straight into the fake store."""
    pk, sk = f"ACCOUNT#{account_id}", f"TXN#{txn_id}"
    repo._table.store[(pk, sk)] = {
        "pk": pk, "sk": sk, "transaction_id": txn_id, "status": status,
    }


def test_get_pending_finds_a_pending_hidden_beyond_the_first_page(repo):
    # Two posted rows fill page 1; the only pending lands on page 2. Without the
    # LastEvaluatedKey loop the filter runs on page 1 alone -> [] -> the pending is
    # invisible to reconciliation. This is the WHIT-82 bug; assert it's now found.
    _put(repo, "acc", "posted_1", "posted")
    _put(repo, "acc", "posted_2", "posted")
    _put(repo, "acc", "pending_1", "pending")
    repo._table.page_size = 2  # page1 = 2 posted, page2 = the pending

    pendings = repo.get_pending_transactions_for_account("acc")

    assert [t["transaction_id"] for t in pendings] == ["pending_1"]
    assert repo._table.query_calls == 2  # followed the cursor to page 2


def test_get_pending_accumulates_pendings_across_pages(repo):
    # A pending on page 1 AND page 2 — both must come back.
    _put(repo, "acc", "pend_a", "pending")
    _put(repo, "acc", "post_b", "posted")
    _put(repo, "acc", "pend_c", "pending")
    repo._table.page_size = 2  # page1 = [pend_a, post_b], page2 = [pend_c]

    pendings = repo.get_pending_transactions_for_account("acc")

    assert sorted(t["transaction_id"] for t in pendings) == ["pend_a", "pend_c"]
    assert repo._table.query_calls == 2


def test_get_pending_single_page_returns_all_and_queries_once(repo):
    # Common case (default page_size=None): every pending comes back in one query,
    # posted rows filtered out. Locks that pagination didn't regress the happy path.
    _put(repo, "acc", "a", "pending")
    _put(repo, "acc", "b", "posted")
    _put(repo, "acc", "c", "pending")

    pendings = repo.get_pending_transactions_for_account("acc")

    assert sorted(t["transaction_id"] for t in pendings) == ["a", "c"]
    assert repo._table.query_calls == 1
