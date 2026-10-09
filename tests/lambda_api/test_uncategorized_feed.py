"""Tests for GET /transactions/uncategorized/feed — the uncategorized-only feed paged back
through FULL history (get_uncategorized_feed + _fetch_uncategorized_feed_page).

Same {transactions, nextCursor} shape and cursor format as /transactions/feed, but each page
returns only uncategorized charges, using the SAME rule as get_uncategorized_count so the tab
list and the badge can't disagree. Runs the real TransactionRepository over a FakeTable (paged
date-index reads) so the "deep page" case — old unfiled charges beyond page 1 — is genuinely
exercised, since that is the bug this endpoint fixes.
"""

import json

import pytest

from _feed_fakes import (
    uncategorized_feed_event,
    ANZ, SPENDING, HOMELOAN, WESTPAC, FakeCategoryRepo, real_repos, _row,
)


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
        resp = handler.get_uncategorized_feed(uncategorized_feed_event(page_params), repo, category_repo)
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
    table, repo, _ = real_repos({
        ANZ: [_row(ANZ, "2026-07-10", "a1", category=None),               # null -> listed
              _row(ANZ, "2026-07-09", "a2", category="groceries")],       # mapped -> not
        SPENDING: [_row(SPENDING, "2026-07-11", "s1", category="FOOD_AND_DRINK")],  # raw enum -> listed
        HOMELOAN: [_row(HOMELOAN, "2026-07-08", "h1", category=None)],    # null -> listed
        WESTPAC: [_row(WESTPAC, "2026-07-07", "w1", category="income")],  # income -> not
    })

    resp = handler.get_uncategorized_feed(
        uncategorized_feed_event({}), repo, FakeCategoryRepo({"groceries", "coffee"})
    )

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert [t["transaction_id"] for t in body["transactions"]] == ["s1", "a1", "h1"]
    assert body["nextCursor"] is None  # everything fit and history exhausted


# --- fill-the-page over sparse history ---------------------------------------


def test_fills_a_page_past_many_filed_rows(handler):
    # A page must gather ~target uncategorized rows even when they're interleaved with lots of
    # filed rows — the internal loop keeps pulling raw chunks. 250 filed rows then 5 old
    # uncategorized ones; a limit=5 first page must surface all 5.
    rows = [_row(SPENDING, f"2026-06-{(i % 28) + 1:02d}", f"filed{i}", category="groceries")
            for i in range(250)]
    rows += [_row(SPENDING, f"2020-01-{d:02d}", f"old{d}", category=None) for d in range(1, 6)]
    table, repo, _ = real_repos({SPENDING: rows})

    resp = handler.get_uncategorized_feed(
        uncategorized_feed_event({"limit": "5"}), repo, FakeCategoryRepo({"groceries"})
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
    table, repo, _ = real_repos({ANZ: anz, WESTPAC: wpc})

    drained = _drain(handler, repo, FakeCategoryRepo({"groceries"}), limit=2)

    ids = [t["transaction_id"] for t in drained]
    assert set(ids) == {"anz-old", "w-old"}      # only the uncategorized, both found
    assert len(ids) == 2                          # no dupes
    dates = [t["date"] for t in drained]
    assert dates == sorted(dates, reverse=True)   # newest-first


def test_all_filed_history_returns_empty_page_and_null_cursor(handler):
    # WHIT-499 counterpart: a user with charges but NONE uncategorized -> the feed walks all
    # history, finds nothing, and returns a null cursor (no false "more pages").
    rows = [_row(SPENDING, f"2026-06-{(i % 28) + 1:02d}", f"s{i}", category="groceries")
            for i in range(40)]
    table, repo, _ = real_repos({SPENDING: rows})
    resp = handler.get_uncategorized_feed(uncategorized_feed_event({}), repo, FakeCategoryRepo({"groceries"}))
    body = json.loads(resp["body"])
    assert body["transactions"] == []
    assert body["nextCursor"] is None


# --- predicate parity with the count -----------------------------------------


def test_feed_total_equals_count_over_same_data(handler):
    # The list, drained to exhaustion, must have exactly as many rows as the badge count over
    # the same data — the whole point of sharing is_unfiled_category.
    rows = {
        ANZ: [_row(ANZ, "2026-07-10", "a1", category=None),
              _row(ANZ, "2026-07-09", "a2", category="groceries"),
              _row(ANZ, "2026-07-08", "a3", category="FOOD")],
        SPENDING: [_row(SPENDING, "2026-07-07", "s1", category="income"),
                   _row(SPENDING, "2026-07-06", "s2", category=None),
                   # An unfiled transfer excluded from budgets is still listed AND counted
                   # (WHIT-330): neither side may gate on contributes_to_budget.
                   _row(SPENDING, "2026-07-05", "s3", category=None,
                        counts_to_budget=False, budget_excluded=True)],
    }
    category_repo = FakeCategoryRepo({"groceries"})

    drained = _drain(handler, real_repos(rows)[1], category_repo, limit=2)
    count_resp = handler.get_uncategorized_count(real_repos(rows)[1], FakeCategoryRepo({"groceries"}))

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
    table, repo, _ = real_repos({SPENDING: filed})

    first = json.loads(
        handler.get_uncategorized_feed(
            uncategorized_feed_event({"limit": "5"}), repo, FakeCategoryRepo({"groceries"}))["body"]
    )
    assert first["transactions"] == []          # cap hit before the deep row
    assert first["nextCursor"] is not None       # but NOT a false end-of-history

    # Draining from scratch (each request capped at 2 chunks) still reaches the deep row.
    drained = _drain(handler, repo, FakeCategoryRepo({"groceries"}), limit=5)
    assert [t["transaction_id"] for t in drained] == ["deep"]


# --- overshoot with a live cursor: the page is never truncated -----------------


def test_overshoot_page_returns_all_rows_untruncated_and_resumes_gap_free(handler, monkeypatch):
    # A chunk of 3 uncategorized rows overshoots target=2 WHILE more history (a non-null cursor)
    # remains. The page must return all 3 (never truncated to 2), because the cursor has advanced
    # past all 3 — dropping one would lose it forever (a gap).
    monkeypatch.setattr(handler, "MAX_PAGE_SIZE", 3)  # 3-row raw chunks -> forces the multi-chunk walk
    rows = [_row(SPENDING, f"2026-06-{d:02d}", f"u{d}", category=None) for d in range(6, 0, -1)]
    table, repo, _ = real_repos({SPENDING: rows})  # 6 uncategorized rows, newest u6 .. oldest u1

    first = json.loads(
        handler.get_uncategorized_feed(
            uncategorized_feed_event({"limit": "2"}), repo, FakeCategoryRepo(set()))["body"]
    )
    assert len(first["transactions"]) == 3          # overshoot: the whole first chunk, NOT clamped to 2
    assert first["nextCursor"] is not None           # and more history behind it

    drained = _drain(handler, repo, FakeCategoryRepo(set()), limit=2)
    ids = [t["transaction_id"] for t in drained]
    assert ids == [f"u{d}" for d in range(6, 0, -1)]  # every row once, newest-first, no dupe/gap
