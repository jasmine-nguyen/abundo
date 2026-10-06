"""WHIT-767 / WHIT-768: the shared transaction-range stand-ins serve and record reads."""

from _transaction_range_fakes import (
    _AccountTransactionRepo,
    _DateFilteringTransactionRepo,
    _QueuedTransactionRepo,
)


def test_each_shared_transaction_stand_in_serves_and_records_reads():
    seed = [
        {"transaction_id": "before", "date": "2026-06-30"},
        {"transaction_id": "start", "date": "2026-07-01"},
        {"transaction_id": "end", "date": "2026-07-31"},
        {"transaction_id": "after", "date": "2026-08-01"},
    ]
    dated = _DateFilteringTransactionRepo(seed)
    page, cursor = dated.get_transactions_by_date_range("up-spending", "2026-07-01", "2026-07-31")
    assert [t["transaction_id"] for t in page] == ["start", "end"]
    assert cursor is None
    page[0]["transaction_id"] = "changed"
    del page[1]["date"]
    assert seed[1]["transaction_id"] == "start"
    assert seed[2]["date"] == "2026-07-31"
    assert dated.get_transactions_by_date_range("up-spending", "2026-07-01", "2026-07-31") == ([], None)
    assert dated.calls == [
        ("up-spending", "2026-07-01", "2026-07-31", 20, None),
        ("up-spending", "2026-07-01", "2026-07-31", 20, None),
    ]

    single = _QueuedTransactionRepo([{"transaction_id": "a"}])
    assert single.get_transactions_by_date_range("x", "2000-01-01", "2000-01-02") == ([{"transaction_id": "a"}], None)
    assert single.get_transactions_by_date_range("x", "2000-01-01", "2000-01-02") == ([], None)

    queued = _QueuedTransactionRepo(pages=[([{"transaction_id": "p1"}], "c1"), ([{"transaction_id": "p2"}], None)])
    assert queued.get_transactions_by_date_range("acc", "2026-07-01", "2026-07-31") == ([{"transaction_id": "p1"}], "c1")
    assert queued.get_transactions_by_date_range("acc", "2026-07-01", "2026-07-31", limit=50, cursor="c1") == (
        [{"transaction_id": "p2"}], None)
    assert queued.get_transactions_by_date_range("acc", "2026-07-01", "2026-07-31") == ([], None)
    assert queued.calls[1] == ("acc", "2026-07-01", "2026-07-31", 50, "c1")

    rows = [
        {"transaction_id": "mine-in", "account_id": "up-spending", "date": "2026-07-10"},
        {"transaction_id": "mine-out", "account_id": "up-spending", "date": "2026-08-10"},
        {"transaction_id": "theirs", "account_id": "up-saver", "date": "2026-07-10"},
    ]
    by_account = _AccountTransactionRepo(rows)
    page, cursor = by_account.get_transactions_by_date_range("up-spending", "2026-07-01", "2026-07-31")
    assert [t["transaction_id"] for t in page] == ["mine-in"]
    assert cursor is None
    page[0]["transaction_id"] = "changed"
    assert rows[0]["transaction_id"] == "mine-in"
    assert by_account.calls == [("up-spending", "2026-07-01", "2026-07-31", 20, None)]

