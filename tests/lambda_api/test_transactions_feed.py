"""Tests for GET /transactions/feed — the all-accounts feed paged back through FULL
history (get_transactions_feed + _fetch_feed_page).

Unlike test_handler.py's recent-feed tests (which use a queued-pages fake), most of these
use FakeFeedRepo, a realistic stand-in that models DynamoDB's date-index newest-first query
with ExclusiveStartKey — resuming STRICTLY AFTER a cursor key. That is what makes the
multi-page merge assertions meaningful: the feed re-queries each account from its own
resume position every page, so a fake that just pops pre-canned pages could not exercise
the no-dupe / no-gap / keep-prior-cursor behaviour that is the crux of the design.
"""

import base64
import copy
import json
from decimal import Decimal

import pytest

# FakeFeedRepo and friends live in tests/shared/_feed_fakes.py so this impl suite and its
# gap suite share ONE definition (WHIT-445); resolved via pytest.ini's pythonpath.
from _feed_fakes import ANZ, SPENDING, HOMELOAN, _row, FakeFeedRepo, _feed_event


def _drain_feed(handler, repo, limit=None):
    """Page the feed to exhaustion, following nextCursor. Returns the flat list of
    transactions across every page, in the order the client would see them."""
    params = {} if limit is None else {"limit": str(limit)}
    all_transactions = []
    cursor = None
    for _ in range(1000):  # generous bound; a correct feed terminates well before this
        page_params = dict(params)
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
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "a1")],
        SPENDING: [_row(SPENDING, "2026-07-11", "s1")],
        HOMELOAN: [_row(HOMELOAN, "2026-07-09", "h1")],
    })
    resp = handler.get_transactions_feed(_feed_event({}), repo)

    assert resp["statusCode"] == 200
    # Every account queried with start=end=None (no 7-day floor) and cursor=None.
    queried = {c[0]: c for c in repo.calls}
    assert set(queried) == {ANZ, SPENDING, HOMELOAN}
    for account_id, call in queried.items():
        assert call[1] is None and call[2] is None   # no start/end date floor
        assert call[4] is None                        # first page → from newest

    body = json.loads(resp["body"])
    # Merged newest-first across accounts.
    assert [t["transaction_id"] for t in body["transactions"]] == ["s1", "a1", "h1"]
    assert body["nextCursor"] is None                 # everything fit on one page


def test_first_page_defaults_to_feed_page_size_limit(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    handler.get_transactions_feed(_feed_event({}), repo)
    # No ?limit= → the per-account query uses FEED_PAGE_SIZE.
    assert all(call[3] == handler.FEED_PAGE_SIZE for call in repo.calls)


def test_row_shape_strips_keys_and_defaults_category(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1", amount="-9.99")]})
    resp = handler.get_transactions_feed(_feed_event({}), repo)
    txn = json.loads(resp["body"])["transactions"][0]
    assert "pk" not in txn and "sk" not in txn
    assert txn["category"] is None                    # sparse field defaulted
    assert txn["transaction_id"] == "s1"


# --- multi-page correctness: no dupes, no gaps, newest-first -----------------


def _assert_full_history_newest_first(handler, repo, expected_ids, limit):
    drained = _drain_feed(handler, repo, limit=limit)
    got_ids = [t["transaction_id"] for t in drained]
    # No gaps: every transaction is reachable. No dupes: none appears twice.
    assert set(got_ids) == set(expected_ids)
    assert len(got_ids) == len(expected_ids)
    # Newest-first: dates never increase as the user pages back.
    dates = [t["date"] for t in drained]
    assert dates == sorted(dates, reverse=True)


def test_paging_reaches_all_history_across_accounts_no_dupes_no_gaps(handler):
    # Interleaved dates across all three accounts, more rows than one small page holds.
    rows = {
        ANZ: [_row(ANZ, f"2026-07-{d:02d}", f"a{d}") for d in (1, 4, 7, 10, 13)],
        SPENDING: [_row(SPENDING, f"2026-07-{d:02d}", f"s{d}") for d in (2, 5, 8, 11, 14)],
        HOMELOAN: [_row(HOMELOAN, f"2026-07-{d:02d}", f"h{d}") for d in (3, 6, 9)],
    }
    repo = FakeFeedRepo(rows)
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    _assert_full_history_newest_first(handler, repo, expected, limit=2)


def test_paging_is_correct_across_a_range_of_page_sizes(handler):
    rows = {
        ANZ: [_row(ANZ, f"2026-06-{d:02d}", f"a{d}") for d in range(1, 12)],
        SPENDING: [_row(SPENDING, f"2026-06-{d:02d}", f"s{d}") for d in range(1, 9)],
        HOMELOAN: [_row(HOMELOAN, f"2026-06-{d:02d}", f"h{d}") for d in range(1, 4)],
    }
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    for limit in (1, 2, 3, 5, 7):
        repo = FakeFeedRepo(rows)
        _assert_full_history_newest_first(handler, repo, expected, limit=limit)


def test_equal_dates_straddling_accounts_are_all_returned_once(handler):
    # Same date on all three accounts, plus older rows — the page boundary falls on a tie.
    rows = {
        ANZ: [_row(ANZ, "2026-07-01", "a_tie"), _row(ANZ, "2026-06-20", "a_old")],
        SPENDING: [_row(SPENDING, "2026-07-01", "s_tie"), _row(SPENDING, "2026-06-20", "s_old")],
        HOMELOAN: [_row(HOMELOAN, "2026-07-01", "h_tie")],
    }
    repo = FakeFeedRepo(rows)
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    # limit=2 forces the three equal-dated rows to split across pages.
    _assert_full_history_newest_first(handler, repo, expected, limit=2)


def test_account_with_only_old_rows_contributes_later_not_lost(handler):
    # ANZ's newest row is far older than the others, so it contributes NOTHING to page 1
    # (the keep-prior-cursor path) but must still appear once the feed pages back to it.
    rows = {
        ANZ: [_row(ANZ, "2020-01-01", "a_ancient")],
        SPENDING: [_row(SPENDING, f"2026-07-{d:02d}", f"s{d}") for d in (10, 11, 12)],
        HOMELOAN: [_row(HOMELOAN, f"2026-07-{d:02d}", f"h{d}") for d in (13, 14)],
    }
    repo = FakeFeedRepo(rows)
    drained = _drain_feed(handler, repo, limit=2)
    ids = [t["transaction_id"] for t in drained]
    assert "a_ancient" in ids                          # not lost
    assert ids[-1] == "a_ancient"                       # and it's the oldest, so last
    assert ids.count("a_ancient") == 1                  # exactly once


def test_single_account_populated(handler):
    rows = {SPENDING: [_row(SPENDING, f"2026-07-{d:02d}", f"s{d}") for d in (1, 2, 3, 4, 5)]}
    repo = FakeFeedRepo(rows)
    expected = [r["transaction_id"] for r in rows[SPENDING]]
    _assert_full_history_newest_first(handler, repo, expected, limit=2)


def test_empty_history_returns_empty_page_and_null_cursor(handler):
    repo = FakeFeedRepo({})
    resp = handler.get_transactions_feed(_feed_event({}), repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"transactions": [], "nextCursor": None}


def test_last_page_returns_null_cursor_and_a_follow_up_is_empty(handler):
    rows = {SPENDING: [_row(SPENDING, "2026-07-02", "s2"), _row(SPENDING, "2026-07-01", "s1")]}
    repo = FakeFeedRepo(rows)
    # limit=2 fits both rows exactly; nothing remains, so nextCursor is null.
    resp = handler.get_transactions_feed(_feed_event({"limit": "2"}), repo)
    body = json.loads(resp["body"])
    assert [t["transaction_id"] for t in body["transactions"]] == ["s2", "s1"]
    assert body["nextCursor"] is None


class _QueuedPagesRepo:
    """Serves per-account pre-canned (items, cursor) pages in order, regardless of the
    resume key — used only to reproduce a DynamoDB quirk the realistic fake can't: a
    LastEvaluatedKey returned even though the next page is empty."""

    def __init__(self, pages_by_account):
        self._pages = {a: list(p) for a, p in pages_by_account.items()}
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        queue = self._pages.get(account_id)
        if queue:
            items, next_cursor = queue.pop(0)
            return copy.deepcopy(items), next_cursor
        return [], None


def test_trailing_lastevaluatedkey_quirk_terminates_without_dupes(handler):
    # DynamoDB may return a LastEvaluatedKey even when the next page is empty (it hit the
    # Limit exactly). Page 1 fills the limit AND carries a cursor; the resumed query then
    # returns []. The feed must still terminate and not repeat the last row.
    key = {"account_id": SPENDING, "date": "2026-07-01", "pk": f"ACCOUNT#{SPENDING}", "sk": "TXN#s1"}
    repo = _QueuedPagesRepo({SPENDING: [
        ([_row(SPENDING, "2026-07-01", "s1")], key),   # page 1: a row + a (stale) cursor
        ([], None),                                    # resumed query: nothing left
    ]})
    drained = _drain_feed(handler, repo, limit=1)
    assert [t["transaction_id"] for t in drained] == ["s1"]   # exactly once, then stop


# --- cursor round-trip + limit clamping --------------------------------------


def test_cursor_round_trips_to_the_per_account_resume_map(handler):
    rows = {
        SPENDING: [_row(SPENDING, "2026-07-03", "s3"), _row(SPENDING, "2026-07-01", "s1")],
        ANZ: [_row(ANZ, "2026-07-02", "a2")],
    }
    repo = FakeFeedRepo(rows)
    resp1 = handler.get_transactions_feed(_feed_event({"limit": "1"}), repo)
    body1 = json.loads(resp1["body"])
    assert [t["transaction_id"] for t in body1["transactions"]] == ["s3"]   # newest overall
    cursor = body1["nextCursor"]
    assert isinstance(cursor, str) and cursor

    decoded = handler._decode_feed_cursor(cursor)
    # SPENDING contributed s3, so it resumes past s3. ANZ contributed nothing yet but is
    # still live, so it stays in the map at its prior (newest) position.
    assert decoded[SPENDING]["sk"] == "TXN#s3"
    assert ANZ in decoded and decoded[ANZ] is None


def test_limit_above_max_is_clamped(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    handler.get_transactions_feed(_feed_event({"limit": "500"}), repo)
    assert all(call[3] == handler.MAX_PAGE_SIZE for call in repo.calls)


def test_limit_zero_is_clamped_to_one(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    handler.get_transactions_feed(_feed_event({"limit": "0"}), repo)
    assert all(call[3] == 1 for call in repo.calls)


def test_missing_query_params_uses_defaults_not_500(handler):
    # API Gateway sends queryStringParameters: None when the query string is absent.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    event = {"rawPath": "/transactions/feed", "requestContext": {"http": {"method": "GET"}},
             "queryStringParameters": None}
    resp = handler.get_transactions_feed(event, repo)
    assert resp["statusCode"] == 200
    assert all(call[3] == handler.FEED_PAGE_SIZE for call in repo.calls)


# --- bad input → 400, never a 500 --------------------------------------------


def test_non_numeric_limit_is_400_and_never_hits_repo(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": "abc"}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_malformed_cursor_is_400(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    bad = base64.urlsafe_b64encode(b"not json").decode("ascii")
    resp = handler.get_transactions_feed(_feed_event({"cursor": bad}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_cross_account_cursor_key_is_400(handler):
    # A resume key whose account_id contradicts its map slot would be a DynamoDB
    # ValidationException (500) as an ExclusiveStartKey — rejected as a 400 first.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    forged = base64.urlsafe_b64encode(json.dumps({
        "v": 1,
        "a": {SPENDING: {"account_id": ANZ, "date": "2026-07-01",
                          "pk": f"ACCOUNT#{ANZ}", "sk": "TXN#x"}},
    }).encode()).decode("ascii")
    resp = handler.get_transactions_feed(_feed_event({"cursor": forged}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


@pytest.mark.parametrize("payload", [
    {"a": {}},                                  # missing version
    {"v": 999, "a": {}},                        # wrong version
    {"v": 1},                                   # missing account map
    {"v": 1, "a": [1, 2]},                      # account map isn't a dict
    {"v": 1, "a": {SPENDING: {"date": "x"}}},   # key isn't the date-index shape
    # Right key NAMES but a non-string value — would reach DynamoDB as a bad
    # ExclusiveStartKey (ValidationException → 500) without the value-type guard.
    {"v": 1, "a": {SPENDING: {"account_id": SPENDING, "date": 1,
                               "pk": f"ACCOUNT#{SPENDING}", "sk": "s"}}},
])
def test_wrong_shape_feed_cursor_is_400(handler, payload):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    forged = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode("ascii")
    resp = handler.get_transactions_feed(_feed_event({"cursor": forged}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


# --- cursor helper unit round-trips ------------------------------------------


def test_encode_decode_feed_cursor_round_trip(handler):
    resume = {
        SPENDING: {"account_id": SPENDING, "date": "2026-07-01",
                    "pk": f"ACCOUNT#{SPENDING}", "sk": "TXN#s1"},
        ANZ: None,   # live but resuming from newest
    }
    token = handler._encode_feed_cursor(resume)
    assert isinstance(token, str) and token
    assert handler._decode_feed_cursor(token) == resume


def test_empty_resume_map_encodes_to_null_and_decodes_from_null(handler):
    assert handler._encode_feed_cursor({}) is None
    assert handler._decode_feed_cursor(None) == {}
    assert handler._decode_feed_cursor("") == {}


# --- dispatch through lambda_handler -----------------------------------------


def test_feed_dispatches_through_lambda_handler(handler, monkeypatch):
    # Proves lambda_handler routes GET /transactions/feed to the feed handler (the merged,
    # cursor-paged shape), NOT the 7-day get_recent_transactions.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "get_recent_transactions",
                        lambda repo: pytest.fail("feed route reached the 7-day feed handler"))

    resp = handler.lambda_handler(_feed_event({}), None)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert [t["transaction_id"] for t in body["transactions"]] == ["s1"]
    assert body["nextCursor"] is None


# === adversarial GAP suite (folded from test_transactions_feed_gaps.py) — page-size vs total
# history, mid-drain account exhaustion, size-change-mid-pagination, same-date resume boundaries,
# limit-string edges, non-object cursors, unknown resume accounts, Decimal serialisation.
# The gap-only paging helpers below stay local (the impl suite above doesn't use them). ======


def _one_page(handler, repo, cursor=None, limit=None):
    params = {}
    if limit is not None:
        params["limit"] = str(limit)
    if cursor is not None:
        params["cursor"] = cursor
    resp = handler.get_transactions_feed(_feed_event(params), repo)
    return resp


def _drain_with_limits(handler, repo, limits):
    """Page to exhaustion, cycling through `limits` per page (a list). Returns
    (all_transactions, page_count). Lets a test change the page size MID-pagination."""
    all_transactions = []
    cursor = None
    for i in range(2000):
        limit = limits[i % len(limits)]
        resp = _one_page(handler, repo, cursor=cursor, limit=limit)
        assert resp["statusCode"] == 200, resp
        body = json.loads(resp["body"])
        all_transactions.extend(body["transactions"])
        cursor = body["nextCursor"]
        if cursor is None:
            return all_transactions, i + 1
    pytest.fail("feed did not terminate — nextCursor never went null")


def _assert_history(got_txns, expected_ids):
    got_ids = [t["transaction_id"] for t in got_txns]
    assert set(got_ids) == set(expected_ids), (
        f"missing={set(expected_ids) - set(got_ids)} extra={set(got_ids) - set(expected_ids)}"
    )
    assert len(got_ids) == len(expected_ids), f"dupes present: {got_ids}"
    dates = [t["date"] for t in got_txns]
    assert dates == sorted(dates, reverse=True), f"not newest-first: {dates}"


# --- [G1] page size larger than total history -------------------------------------

def test_page_size_larger_than_total_history_is_one_page_null_cursor(handler):
    # WHIT — [G1] limit far exceeds the row count -> everything fits on page 1, null cursor.
    rows = {
        ANZ: [_row(ANZ, "2026-07-10", "a1")],
        SPENDING: [_row(SPENDING, f"2026-07-{d:02d}", f"s{d}") for d in (2, 5, 8)],
        HOMELOAN: [_row(HOMELOAN, "2026-07-06", "h1")],
    }
    repo = FakeFeedRepo(rows)
    resp = _one_page(handler, repo, limit=100)  # clamped to MAX_PAGE_SIZE, >> 5 rows
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    _assert_history(body["transactions"], expected)
    assert body["nextCursor"] is None            # single page — nothing left to resume


# --- [G2] an account exhausts mid-drain, others continue --------------------------

def test_account_exhausts_mid_drain_drops_from_cursor_others_continue(handler):
    # SPENDING holds only the two NEWEST rows; it exhausts early, yet ANZ+HOMELOAN keep
    # paging back. Nothing lost, nothing duplicated, and SPENDING must leave the cursor.
    rows = {
        SPENDING: [_row(SPENDING, "2026-07-20", "s2"), _row(SPENDING, "2026-07-19", "s1")],
        ANZ: [_row(ANZ, f"2026-07-{d:02d}", f"a{d}") for d in range(1, 11)],
        HOMELOAN: [_row(HOMELOAN, f"2026-07-{d:02d}", f"h{d}") for d in range(1, 8)],
    }
    repo = FakeFeedRepo(rows)
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]

    # Walk pages manually so we can inspect the cursor the moment SPENDING is gone.
    all_txns, cursor, saw_spending_dropped = [], None, False
    for _ in range(1000):
        resp = _one_page(handler, repo, cursor=cursor, limit=2)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        all_txns.extend(body["transactions"])
        cursor = body["nextCursor"]
        if cursor is not None:
            decoded = handler._decode_feed_cursor(cursor)
            # Once both SPENDING rows are shown it must not linger in the resume map.
            if all(t in {x["transaction_id"] for x in all_txns} for t in ("s1", "s2")):
                if SPENDING not in decoded:
                    saw_spending_dropped = True
        if cursor is None:
            break
    _assert_history(all_txns, expected)
    assert saw_spending_dropped, "exhausted account never left the cursor"


# --- [G3] page size changed mid-pagination ----------------------------------------

def test_page_size_change_mid_pagination_stays_gap_free(handler):
    # The gap-free proof ("<limit rows newer than a top-limit row") is a PER-PAGE argument;
    # it must survive the client changing ?limit= between pages. Cycle 1 -> 5 -> 2 -> 7.
    rows = {
        ANZ: [_row(ANZ, f"2026-06-{d:02d}", f"a{d}") for d in range(1, 14)],
        SPENDING: [_row(SPENDING, f"2026-06-{d:02d}", f"s{d}") for d in range(1, 10)],
        HOMELOAN: [_row(HOMELOAN, f"2026-06-{d:02d}", f"h{d}") for d in range(1, 5)],
    }
    repo = FakeFeedRepo(rows)
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    got, _ = _drain_with_limits(handler, repo, [1, 5, 2, 7])
    _assert_history(got, expected)


def test_cursor_from_small_page_resumed_with_large_page(handler):
    # Concrete limit=A -> limit=B: page 1 tiny (limit=1), then a big second page. The big
    # page must pick up EXACTLY where the tiny page left off — no repeat of page-1 rows,
    # no skipped row between them.
    rows = {
        ANZ: [_row(ANZ, "2026-07-09", "a9"), _row(ANZ, "2026-07-06", "a6")],
        SPENDING: [_row(SPENDING, "2026-07-08", "s8"), _row(SPENDING, "2026-07-05", "s5")],
        HOMELOAN: [_row(HOMELOAN, "2026-07-07", "h7"), _row(HOMELOAN, "2026-07-04", "h4")],
    }
    repo = FakeFeedRepo(rows)
    page1 = json.loads(_one_page(handler, repo, limit=1)["body"])
    assert [t["transaction_id"] for t in page1["transactions"]] == ["a9"]  # newest overall
    page2 = json.loads(_one_page(handler, repo, cursor=page1["nextCursor"], limit=50)["body"])
    ids2 = [t["transaction_id"] for t in page2["transactions"]]
    assert "a9" not in ids2                                   # no repeat across the size jump
    combined = page1["transactions"] + page2["transactions"]
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    _assert_history(combined, expected)
    assert page2["nextCursor"] is None


# --- [G4] resume on a same-date boundary within one account -----------------------

def test_same_date_run_within_one_account_split_by_size_change(handler):
    # One account, five rows all on the SAME date. A limit=2 first page splits the run; the
    # resume key lands mid-run. Resume with a different size and the rest must appear once,
    # in a stable order, none dropped or repeated.
    rows = {SPENDING: [_row(SPENDING, "2026-07-01", f"s{i}") for i in range(5)]}
    repo = FakeFeedRepo(rows)
    got, _ = _drain_with_limits(handler, repo, [2, 3])   # 2 then 3 straddles the 5-run
    expected = [r["transaction_id"] for r in rows[SPENDING]]
    _assert_history(got, expected)


def test_same_date_across_accounts_resume_boundary_with_size_change(handler):
    # Same date on all three accounts AND older tails, page size changing each page. The
    # equal-date tiebreak (ACCOUNT_ID_MAP order) must stay stable across the resume so no
    # tie-row is lost or doubled.
    rows = {
        ANZ: [_row(ANZ, "2026-07-01", "a_t"), _row(ANZ, "2026-06-01", "a_o")],
        SPENDING: [_row(SPENDING, "2026-07-01", "s_t"), _row(SPENDING, "2026-06-01", "s_o")],
        HOMELOAN: [_row(HOMELOAN, "2026-07-01", "h_t"), _row(HOMELOAN, "2026-06-01", "h_o")],
    }
    repo = FakeFeedRepo(rows)
    got, _ = _drain_with_limits(handler, repo, [1, 4, 2])
    expected = [r["transaction_id"] for acc in rows.values() for r in acc]
    _assert_history(got, expected)


# --- [G5] limit string edge cases -------------------------------------------------

def test_whitespace_padded_limit_is_accepted(handler):
    # int(" 5 ") == 5 in Python -> a padded but numeric limit is honoured, not a 400.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": "  5  "}), repo)
    assert resp["statusCode"] == 200
    assert all(call[3] == 5 for call in repo.calls)


def test_float_string_limit_is_400_and_never_hits_repo(handler):
    # "5.5" / "5.0" are not ints -> 400 (mirrors non-numeric), before any DynamoDB call.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": "5.5"}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_whitespace_only_limit_is_400(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": "   "}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_negative_limit_is_clamped_to_one_not_500(handler):
    # A negative Limit is a DynamoDB ValidationException (500); the clamp turns "-3" into 1.
    # Documents CURRENT behaviour: negative is silently clamped, NOT rejected as 400.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    resp = handler.get_transactions_feed(_feed_event({"limit": "-3"}), repo)
    assert resp["statusCode"] == 200
    assert all(call[3] == 1 for call in repo.calls)


# --- [G6] cursor decodes to valid JSON that isn't an object -----------------------

@pytest.mark.parametrize("payload", [[1, 2, 3], "just-a-string", 42, 3.14, True, None])
def test_cursor_valid_json_but_not_an_object_is_400(handler, payload):
    # base64 of a JSON list/string/number/bool/null is well-formed JSON but not the
    # {v, a} object -> must be a clean 400, never a 500 on .get()/ExclusiveStartKey.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})
    forged = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode("ascii")
    resp = handler.get_transactions_feed(_feed_event({"cursor": forged}), repo)
    assert resp["statusCode"] == 400
    assert repo.calls == []


# --- [G7] large valid resume map with unknown account ids -------------------------

def test_large_resume_map_with_unknown_accounts_is_tolerated(handler):
    # A validly-shaped cursor may name accounts we no longer serve (a renamed/removed
    # account, or a client on stale config). Each must be queried, return empty, and drop
    # out — never a 500. Known accounts still page normally.
    unknown = {}
    for i in range(60):
        acc = f"ghost-account-{i}"
        unknown[acc] = {"account_id": acc, "date": "2026-07-01",
                        "pk": f"ACCOUNT#{acc}", "sk": f"TXN#g{i}"}
    resume = {SPENDING: None, ANZ: None, **unknown}
    token = handler._encode_feed_cursor(resume)

    repo = FakeFeedRepo({
        SPENDING: [_row(SPENDING, "2026-07-03", "s3"), _row(SPENDING, "2026-07-01", "s1")],
        ANZ: [_row(ANZ, "2026-07-02", "a2")],
    })
    resp = handler.get_transactions_feed(_feed_event({"cursor": token, "limit": "50"}), repo)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    ids = [t["transaction_id"] for t in body["transactions"]]
    assert ids == ["s3", "a2", "s1"]                 # known accounts merged newest-first
    # Ghost accounts contributed nothing and must not linger in the next cursor.
    if body["nextCursor"] is not None:
        decoded = handler._decode_feed_cursor(body["nextCursor"])
        assert not any(a.startswith("ghost-account-") for a in decoded)
    else:
        pass  # fully drained -> no cursor at all, also fine


# --- [G8] Decimal amounts serialise through the feed ------------------------------

def test_decimal_amounts_serialise_through_feed_no_500(handler):
    # DynamoDB hands numbers back as Decimal. The feed reuses DecimalEncoder; a raw
    # json.dumps of a Decimal would raise (a 500). Assert a real JSON number comes out.
    rows = {SPENDING: [
        _row(SPENDING, "2026-07-02", "s2", amount=Decimal("-12.34"), balance=Decimal("100")),
        _row(SPENDING, "2026-07-01", "s1", amount=Decimal("0")),
    ]}
    repo = FakeFeedRepo(rows)
    resp = handler.get_transactions_feed(_feed_event({}), repo)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])           # would raise if body weren't valid JSON
    txns = {t["transaction_id"]: t for t in body["transactions"]}
    assert txns["s2"]["amount"] == pytest.approx(-12.34)
    assert isinstance(txns["s2"]["amount"], float)
    assert txns["s1"]["amount"] == 0
