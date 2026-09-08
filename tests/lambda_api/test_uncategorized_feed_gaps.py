"""ADVERSARIAL gap tests for GET /transactions/uncategorized/feed — the paged uncategorized feed
(get_uncategorized_feed + _fetch_uncategorized_feed_page).

These do NOT duplicate tests/lambda_api/test_uncategorized_feed.py. That suite proves the
happy-path shaping, predicate parity with the count, the drain over deep history, the empty/all-
filed cases, the empty-page scan-cap case, and bad-input 400s. What it does NOT lock:

  * an OVERSHOOT page — a single raw chunk yields MORE than `target` uncategorized rows AND more
    history remains (a NON-null continuation cursor). The impl comment promises the accumulated
    rows are returned un-truncated because the cursor has already advanced past every raw row
    consumed, so truncating any would skip an uncategorized charge (a gap). The existing drain
    tests only overshoot on the FINAL (cursor-null) chunk, where truncation is caught as a
    visible short list; they never exercise overshoot with a live cursor behind it.
  * the scan-cap boundary that returns a SHORT but NON-EMPTY page (target-1 rows) with a live
    cursor — the existing cap test returns an EMPTY page.
  * the limit=1 boundary walked across multiple small raw chunks + sparse/dense accounts.

To force multiple raw chunks cheaply (MAX_PAGE_SIZE is 100 in prod), we monkeypatch
handler.MAX_PAGE_SIZE down. The chunk size the fill-loop asks DynamoDB for is that module global,
so lowering it makes each _fetch_feed_page call return a small slice — exactly the multi-chunk
regime the cursor logic must survive.
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, _row, FakeFeedRepo


class _FakeCategoryRepo:
    def __init__(self, category_ids):
        self._categories = [{"id": category_id} for category_id in category_ids]

    def list_categories(self):
        return [dict(category) for category in self._categories]


def _uncat_event(params=None):
    return {
        "rawPath": "/transactions/uncategorized/feed",
        "requestContext": {"http": {"method": "GET"}},
        "queryStringParameters": params,
    }


def _drain(handler, repo, category_repo, limit=None):
    params = {} if limit is None else {"limit": str(limit)}
    all_transactions = []
    cursor = None
    for _ in range(1000):
        page_params = dict(params)
        if cursor is not None:
            page_params["cursor"] = cursor
        resp = handler.get_uncategorized_feed(_uncat_event(page_params), repo, category_repo)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        all_transactions.extend(body["transactions"])
        cursor = body["nextCursor"]
        if cursor is None:
            return all_transactions
    pytest.fail("uncategorized feed did not terminate — nextCursor never went null")


# --- OVERSHOOT with a live cursor: page returns > target, un-truncated, resume is gap-free ----


def test_overshoot_page_returns_all_rows_untruncated_and_resumes_gap_free(handler, monkeypatch):
    # NOT covered by test_uncategorized_feed.py: its drain overshoots only on the final,
    # cursor-null chunk. Here a chunk of 3 uncategorized rows overshoots target=2 WHILE more
    # history (a non-null cursor) remains. The page must return all 3 (never truncated to 2),
    # because the cursor has advanced past all 3 — dropping one would lose it forever (a gap).
    monkeypatch.setattr(handler, "MAX_PAGE_SIZE", 3)  # 3-row raw chunks -> forces the multi-chunk walk
    rows = [_row(SPENDING, f"2026-06-{d:02d}", f"u{d}", category=None) for d in range(6, 0, -1)]
    repo = FakeFeedRepo({SPENDING: rows})  # 6 uncategorized rows, newest u6 .. oldest u1

    first = json.loads(
        handler.get_uncategorized_feed(_uncat_event({"limit": "2"}), repo, _FakeCategoryRepo(set()))["body"]
    )
    assert len(first["transactions"]) == 3          # overshoot: the whole first chunk, NOT clamped to 2
    assert first["nextCursor"] is not None           # and more history behind it

    drained = _drain(handler, repo, _FakeCategoryRepo(set()), limit=2)
    ids = [t["transaction_id"] for t in drained]
    assert ids == [f"u{d}" for d in range(6, 0, -1)]  # every row once, newest-first, no dupe/gap


# --- scan-cap boundary: a SHORT (non-empty) page with a live cursor, then completion -----------


def test_scan_cap_returns_short_nonempty_page_then_completes(handler, monkeypatch):
    # NOT covered by test_scan_cap_returns_short_page_with_non_null_cursor (which returns an EMPTY
    # page). Here the cap trips after gathering target-1 uncategorized rows: the page is short but
    # NON-empty, carries a live cursor, and the next request surfaces the remaining deep row.
    monkeypatch.setattr(handler, "MAX_PAGE_SIZE", 2)          # 2-row raw chunks
    monkeypatch.setattr(handler, "_MAX_UNCATEGORIZED_SCAN_PAGES", 2)  # cap at 2 chunks / request
    # newest->oldest: u,filed,u,filed,u,filed  -> 3 uncategorized total, one per 2-row chunk.
    rows = [
        _row(SPENDING, "2026-06-06", "u6", category=None),
        _row(SPENDING, "2026-06-05", "f5", category="groceries"),
        _row(SPENDING, "2026-06-04", "u4", category=None),
        _row(SPENDING, "2026-06-03", "f3", category="groceries"),
        _row(SPENDING, "2026-06-02", "u2", category=None),
        _row(SPENDING, "2026-06-01", "f1", category="groceries"),
    ]
    repo = FakeFeedRepo({SPENDING: rows})

    first = json.loads(
        handler.get_uncategorized_feed(_uncat_event({"limit": "3"}), repo, _FakeCategoryRepo({"groceries"}))["body"]
    )
    assert [t["transaction_id"] for t in first["transactions"]] == ["u6", "u4"]  # 2 of the wanted 3 (cap)
    assert first["nextCursor"] is not None                                        # NOT a false end-of-history

    drained = _drain(handler, repo, _FakeCategoryRepo({"groceries"}), limit=3)
    assert [t["transaction_id"] for t in drained] == ["u6", "u4", "u2"]  # deep row reached, all newest-first


# --- limit=1 boundary walked across small chunks + sparse-in-one/dense-in-another accounts -----


def test_limit_one_walk_across_sparse_and_dense_accounts(handler, monkeypatch):
    # NOT covered: the existing drain tests use limit=2 with the default (large) chunk. limit=1 is
    # the smallest target; with small chunks it becomes a near-per-row walk. One account is dense
    # with filed rows hiding a single deep uncategorized charge; the other is sparse. Draining must
    # still surface exactly the uncategorized set, once each, newest-first.
    monkeypatch.setattr(handler, "MAX_PAGE_SIZE", 2)
    anz = [_row(ANZ, f"2026-05-{d:02d}", f"anz{d}", category="groceries") for d in range(20, 5, -1)]
    anz.append(_row(ANZ, "2020-01-01", "anz-deep", category=None))          # dense account, deep uncat
    spending = [
        _row(SPENDING, "2026-05-30", "s-new", category=None),               # sparse account, recent uncat
        _row(SPENDING, "2019-01-01", "s-old", category="FEES"),             # raw enum -> uncategorized, deep
    ]
    repo = FakeFeedRepo({ANZ: anz, SPENDING: spending})

    drained = _drain(handler, repo, _FakeCategoryRepo({"groceries"}), limit=1)

    ids = [t["transaction_id"] for t in drained]
    assert set(ids) == {"s-new", "anz-deep", "s-old"}   # every uncategorized charge surfaced
    assert len(ids) == 3                                 # no dupes despite the limit=1 / small-chunk walk
    dates = [t["date"] for t in drained]
    assert dates == sorted(dates, reverse=True)          # newest-first across accounts
