"""WHIT-607 QA — boundaries of the shared "read every page" date-range read."""

import pytest


class _PagedRepo:
    """Serves `pages` (a list of row lists) one per call, with an integer cursor; records
    every call's arguments."""

    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
        self.calls.append((account_id, start, end, limit, cursor))
        index = cursor or 0
        next_cursor = index + 1 if index + 1 < len(self.pages) else None
        return list(self.pages[index]), next_cursor


def test_finishing_exactly_on_the_last_allowed_page_does_not_raise(shared):
    # [A1] cursor clears on page 3 with max_pages=3 → every row back, no error (off-by-one).
    repo = _PagedRepo([[{"id": 1}], [{"id": 2}], [{"id": 3}]])
    rows = shared.repository.read_date_range_pages(repo, "up-spending", "2026-01-01", "2026-01-31", max_pages=3)
    assert [r["id"] for r in rows] == [1, 2, 3]
    assert len(repo.calls) == 3


def test_empty_account_returns_no_rows_after_one_read(shared):
    # [A2] nothing stored → [] after a single query, no error.
    repo = _PagedRepo([[]])
    assert shared.repository.read_date_range_pages(repo, "up-spending", "2026-01-01", None) == []
    assert len(repo.calls) == 1


def test_each_page_forwards_range_page_size_and_the_previous_cursor(shared):
    # [A3] every call asks for the same [start, end] at MAX_PAGE_SIZE and resumes from the last cursor.
    repo = _PagedRepo([[{"id": 1}], [{"id": 2}]])
    shared.repository.read_date_range_pages(repo, "anz-rewards-black-visa", "2026-01-01", "2026-01-31")
    size = shared.repository.MAX_PAGE_SIZE
    assert repo.calls == [
        ("anz-rewards-black-visa", "2026-01-01", "2026-01-31", size, None),
        ("anz-rewards-black-visa", "2026-01-01", "2026-01-31", size, 1),
    ]


def test_default_page_limit_is_the_shared_constant(shared):
    # [A4] with no max_pages, a never-ending cursor stops at DATE_RANGE_MAX_PAGES (1000).
    import constants

    class _Endless:
        calls = 0

        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
            self.calls += 1
            return [], "more"

    endless = _Endless()
    with pytest.raises(RuntimeError, match="up-spending did not finish after 1000 pages"):
        shared.repository.read_date_range_pages(endless, "up-spending", "2026-01-01", None)
    assert endless.calls == constants.DATE_RANGE_MAX_PAGES == 1000


def test_read_window_reads_every_page_of_every_mapped_account(shared):
    # [A5] a multi-page account in the middle of the map is fully read, and every mapped
    # account is visited once, in map order.
    import constants

    accounts = list(constants.ACCOUNT_ID_MAP.values())
    multi = accounts[1]

    class _Repo:
        def __init__(self):
            self.calls = []

        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
            self.calls.append((account_id, cursor))
            if account_id == multi and cursor is None:
                return [{"account_id": account_id, "n": 0}], "next"
            return [{"account_id": account_id, "n": 1}], None

    repo = _Repo()
    rows = shared.repository.read_window(repo, "2026-01-01", "2026-01-31")
    assert len(rows) == len(accounts) + 1
    assert [a for a, _ in repo.calls] == accounts[:2] + [multi] + accounts[2:]
    assert sorted(r["n"] for r in rows if r["account_id"] == multi) == [0, 1]
