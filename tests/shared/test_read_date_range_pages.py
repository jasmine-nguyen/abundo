"""WHIT-607 — the "read every page" date-range read on an empty range."""


def test_read_date_range_pages_returns_nothing_for_an_empty_range_after_one_read(repo, shared):
    rows = shared.repository.read_date_range_pages(
        repo, "up-spending", "2026-01-01", "2026-01-31"
    )
    assert rows == []
    assert repo._table.query_calls == 1


def test_read_window_returns_nothing_when_no_account_has_rows(repo, shared):
    assert shared.repository.read_window(repo, "2026-01-01", "2026-01-31") == []
