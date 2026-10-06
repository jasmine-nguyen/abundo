"""WHIT-607 QA — the feed-stall read keeps its own, tighter page limit and open-ended range."""

import pytest

from _transaction_range_fakes import _EndlessTransactionRepo, _QueuedTransactionRepo


def test_feed_stall_read_stops_at_its_own_20_page_limit(handler):
    # [A6] a stuck cursor stops after FEED_STALL_MAX_PAGES (20), not the shared 1000.
    repo = _EndlessTransactionRepo()
    with pytest.raises(RuntimeError, match="did not finish after 20 pages"):
        handler._recent_transactions(repo, "westpac-altitude-qantas-black", "2026-09-15")
    assert len(repo.calls) == handler.FEED_STALL_MAX_PAGES == 20


def test_feed_stall_read_is_open_ended_from_the_start_date(handler):
    # [A7] reads from start_date with no end date, at MAX_PAGE_SIZE, on the given account.
    repo = _QueuedTransactionRepo([{"transaction_id": "t1", "date": "2026-09-22"}])
    rows = handler._recent_transactions(repo, "westpac-altitude-qantas-black", "2026-09-15")
    assert rows == [{"transaction_id": "t1", "date": "2026-09-22"}]
    assert repo.calls == [("westpac-altitude-qantas-black", "2026-09-15", None, handler.MAX_PAGE_SIZE, None)]
