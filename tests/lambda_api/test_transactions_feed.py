"""Tests for GET /transactions/feed — the all-accounts feed paged back through FULL
history (get_transactions_feed + _fetch_feed_page).

Unlike test_handler.py's recent-feed tests (which use a queued-pages fake), most of these
run the real TransactionRepository over a FakeTable, which models DynamoDB's date-index
newest-first query with ExclusiveStartKey — resuming STRICTLY AFTER a cursor key. That is what
makes the multi-page merge assertions meaningful: the feed re-queries each account from its own
resume position every page, so a fake that just pops pre-canned pages could not exercise
the no-dupe / no-gap / keep-prior-cursor behaviour that is the crux of the design.
"""

import base64
import json

import pytest

# Resolved via pytest.ini's pythonpath (tests/shared).
from _api_event import api_event
from _feed_fakes import ANZ, SPENDING, HOMELOAN, WESTPAC, date_reads, _feed_event, real_repos, _row
from _transaction_range_fakes import _AccountPagesTransactionRepo


def _drain_feed(handler, repo, limits):
    """Page the feed to exhaustion, following nextCursor and cycling through `limits` per page
    (so a test can change the page size mid-pagination). Returns the flat list of transactions
    across every page, in the order the client would see them."""
    all_transactions = []
    cursor = None
    for page in range(1000):  # generous bound; a correct feed terminates well before this
        page_params = {"limit": str(limits[page % len(limits)])}
        if cursor is not None:
            page_params["cursor"] = cursor
        resp = handler.get_transactions_feed(_feed_event(page_params), repo)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        all_transactions.extend(body["transactions"])
        cursor = body["nextCursor"]
        if cursor is None:
            return all_transactions
    pytest.fail("feed did not terminate — nextCursor never went null")


# --- first page: all accounts, no date floor, merged newest-first ------------


def test_first_page_queries_every_account_from_newest_with_no_date_floor(handler):
    table, repo, _ = real_repos({
        ANZ: [_row(ANZ, "2026-07-10", "a1")],
        SPENDING: [_row(SPENDING, "2026-07-11", "s1")],
        HOMELOAN: [_row(HOMELOAN, "2026-07-09", "h1")],
        WESTPAC: [_row(WESTPAC, "2026-07-08", "w1")],
    })
    resp = handler.get_transactions_feed(_feed_event({}), repo)

    assert resp["statusCode"] == 200
    # Every account queried with start=end=None (no 7-day floor) and cursor=None.
    queried = {c[0]: c for c in date_reads(table)}
    assert set(queried) == {ANZ, SPENDING, HOMELOAN, WESTPAC}
    for account_id, call in queried.items():
        assert call[1] is None and call[2] is None   # no start/end date floor
        assert call[4] is None                        # first page → from newest

    body = json.loads(resp["body"])
    # Merged newest-first across accounts.
    assert [t["transaction_id"] for t in body["transactions"]] == ["s1", "a1", "h1", "w1"]
    assert body["nextCursor"] is None                 # everything fit on one page


def test_row_shape_strips_keys_and_defaults_category(handler):
    table, repo, _ = real_repos({SPENDING: [_row(SPENDING, "2026-07-01", "s1", amount="-9.99")]})
    resp = handler.get_transactions_feed(_feed_event({}), repo)
    txn = json.loads(resp["body"])["transactions"][0]
    assert "pk" not in txn and "sk" not in txn
    assert txn["category"] is None                    # sparse field defaulted
    assert txn["transaction_id"] == "s1"


# --- multi-page correctness: no dupes, no gaps, newest-first -----------------


def _assert_full_history_newest_first(drained, expected_ids):
    got_ids = [t["transaction_id"] for t in drained]
    # No gaps: every transaction is reachable. No dupes: none appears twice.
    assert set(got_ids) == set(expected_ids)
    assert len(got_ids) == len(expected_ids)
    # Newest-first: dates never increase as the user pages back.
    dates = [t["date"] for t in drained]
    assert dates == sorted(dates, reverse=True)


def test_paging_is_correct_across_a_range_of_page_sizes(handler):
    rows = {
        ANZ: [_row(ANZ, f"2026-06-{d:02d}", f"a{d}") for d in range(1, 12)],
        SPENDING: [_row(SPENDING, f"2026-06-{d:02d}", f"s{d}") for d in range(1, 9)],
        HOMELOAN: [_row(HOMELOAN, f"2026-06-{d:02d}", f"h{d}") for d in range(1, 4)],
    }
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    for limit in (1, 2, 3, 5, 7):
        table, repo, _ = real_repos(rows)
        _assert_full_history_newest_first(_drain_feed(handler, repo, [limit]), expected)


def test_account_with_only_old_rows_contributes_later_not_lost(handler):
    # ANZ's newest row is far older than the others, so it contributes NOTHING to page 1
    # (the keep-prior-cursor path) but must still appear once the feed pages back to it.
    rows = {
        ANZ: [_row(ANZ, "2020-01-01", "a_ancient")],
        SPENDING: [_row(SPENDING, f"2026-07-{d:02d}", f"s{d}") for d in (10, 11, 12)],
        HOMELOAN: [_row(HOMELOAN, f"2026-07-{d:02d}", f"h{d}") for d in (13, 14)],
    }
    table, repo, _ = real_repos(rows)
    drained = _drain_feed(handler, repo, [2])
    ids = [t["transaction_id"] for t in drained]
    assert "a_ancient" in ids                          # not lost
    assert ids[-1] == "a_ancient"                       # and it's the oldest, so last
    assert ids.count("a_ancient") == 1                  # exactly once


def test_empty_history_returns_empty_page_and_null_cursor(handler):
    table, repo, _ = real_repos({})
    resp = handler.get_transactions_feed(_feed_event({}), repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"transactions": [], "nextCursor": None}


def test_last_page_returns_null_cursor_and_a_follow_up_is_empty(handler):
    rows = {SPENDING: [_row(SPENDING, "2026-07-02", "s2"), _row(SPENDING, "2026-07-01", "s1")]}
    table, repo, _ = real_repos(rows)
    # limit=2 fits both rows exactly; nothing remains, so nextCursor is null.
    resp = handler.get_transactions_feed(_feed_event({"limit": "2"}), repo)
    body = json.loads(resp["body"])
    assert [t["transaction_id"] for t in body["transactions"]] == ["s2", "s1"]
    assert body["nextCursor"] is None


def test_trailing_lastevaluatedkey_quirk_terminates_without_dupes(handler):
    # DynamoDB may return a LastEvaluatedKey even when the next page is empty (it hit the
    # Limit exactly). Page 1 fills the limit AND carries a cursor; the resumed query then
    # returns []. The feed must still terminate and not repeat the last row. Pre-canned pages,
    # because the realistic FakeTable can't reproduce this quirk.
    key = {"account_id": SPENDING, "date": "2026-07-01", "pk": f"ACCOUNT#{SPENDING}", "sk": "TXN#s1"}
    repo = _AccountPagesTransactionRepo({SPENDING: [
        ([_row(SPENDING, "2026-07-01", "s1")], key),   # page 1: a row + a (stale) cursor
        ([], None),                                    # resumed query: nothing left
    ]})
    drained = _drain_feed(handler, repo, [1])
    assert [t["transaction_id"] for t in drained] == ["s1"]   # exactly once, then stop


# --- limit clamping ----------------------------------------------------------


@pytest.mark.parametrize(("limit", "queried"), [
    ("500", 100),   # above MAX_PAGE_SIZE
    ("0", 1),
    ("-3", 1),      # a negative Limit would be a DynamoDB ValidationException (500)
])
def test_limit_is_clamped_into_range(handler, limit, queried):
    table, repo, _ = real_repos({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": limit}), repo)
    assert resp["statusCode"] == 200
    assert all(call[3] == queried for call in date_reads(table))


def test_missing_query_params_uses_defaults_not_500(handler):
    # API Gateway sends queryStringParameters: None when the query string is absent.
    table, repo, _ = real_repos({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    event = api_event("GET", "/transactions/feed", query=None)
    resp = handler.get_transactions_feed(event, repo)
    assert resp["statusCode"] == 200
    assert all(call[3] == handler.FEED_PAGE_SIZE for call in date_reads(table))


# --- bad input → 400, never a 500 --------------------------------------------


@pytest.mark.parametrize("limit", ["abc", "5.5", "   "])
def test_a_bad_limit_is_400_and_never_hits_repo(handler, limit):
    table, repo, _ = real_repos({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": limit}), repo)
    assert resp["statusCode"] == 400
    assert date_reads(table) == []


def _encoded(payload):
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode("ascii")


@pytest.mark.parametrize("cursor", [
    base64.urlsafe_b64encode(b"not json").decode("ascii"),
    # A resume key whose account_id contradicts its map slot would be a DynamoDB
    # ValidationException (500) as an ExclusiveStartKey.
    _encoded({"v": 1, "a": {SPENDING: {"account_id": ANZ, "date": "2026-07-01",
                                       "pk": f"ACCOUNT#{ANZ}", "sk": "TXN#x"}}}),
    _encoded({"a": {}}),                                  # missing version
    _encoded({"v": 999, "a": {}}),                        # wrong version
    _encoded({"v": 1}),                                   # missing account map
    _encoded({"v": 1, "a": [1, 2]}),                      # account map isn't a dict
    _encoded({"v": 1, "a": {SPENDING: {"date": "x"}}}),   # key isn't the date-index shape
    # Right key NAMES but a non-string value.
    _encoded({"v": 1, "a": {SPENDING: {"account_id": SPENDING, "date": 1,
                                       "pk": f"ACCOUNT#{SPENDING}", "sk": "s"}}}),
    _encoded([1, 2, 3]),                                  # valid JSON, not an object
])
def test_a_bad_cursor_is_400_and_never_hits_repo(handler, cursor):
    table, repo, _ = real_repos({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"cursor": cursor}), repo)
    assert resp["statusCode"] == 400
    assert date_reads(table) == []


# --- the page size changed between pages -------------------------------------


def test_page_size_change_mid_pagination_stays_gap_free(handler):
    # The gap-free proof ("<limit rows newer than a top-limit row") is a PER-PAGE argument;
    # it must survive the client changing ?limit= between pages. Cycle 1 -> 5 -> 2 -> 7.
    rows = {
        ANZ: [_row(ANZ, f"2026-06-{d:02d}", f"a{d}") for d in range(1, 14)],
        SPENDING: [_row(SPENDING, f"2026-06-{d:02d}", f"s{d}") for d in range(1, 10)],
        HOMELOAN: [_row(HOMELOAN, f"2026-06-{d:02d}", f"h{d}") for d in range(1, 5)],
    }
    table, repo, _ = real_repos(rows)
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    _assert_full_history_newest_first(_drain_feed(handler, repo, [1, 5, 2, 7]), expected)


def test_same_date_run_within_one_account_split_by_size_change(handler):
    # One account, five rows all on the SAME date. A limit=2 first page splits the run; the
    # resume key lands mid-run. Resume with a different size and the rest must appear once.
    rows = {SPENDING: [_row(SPENDING, "2026-07-01", f"s{i}") for i in range(5)]}
    table, repo, _ = real_repos(rows)
    expected = [r["transaction_id"] for r in rows[SPENDING]]
    _assert_full_history_newest_first(_drain_feed(handler, repo, [2, 3]), expected)


def test_same_date_across_accounts_resume_boundary_with_size_change(handler):
    # Same date on three accounts AND older tails, page size changing each page. The
    # equal-date tiebreak (ACCOUNT_ID_MAP order) must stay stable across the resume so no
    # tie-row is lost or doubled.
    rows = {
        ANZ: [_row(ANZ, "2026-07-01", "a_t"), _row(ANZ, "2026-06-01", "a_o")],
        SPENDING: [_row(SPENDING, "2026-07-01", "s_t"), _row(SPENDING, "2026-06-01", "s_o")],
        HOMELOAN: [_row(HOMELOAN, "2026-07-01", "h_t"), _row(HOMELOAN, "2026-06-01", "h_o")],
    }
    table, repo, _ = real_repos(rows)
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    _assert_full_history_newest_first(_drain_feed(handler, repo, [1, 4, 2]), expected)
