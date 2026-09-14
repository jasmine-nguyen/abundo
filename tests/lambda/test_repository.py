"""Unit tests for the webhook TransactionRepository's failure-path methods: the
WHIT-83 idempotency marker (`has_event` / `mark_event`, save-then-mark) and the
webhook-only reconcile/pagination behaviour. Backed by the in-memory FakeTable.

The dead-letter write helper (save_failed_transactions: WHIT-84 uuid sort key,
WHIT-54 TTL) is inherited from shared/repository_transaction.py and covered by
tests/shared/test_repository_transaction.py (WHIT-454)."""

import sys

import pytest


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


# --- WHIT-554: the shared _paginated_query helper ----------------------------
# The three readers above now delegate to one helper. The existing pagination tests
# (here + test_age_out + test_reprocess) already prove it follows LastEvaluatedKey for
# every variant. These two lock the parts those don't: the error wrap the helper now
# owns, and the one structural difference between the call sites (no filter on FAILED).


def _client_error(message="throttled"):
    """A botocore-shaped ClientError, built like the conftest fake does."""
    err = sys.modules["botocore.exceptions"].ClientError()
    err.response = {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": message}}
    return err


def test_paginated_query_wraps_a_client_error_as_database_error(lam, repo, monkeypatch):
    # The helper owns the try/except (WHIT-554), so a DynamoDB ClientError surfaces as the
    # mapped DatabaseError with the "read" action label — not the raw botocore error.
    # Fail-on-revert: drop the helper's except and this leaks the bare ClientError.
    def boom(**kwargs):
        raise _client_error("throttled")

    monkeypatch.setattr(repo._table, "query", boom)

    with pytest.raises(lam.age_out.DatabaseError, match="Database read failed: throttled"):
        repo.get_pending_transactions_for_account("acc")


def test_get_failed_sends_no_filter_while_pending_and_posted_do(repo):
    # Locks the one structural difference the helper preserves: the FAILED partition read
    # passes NO FilterExpression (every row is wanted), while pending/posted DO. A future
    # "always pass a filter" simplification would send FilterExpression=None, which real
    # DynamoDB rejects. Fail-on-revert of the helper's `is not None` guard → the key appears
    # on the failed call.
    captured: list[dict] = []
    original_query = repo._table.query

    def spy(**kwargs):
        captured.append(kwargs)
        return original_query(**kwargs)

    repo._table.query = spy

    repo.get_failed_transactions()
    failed_calls = list(captured)
    captured.clear()
    repo.get_pending_transactions_for_account("acc")
    pending_calls = list(captured)
    captured.clear()
    repo.get_posted_transactions_for_account("acc")
    posted_calls = list(captured)

    assert failed_calls and all("FilterExpression" not in c for c in failed_calls)
    assert pending_calls and all("FilterExpression" in c for c in pending_calls)
    assert posted_calls and all("FilterExpression" in c for c in posted_calls)


# --- WHIT-554 (QA gaps): parts neither the implementer's nor the existing tests lock ---
# Already covered, NOT duplicated: the shared loop's multi-page follow for every variant —
#   get_pending (this file), get_posted (test_age_out::test_get_posted_paginates_beyond_first_page),
#   get_failed (test_reprocess::test_multi_page_backlog_with_mixed_outcomes); single-status
#   filtering; the "read" label + filter-omission (the implementer's two tests). Gaps below.


def test_paginated_query_threads_a_non_default_action_label(lam, repo, monkeypatch):
    # Locks that the helper THREADS `action` into handle_database_error rather than hardcoding
    # "read". Call it directly with action="write", force a ClientError → the mapped DatabaseError
    # label must be "write". Hardcode "read" back and this fails. key_condition is never evaluated:
    # query raises first.
    def boom(**kwargs):
        raise _client_error("throttled")

    monkeypatch.setattr(repo._table, "query", boom)

    with pytest.raises(lam.age_out.DatabaseError, match="Database write failed: throttled"):
        repo._paginated_query(key_condition=object(), action="write")


def test_get_failed_returns_empty_list_on_an_empty_partition(repo):
    # Empty store → the only page has no Items and no LastEvaluatedKey → the helper must break and
    # return []. Guards the `if not start_key: break` terminator.
    assert repo.get_failed_transactions() == []
    assert repo._table.query_calls == 1


def test_get_failed_threads_exclusive_start_key_on_later_pages_without_a_filter(repo):
    # The FAILED (no-filter) path is the most stripped-down call site. Force 2 pages, spy kwargs:
    # page 1 carries NO ExclusiveStartKey, page 2 resumes with the page-1 cursor, and NEITHER page
    # carries a FilterExpression — proving dropping the filter didn't also drop cursor threading.
    for i in range(3):
        repo._table.store[("FAILED", f"TXN#f{i}")] = {
            "pk": "FAILED", "sk": f"TXN#f{i}", "transaction_id": f"f{i}", "status": "failed",
        }
    repo._table.page_size = 2

    captured: list[dict] = []
    original_query = repo._table.query

    def spy(**kwargs):
        captured.append(kwargs)
        return original_query(**kwargs)

    repo._table.query = spy
    got = {r["transaction_id"] for r in repo.get_failed_transactions()}

    assert got == {"f0", "f1", "f2"}                 # all pages accumulated
    assert len(captured) == 2                         # followed the cursor exactly once
    assert "ExclusiveStartKey" not in captured[0]
    assert "ExclusiveStartKey" in captured[1]
    assert all("FilterExpression" not in c for c in captured)


def test_pending_and_posted_do_not_cross_contaminate_through_the_shared_loop(repo):
    # Both readers now share ONE loop. One account with both statuses; each reader must return only
    # its own status. Guards a bad refactor that leaked rows between calls or swapped a filter.
    _put(repo, "acc", "pend_only", "pending")
    _put(repo, "acc", "post_only", "posted")

    pendings = {t["transaction_id"] for t in repo.get_pending_transactions_for_account("acc")}
    posteds = {t["transaction_id"] for t in repo.get_posted_transactions_for_account("acc")}

    assert pendings == {"pend_only"}
    assert posteds == {"post_only"}


def test_paginated_query_follows_a_trailing_cursor_into_an_empty_final_page(repo):
    # Real DynamoDB can return a non-null LastEvaluatedKey on the LAST data page, then an empty page
    # with no cursor — a shape FakeTable never emits. Script it: page1 = [f0,f1]+cursor, page2 = [].
    # The helper must query twice, accumulate exactly [f0,f1], neither drop f1 nor loop forever.
    pages = [
        {"Items": [{"transaction_id": "f0"}, {"transaction_id": "f1"}],
         "LastEvaluatedKey": {"pk": "FAILED", "sk": "TXN#f1"}},
        {"Items": []},
    ]
    calls: list[dict] = []

    def scripted(**kwargs):
        calls.append(kwargs)
        return pages[len(calls) - 1]

    repo._table.query = scripted
    got = [r["transaction_id"] for r in repo.get_failed_transactions()]

    assert got == ["f0", "f1"]
    assert len(calls) == 2
    assert calls[1].get("ExclusiveStartKey") == {"pk": "FAILED", "sk": "TXN#f1"}
