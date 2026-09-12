"""Tests for GET /transactions/uncategorized/feed — the uncategorized-only feed paged back
through FULL history (get_uncategorized_feed + _fetch_uncategorized_feed_page).

Same {transactions, nextCursor} shape and cursor format as /transactions/feed, but each page
returns only uncategorized charges, using the SAME rule as get_uncategorized_count so the tab
list and the badge can't disagree. Reuses FakeFeedRepo (the realistic paginated date-index
stand-in) so the "deep page" case — old unfiled charges beyond page 1 — is genuinely
exercised, since that is the bug this endpoint fixes.
"""

import base64
import json

import pytest

from _feed_fakes import ANZ, SPENDING, HOMELOAN, WESTPAC, _row, FakeFeedRepo, FakeCategoryRepo


def _uncat_event(params=None):
    return {
        "rawPath": "/transactions/uncategorized/feed",
        "requestContext": {"http": {"method": "GET"}},
        "queryStringParameters": params,
    }


def _drain(handler, repo, category_repo, limit=None):
    """Page the uncategorized feed to exhaustion, following nextCursor. Returns the flat list
    of transactions across every page, in the order the client would see them. Rebuilds the
    category repo per call is unnecessary (it's read-only), so one instance is reused."""
    params = {} if limit is None else {"limit": str(limit)}
    all_transactions = []
    cursor = None
    for _ in range(1000):  # generous bound; a correct feed terminates well before this
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


# --- first page: only uncategorized rows, merged newest-first ----------------


def test_first_page_returns_only_uncategorized_merged_newest_first(handler):
    # Mapped + income rows are skipped; null-category and raw-enum rows across accounts merge
    # newest-first. Same predicate as the count.
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "a1", category=None),               # null -> listed
              _row(ANZ, "2026-07-09", "a2", category="groceries")],       # mapped -> not
        SPENDING: [_row(SPENDING, "2026-07-11", "s1", category="FOOD_AND_DRINK")],  # raw enum -> listed
        HOMELOAN: [_row(HOMELOAN, "2026-07-08", "h1", category=None)],    # null -> listed
        WESTPAC: [_row(WESTPAC, "2026-07-07", "w1", category="income")],  # income -> not
    })

    resp = handler.get_uncategorized_feed(
        _uncat_event({}), repo, FakeCategoryRepo({"groceries", "coffee"})
    )

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert [t["transaction_id"] for t in body["transactions"]] == ["s1", "a1", "h1"]
    assert body["nextCursor"] is None  # everything fit and history exhausted


def test_row_shape_strips_keys_and_defaults_category(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1")]})  # no category kwarg
    resp = handler.get_uncategorized_feed(_uncat_event({}), repo, FakeCategoryRepo(set()))
    txn = json.loads(resp["body"])["transactions"][0]
    assert "pk" not in txn and "sk" not in txn
    assert txn["category"] is None  # sparse field defaulted, matching the plain feed
    assert txn["transaction_id"] == "s1"


def test_first_page_defaults_to_feed_page_size_target(handler):
    # No ?limit= -> the page fills toward FEED_PAGE_SIZE uncategorized rows. Seed exactly that
    # many so the first page returns them all and then exhausts.
    rows = [_row(SPENDING, f"2026-06-{(i % 28) + 1:02d}", f"s{i}", category=None)
            for i in range(handler.FEED_PAGE_SIZE)]
    repo = FakeFeedRepo({SPENDING: rows})
    resp = handler.get_uncategorized_feed(_uncat_event({}), repo, FakeCategoryRepo(set()))
    body = json.loads(resp["body"])
    assert len(body["transactions"]) == handler.FEED_PAGE_SIZE


# --- fill-the-page over sparse history ---------------------------------------


def test_fills_a_page_past_many_filed_rows(handler):
    # A page must gather ~target uncategorized rows even when they're interleaved with lots of
    # filed rows — the internal loop keeps pulling raw chunks. 250 filed rows then 5 old
    # uncategorized ones; a limit=5 first page must surface all 5.
    rows = [_row(SPENDING, f"2026-06-{(i % 28) + 1:02d}", f"filed{i}", category="groceries")
            for i in range(250)]
    rows += [_row(SPENDING, f"2020-01-{d:02d}", f"old{d}", category=None) for d in range(1, 6)]
    repo = FakeFeedRepo({SPENDING: rows})

    resp = handler.get_uncategorized_feed(
        _uncat_event({"limit": "5"}), repo, FakeCategoryRepo({"groceries"})
    )

    body = json.loads(resp["body"])
    got = {t["transaction_id"] for t in body["transactions"]}
    assert got == {"old1", "old2", "old3", "old4", "old5"}


def test_deep_history_uncategorized_surfaced_by_load_more(handler):
    # The root bug: uncategorized charges sit deep in history. Drain the feed and every one
    # must appear exactly once, newest-first, across the pages.
    anz = [_row(ANZ, f"2026-05-{(i % 28) + 1:02d}", f"anz{i}", category="groceries")
           for i in range(120)]
    anz.append(_row(ANZ, "2020-01-01", "anz-old", category=None))
    wpc = [_row(WESTPAC, f"2026-04-{(i % 28) + 1:02d}", f"w{i}", category="groceries")
           for i in range(120)]
    wpc.append(_row(WESTPAC, "2019-01-01", "w-old", category="FEES"))  # raw enum, deep
    repo = FakeFeedRepo({ANZ: anz, WESTPAC: wpc})

    drained = _drain(handler, repo, FakeCategoryRepo({"groceries"}), limit=2)

    ids = [t["transaction_id"] for t in drained]
    assert set(ids) == {"anz-old", "w-old"}      # only the uncategorized, both found
    assert len(ids) == 2                          # no dupes
    dates = [t["date"] for t in drained]
    assert dates == sorted(dates, reverse=True)   # newest-first


def test_drain_reaches_all_uncategorized_no_dupes_no_gaps(handler):
    # Interleaved uncategorized + filed across accounts, small page size. Draining yields
    # exactly the uncategorized set, once each, newest-first.
    rows = {
        ANZ: [_row(ANZ, f"2026-07-{d:02d}", f"a{d}",
                   category=(None if d % 2 else "groceries")) for d in (1, 4, 7, 10, 13)],
        SPENDING: [_row(SPENDING, f"2026-07-{d:02d}", f"s{d}",
                        category=(None if d % 2 else "groceries")) for d in (2, 5, 8, 11, 14)],
        HOMELOAN: [_row(HOMELOAN, f"2026-07-{d:02d}", f"h{d}", category=None) for d in (3, 6, 9)],
    }
    repo = FakeFeedRepo(rows)
    expected = {
        r["transaction_id"]
        for acc in rows.values() for r in acc
        if r.get("category") != "groceries"
    }

    drained = _drain(handler, repo, FakeCategoryRepo({"groceries"}), limit=2)

    ids = [t["transaction_id"] for t in drained]
    assert set(ids) == expected
    assert len(ids) == len(expected)


def test_empty_history_returns_empty_page_and_null_cursor(handler):
    resp = handler.get_uncategorized_feed(_uncat_event({}), FakeFeedRepo({}), FakeCategoryRepo(set()))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"transactions": [], "nextCursor": None}


def test_all_filed_history_returns_empty_page_and_null_cursor(handler):
    # WHIT-499 counterpart: a user with charges but NONE uncategorized -> the feed walks all
    # history, finds nothing, and returns a null cursor (no false "more pages").
    rows = [_row(SPENDING, f"2026-06-{(i % 28) + 1:02d}", f"s{i}", category="groceries")
            for i in range(40)]
    repo = FakeFeedRepo({SPENDING: rows})
    resp = handler.get_uncategorized_feed(_uncat_event({}), repo, FakeCategoryRepo({"groceries"}))
    body = json.loads(resp["body"])
    assert body["transactions"] == []
    assert body["nextCursor"] is None


# --- predicate parity with the count -----------------------------------------


def test_lists_an_excluded_transfer_not_gated_on_budget(handler):
    # FAIL-ON-REVERT: an uncategorized charge the user excluded from budgets (a transfer) is
    # still listed. The badge counts it (WHIT-330), so the list must show it too — swapping in
    # the /breakdown contributes_to_budget-gated predicate would wrongly drop this row and make
    # the list shorter than the badge.
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "x", category=None,
                   counts_to_budget=False, budget_excluded=True)],
    })

    resp = handler.get_uncategorized_feed(_uncat_event({}), repo, FakeCategoryRepo(set()))

    body = json.loads(resp["body"])
    assert [t["transaction_id"] for t in body["transactions"]] == ["x"]


def test_income_and_mapped_never_listed(handler):
    # Mirrors the count's exclusions: exact "income" and any taxonomy id are filed, not listed.
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "raw", category="INCOME"),   # raw enum -> listed
              _row(ANZ, "2026-07-09", "inc", category="income"),   # mapped income -> not
              _row(ANZ, "2026-07-08", "map", category="groceries")],  # mapped -> not
    })

    resp = handler.get_uncategorized_feed(_uncat_event({}), repo, FakeCategoryRepo({"groceries"}))

    body = json.loads(resp["body"])
    assert [t["transaction_id"] for t in body["transactions"]] == ["raw"]


def test_feed_total_equals_count_over_same_data(handler):
    # The list, drained to exhaustion, must have exactly as many rows as the badge count over
    # the same data — the whole point of sharing _is_unmapped_category.
    rows = {
        ANZ: [_row(ANZ, "2026-07-10", "a1", category=None),
              _row(ANZ, "2026-07-09", "a2", category="groceries"),
              _row(ANZ, "2026-07-08", "a3", category="FOOD")],
        SPENDING: [_row(SPENDING, "2026-07-07", "s1", category="income"),
                   _row(SPENDING, "2026-07-06", "s2", category=None)],
    }
    category_repo = FakeCategoryRepo({"groceries"})

    drained = _drain(handler, FakeFeedRepo(rows), category_repo, limit=2)
    count_resp = handler.get_uncategorized_count(FakeFeedRepo(rows), FakeCategoryRepo({"groceries"}))

    assert len(drained) == json.loads(count_resp["body"])["count"]


# --- scan cap: sparse-deep uncategorized returns a continuation, never false end ----


def test_scan_cap_returns_short_page_with_non_null_cursor(handler, monkeypatch):
    # With uncategorized rows rarer than one request can reach under the cap, the page comes
    # back short (even empty) but with a NON-null cursor, and the next request resumes and
    # eventually surfaces the deep row — never a false "all caught up". Cap lowered so the test
    # stays cheap.
    monkeypatch.setattr(handler, "_MAX_UNCATEGORIZED_SCAN_PAGES", 2)
    # 2 chunks = 2 * MAX_PAGE_SIZE filed rows before the single uncategorized one.
    filed = [_row(SPENDING, f"2026-06-{(i % 28) + 1:02d}", f"f{i}", category="groceries")
             for i in range(2 * handler.MAX_PAGE_SIZE)]
    filed.append(_row(SPENDING, "2020-01-01", "deep", category=None))
    repo = FakeFeedRepo({SPENDING: filed})

    first = json.loads(
        handler.get_uncategorized_feed(_uncat_event({"limit": "5"}), repo, FakeCategoryRepo({"groceries"}))["body"]
    )
    assert first["transactions"] == []          # cap hit before the deep row
    assert first["nextCursor"] is not None       # but NOT a false end-of-history

    # Draining from scratch (each request capped at 2 chunks) still reaches the deep row.
    drained = _drain(handler, repo, FakeCategoryRepo({"groceries"}), limit=5)
    assert [t["transaction_id"] for t in drained] == ["deep"]


# --- bad input -> 400, never a 500 -------------------------------------------


def test_non_numeric_limit_is_400_and_never_hits_repo(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1", category=None)]})
    resp = handler.get_uncategorized_feed(_uncat_event({"limit": "abc"}), repo, FakeCategoryRepo(set()))
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_malformed_cursor_is_400(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1", category=None)]})
    bad = base64.urlsafe_b64encode(b"not json").decode("ascii")
    resp = handler.get_uncategorized_feed(_uncat_event({"cursor": bad}), repo, FakeCategoryRepo(set()))
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_limit_above_max_is_clamped(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1", category=None)]})
    handler.get_uncategorized_feed(_uncat_event({"limit": "500"}), repo, FakeCategoryRepo(set()))
    # The internal raw chunk is always MAX_PAGE_SIZE; the clamp bounds the target, so no query
    # ever asks DynamoDB for more than MAX_PAGE_SIZE.
    assert all(call[3] == handler.MAX_PAGE_SIZE for call in repo.calls)


def test_missing_query_params_uses_defaults_not_500(handler):
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1", category=None)]})
    event = {"rawPath": "/transactions/uncategorized/feed",
             "requestContext": {"http": {"method": "GET"}}, "queryStringParameters": None}
    resp = handler.get_uncategorized_feed(event, repo, FakeCategoryRepo(set()))
    assert resp["statusCode"] == 200


# --- dispatch through lambda_handler -----------------------------------------


def test_route_wires_to_get_uncategorized_feed(handler, monkeypatch):
    # GET /transactions/uncategorized/feed reaches get_uncategorized_feed, NOT the plain feed
    # or the count.
    repo = FakeFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "s1", category=None)]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(set()))
    monkeypatch.setattr(handler, "get_transactions_feed",
                        lambda *a, **k: pytest.fail("uncategorized route reached the plain feed"))

    resp = handler.lambda_handler(_uncat_event({}), None)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert [t["transaction_id"] for t in body["transactions"]] == ["s1"]
    assert body["nextCursor"] is None


def test_post_to_uncategorized_feed_is_not_routed(handler, monkeypatch):
    # Method-gated: a POST must not reach the handler; it falls through to 404.
    def _boom(*a, **k):
        raise AssertionError("get_uncategorized_feed must not run for POST")

    monkeypatch.setattr(handler, "get_uncategorized_feed", _boom)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: FakeFeedRepo({}))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(set()))

    event = {
        "rawPath": "/transactions/uncategorized/feed",
        "requestContext": {"http": {"method": "POST"}},
    }
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 404
