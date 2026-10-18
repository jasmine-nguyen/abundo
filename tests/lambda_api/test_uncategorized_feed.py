"""Tests for GET /transactions/uncategorized/feed — the uncategorized-only feed paged back
through FULL history (get_uncategorized_feed + _fetch_uncategorized_feed_page).

Same {transactions, nextCursor} shape and cursor format as /transactions/feed, but each page
returns only uncategorized charges, using the SAME rule as get_uncategorized_count so the tab
list and the badge can't disagree. Runs the real TransactionRepository over a FakeTable (paged
date-index reads) so the "deep page" case — old unfiled charges beyond page 1 — is genuinely
exercised, since that is the bug this endpoint fixes.
"""

import json
import math

import pytest

from _feed_fakes import (
    uncategorized_feed_event,
    ANZ, SPENDING, HOMELOAN, WESTPAC, FakeCategoryRepo, real_repos, _row, date_reads,
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
    monkeypatch.setattr(handler, "_MAX_UNCATEGORIZED_SCAN_ROWS", 2 * handler.MAX_PAGE_SIZE)
    # 2 * MAX_PAGE_SIZE filed rows (the whole cap) before the single uncategorized one.
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

    # Draining from scratch (each request capped) still reaches the deep row.
    drained = _drain(handler, repo, FakeCategoryRepo({"groceries"}), limit=5)
    assert [t["transaction_id"] for t in drained] == ["deep"]


# --- exact-size page with a live cursor: resumes gap-free ----------------------


def test_page_stops_at_target_and_resumes_gap_free(handler, monkeypatch):
    # 6 uncategorized rows, limit 2, 3-row database pages: the first page holds exactly 2 rows
    # (the cursor sits on the last row returned, so nothing is skipped) with more history behind
    # it, and draining yields every row once, newest-first.
    monkeypatch.setattr(handler, "MAX_PAGE_SIZE", 3)
    rows = [_row(SPENDING, f"2026-06-{d:02d}", f"u{d}", category=None) for d in range(6, 0, -1)]
    table, repo, _ = real_repos({SPENDING: rows})

    first = json.loads(
        handler.get_uncategorized_feed(
            uncategorized_feed_event({"limit": "2"}), repo, FakeCategoryRepo(set()))["body"]
    )
    assert [t["transaction_id"] for t in first["transactions"]] == ["u6", "u5"]
    assert first["nextCursor"] is not None

    drained = _drain(handler, repo, FakeCategoryRepo(set()), limit=2)
    ids = [t["transaction_id"] for t in drained]
    assert ids == [f"u{d}" for d in range(6, 0, -1)]


# --- one Load More reads each row at most once ---------------------------------


def test_one_load_more_reads_each_row_at_most_once(handler):
    # 4 accounts, each 250 filed rows then 2 unfiled ones at the bottom, in separate years so
    # the accounts drain one after another. Finding all 8 unfiled rows walks every account to
    # the end: each account must be read page by page, never re-read from a cursor (or from the
    # start) already used in this request.
    filed_per_account = 250
    rows_by_account = {}
    expected = []
    for year, account_id in zip((2026, 2025, 2024, 2023), (ANZ, SPENDING, HOMELOAN, WESTPAC)):
        rows = [_row(account_id, f"{year}-06-{(i % 28) + 1:02d}", f"{account_id}-f{i}",
                     category="groceries") for i in range(filed_per_account)]
        rows += [_row(account_id, f"{year}-01-0{d}", f"{account_id}-u{d}", category=None)
                 for d in (2, 1)]
        expected += [f"{account_id}-u2", f"{account_id}-u1"]
        rows_by_account[account_id] = rows
    table, repo, _ = real_repos(rows_by_account)

    body = json.loads(handler.get_uncategorized_feed(
        uncategorized_feed_event({"limit": "8"}), repo, FakeCategoryRepo({"groceries"}))["body"])

    assert [t["transaction_id"] for t in body["transactions"]] == expected
    reads = [(account_id, json.dumps(cursor, sort_keys=True))
             for account_id, _start, _end, _limit, cursor in date_reads(table)]
    assert len(reads) == len(set(reads)), "a database page was read twice in one request"
    pages_per_account = math.ceil((filed_per_account + 2) / handler.MAX_PAGE_SIZE) + 1
    assert len(reads) <= 4 * pages_per_account
