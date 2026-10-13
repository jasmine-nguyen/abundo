"""WHIT-607 QA — boundaries of the shared "read every page" date-range read."""

from _transaction_range_fakes import (
    _AccountPagesTransactionRepo,
    _QueuedTransactionRepo,
)


def test_finishing_exactly_on_the_last_allowed_page_does_not_raise(shared):
    # [A1] cursor clears on page 3 with max_pages=3 → every row back, no error (off-by-one).
    # Page 2 is empty but still carries a cursor, which must be followed, not read as the end.
    repo = _QueuedTransactionRepo(pages=[([{"id": 1}], "c1"), ([], "c2"), ([{"id": 3}], None)])
    rows = shared.repository.read_date_range_pages(repo, "up-spending", "2026-01-01", "2026-01-31", max_pages=3)
    assert [r["id"] for r in rows] == [1, 3]
    assert len(repo.calls) == 3


def test_each_page_forwards_range_page_size_and_the_previous_cursor(shared):
    # [A3] every call asks for the same [start, end] at MAX_PAGE_SIZE and resumes from the last cursor.
    repo = _QueuedTransactionRepo(pages=[([{"id": 1}], "c1"), ([{"id": 2}], None)])
    shared.repository.read_date_range_pages(repo, "anz-rewards-black-visa", "2026-01-01", "2026-01-31")
    size = shared.repository.MAX_PAGE_SIZE
    assert repo.calls == [
        ("anz-rewards-black-visa", "2026-01-01", "2026-01-31", size, None),
        ("anz-rewards-black-visa", "2026-01-01", "2026-01-31", size, "c1"),
    ]


def test_read_window_reads_every_page_of_every_mapped_account(shared):
    # [A5] a multi-page account in the middle of the map is fully read, and every mapped
    # account is visited once, in map order.
    import constants

    accounts = list(constants.ACCOUNT_ID_MAP.values())
    multi = accounts[1]

    pages = {account: [([{"account_id": account, "n": 1}], None)] for account in accounts}
    pages[multi] = [([{"account_id": multi, "n": 0}], "next"), ([{"account_id": multi, "n": 1}], None)]
    repo = _AccountPagesTransactionRepo(pages)
    rows = shared.repository.read_window(repo, "2026-01-01", "2026-01-31")
    assert len(rows) == len(accounts) + 1
    assert [c[0] for c in repo.calls] == accounts[:2] + [multi] + accounts[2:]
    assert sorted(r["n"] for r in rows if r["account_id"] == multi) == [0, 1]
