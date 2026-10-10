"""Unit tests for the webhook TransactionRepository's paginated reads. Backed by the
in-memory FakeTable. The dedup marker is driven end to end in test_handler.py."""


# --- WHIT-82: get_account_transactions paginates -----------------
# DynamoDB caps a query at 1MB/page and applies the status filter per page. A
# pending row beyond page 1 must still be found, or reconciliation silently misses
# it. FakeTable.page_size forces the paging; pages are cut BEFORE the filter runs.


def _put(repo, account_id, txn_id, status):
    """Insert a minimal transaction row straight into the fake store."""
    pk, sk = f"ACCOUNT#{account_id}", f"TXN#{txn_id}"
    repo._table.store[(pk, sk)] = {
        "pk": pk, "sk": sk, "transaction_id": txn_id, "status": status,
    }


def test_get_pending_accumulates_pendings_across_pages(repo):
    # A pending on page 1 AND page 2 — both must come back.
    _put(repo, "acc", "a_pend", "pending")
    _put(repo, "acc", "b_post", "posted")
    _put(repo, "acc", "c_pend", "pending")
    repo._table.page_size = 2  # page1 = [a_pend, b_post], page2 = [c_pend]

    pendings = repo.get_account_transactions("acc", "pending")

    assert sorted(t["transaction_id"] for t in pendings) == ["a_pend", "c_pend"]
    assert repo._table.query_calls == 2


# --- WHIT-554: the shared _paginated_query helper, on the FAILED (no-filter) call site ---


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


