"""Unit tests for the webhook TransactionRepository's paginated reads. Backed by the
in-memory FakeTable. The dedup marker's skip/mark order is driven end to end in test_handler.py;
its expiry is checked here."""

import time



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


# --- ABU-41, ABU-108: get_match_pools reads recent pendings and posted rows of every account ---


def test_get_match_pools_keeps_recent_rows_of_every_account_across_pages(repo, pinned_pending_lookback):
    # today 2026-07-01 → pendings from 2026-06-01, posted rows from 2026-06-24.
    # Pages of 2 force the cursor to be followed.
    for txn_id, status, swiped in [
        ("old_pend", "pending", "2026-05-22"),     # 40 days old: outside the lookback
        ("edge_pend", "pending", "2026-06-01"),    # exactly 30 days old: inside (the bound is inclusive)
        ("recent_pend", "pending", "2026-06-02"),  # 29 days old: inside
        ("old_posted", "posted", "2026-06-23"),    # 8 days old: BankSync can't send its pending now
        ("posted", "posted", "2026-06-26"),
        ("new_pend", "pending", "2026-06-28"),
        ("other_pend", "pending", "2026-06-29"),   # an account with only a pending in the message
        ("other_posted", "posted", "2026-06-24"),  # exactly 7 days old: inside
    ]:
        account_id = "other" if txn_id.startswith("other") else "acc"
        _put(repo, account_id, txn_id, status)
        repo._table.store[(f"ACCOUNT#{account_id}", f"TXN#{txn_id}")].update(account_id=account_id, date=swiped)
    repo._table.page_size = 2
    message = [
        {"transaction_id": "s1", "account_id": "acc", "status": "posted"},
        {"transaction_id": "p9", "account_id": "other", "status": "pending"},
    ]

    pools = repo.get_match_pools(message)

    def ids(rows_by_account):
        return {account: sorted(row["transaction_id"] for row in rows) for account, rows in rows_by_account.items()}
    assert ids(pools.pending) == {"acc": ["edge_pend", "new_pend", "recent_pend"], "other": ["other_pend"]}
    assert ids(pools.posted) == {"acc": ["posted"], "other": ["other_posted"]}


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




# --- ABU-46: the "already processed" EVENT marker expires ---


def test_mark_event_stamps_expires_at_ttl(repo, monkeypatch):
    # [A1] a fractional clock, so a missing int() (boto3 rejects floats) is caught
    monkeypatch.setattr(time, "time", lambda: 1_000_000.7)

    repo.mark_event("evt_1")

    expires_at = repo._table.store[("EVENT#evt_1", "EVENT")]["expires_at"]
    assert expires_at == 1_000_000 + 30 * 24 * 60 * 60
    assert isinstance(expires_at, int)
    assert repo.has_event("evt_1") is True
