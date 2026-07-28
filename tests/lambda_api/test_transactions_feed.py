"""Tests for GET /transactions/feed — the all-accounts feed paged back through FULL
history (get_transactions_feed + _fetch_feed_page).

Unlike test_handler.py's /range tests (which use a queued-pages fake), most of these use
FakeFeedRepo, a realistic stand-in that models DynamoDB's date-index newest-first query
with ExclusiveStartKey — resuming STRICTLY AFTER a cursor key. That is what makes the
multi-page merge assertions meaningful: the feed re-queries each account from its own
resume position every page, so a fake that just pops pre-canned pages could not exercise
the no-dupe / no-gap / keep-prior-cursor behaviour that is the crux of the design.
"""

import base64
import copy
import json

import pytest

# The three internal account ids, in ACCOUNT_ID_MAP order.
ANZ = "anz-rewards-black-visa"
SPENDING = "up-spending"
HOMELOAN = "up-homeloan"


def _row(account_id, date, txn_id, **extra):
    """A stored transaction row as the date-index query returns it (with pk/sk)."""
    return {
        "pk": f"ACCOUNT#{account_id}", "sk": f"TXN#{txn_id}",
        "transaction_id": txn_id, "account_id": account_id, "date": date, **extra,
    }


class FakeFeedRepo:
    """Realistic stand-in modelling a date-index newest-first query with ExclusiveStartKey.

    Holds each account's rows sorted newest-first (date desc, sk desc as the intra-date
    tiebreak, mirroring how DynamoDB disambiguates equal sort-key values by the base key)
    and resumes STRICTLY AFTER the row a cursor names. Returns a LastEvaluatedKey only when
    genuine rows remain past the page, and hands out deep copies (the handler mutates rows
    in place: pop pk/sk, setdefault category)."""

    def __init__(self, rows_by_account):
        self._rows = {
            account_id: sorted(rows, key=lambda r: (r["date"], r["sk"]), reverse=True)
            for account_id, rows in rows_by_account.items()
        }
        self.calls = []

    @staticmethod
    def _key(row):
        return {
            "account_id": row["account_id"], "date": row["date"],
            "pk": row["pk"], "sk": row["sk"],
        }

    def get_transactions_by_date_range(
        self, account_id, start_date, end_date, limit=20, cursor=None
    ):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        rows = self._rows.get(account_id, [])
        start = 0
        if cursor is not None:
            for index, row in enumerate(rows):
                if row["pk"] == cursor["pk"] and row["sk"] == cursor["sk"]:
                    start = index + 1
                    break
        page = rows[start:start + limit]
        has_more = (start + limit) < len(rows) and bool(page)
        next_key = self._key(page[-1]) if has_more else None
        return copy.deepcopy(page), next_key


def _feed_event(params=None):
    return {
        "rawPath": "/transactions/feed",
        "requestContext": {"http": {"method": "GET"}},
        "queryStringParameters": params,
    }


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
