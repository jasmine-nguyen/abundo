"""WHIT-607 QA — boundaries of the shared "read every page" date-range read."""

import pytest
from _transaction_range_fakes import (
    _AccountPagesTransactionRepo,
    _EndlessTransactionRepo,
    _QueuedTransactionRepo,
)


def test_finishing_exactly_on_the_last_allowed_page_does_not_raise(shared):
    # [A1] cursor clears on page 3 with max_pages=3 → every row back, no error (off-by-one).
    repo = _QueuedTransactionRepo(pages=[([{"id": 1}], "c1"), ([{"id": 2}], "c2"), ([{"id": 3}], None)])
    rows = shared.repository.read_date_range_pages(repo, "up-spending", "2026-01-01", "2026-01-31", max_pages=3)
    assert [r["id"] for r in rows] == [1, 2, 3]
    assert len(repo.calls) == 3


def test_empty_account_returns_no_rows_after_one_read(shared):
    # [A2] nothing stored → [] after a single query, no error.
    repo = _QueuedTransactionRepo([])
    assert shared.repository.read_date_range_pages(repo, "up-spending", "2026-01-01", None) == []
    assert len(repo.calls) == 1


def test_each_page_forwards_range_page_size_and_the_previous_cursor(shared):
    # [A3] every call asks for the same [start, end] at MAX_PAGE_SIZE and resumes from the last cursor.
    repo = _QueuedTransactionRepo(pages=[([{"id": 1}], "c1"), ([{"id": 2}], None)])
    shared.repository.read_date_range_pages(repo, "anz-rewards-black-visa", "2026-01-01", "2026-01-31")
    size = shared.repository.MAX_PAGE_SIZE
    assert repo.calls == [
        ("anz-rewards-black-visa", "2026-01-01", "2026-01-31", size, None),
        ("anz-rewards-black-visa", "2026-01-01", "2026-01-31", size, "c1"),
    ]


def test_default_page_limit_is_the_shared_constant(shared):
    # [A4] with no max_pages, a never-ending cursor stops at DATE_RANGE_MAX_PAGES (1000).
    import constants

    endless = _EndlessTransactionRepo()
    with pytest.raises(RuntimeError, match="up-spending did not finish after 1000 pages"):
        shared.repository.read_date_range_pages(endless, "up-spending", "2026-01-01", None)
    assert len(endless.calls) == constants.DATE_RANGE_MAX_PAGES == 1000


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
