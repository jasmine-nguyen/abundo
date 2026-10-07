"""WHIT-607 QA — the feed-stall read keeps its own, tighter page limit and open-ended range."""

from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable
from _transaction_range_fakes import _EndlessTransactionRepo, _QueuedTransactionRepo

WESTPAC = "westpac-altitude-qantas-black"
# 2026-09-29 00:00 UTC, so the 14-day look-back starts on 2026-09-15.
NOW = 1_790_640_000


def _check(handler, transaction_repo, watch_repo=None):
    handler._check_feed_stall(
        WESTPAC, Decimal("-1"),
        transaction_repo=transaction_repo, watch_repo=watch_repo, device_repo=None, now=NOW,
    )


def test_feed_stall_read_stops_at_its_own_20_page_limit(handler):
    # [A6] a stuck cursor stops after FEED_STALL_MAX_PAGES (20), not the shared 1000.
    repo = _EndlessTransactionRepo()
    with pytest.raises(RuntimeError, match="did not finish after 20 pages"):
        _check(handler, repo)
    assert len(repo.calls) == 20


def test_feed_stall_read_is_open_ended_from_the_start_date(handler):
    # [A7] reads from start_date with no end date, at MAX_PAGE_SIZE, on the given account.
    repo = _QueuedTransactionRepo([{"transaction_id": "t1", "date": "2026-09-22"}])
    watch_repo = handler.FeedWatchRepository()
    watch_repo._table = FakeTable()

    _check(handler, repo, watch_repo)

    assert repo.calls == [(WESTPAC, "2026-09-15", None, handler.MAX_PAGE_SIZE, None)]
    assert watch_repo.get_watch(WESTPAC)["seen_dates"] == {"t1": "2026-09-22"}
