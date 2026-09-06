"""Tests for GET /transactions/uncategorized/count (get_uncategorized_count) — the
full-history uncategorized tally the app's badge, tab-bar dot, and "All caught up" empty
state read, so they reflect ALL history, not just the loaded feed pages (WHIT-500).

The count mirrors the client's categoryIsUnmapped EXACTLY: a charge whose category is null
or a raw value not in the user's taxonomy, excluding income — and deliberately NOT gated on
contributes_to_budget, so an excluded transfer still counts (the badge shows it, WHIT-330).

Reuses FakeFeedRepo (the realistic paginated date-index stand-in) so the "deep page" case —
an old unfiled charge beyond page 1 — is genuinely exercised, since that is the bug.
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, HOMELOAN, WESTPAC, _row, FakeFeedRepo


class _FakeCategoryRepo:
    def __init__(self, category_ids):
        self._categories = [{"id": category_id} for category_id in category_ids]

    def list_categories(self):
        return [dict(category) for category in self._categories]


def test_counts_uncategorized_across_all_accounts(handler):
    # null category + a raw BankSync enum count; a mapped category and income do not; every
    # account is scanned, including the home loan.
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "a1", category=None),                 # null -> counted
              _row(ANZ, "2026-07-09", "a2", category="groceries")],         # mapped -> not
        SPENDING: [_row(SPENDING, "2026-07-08", "s1", category="FOOD_AND_DRINK")],  # raw enum -> counted
        HOMELOAN: [_row(HOMELOAN, "2026-07-07", "h1", category=None)],      # home-loan null -> counted
        WESTPAC: [_row(WESTPAC, "2026-07-06", "w1", category="income")],    # income -> not
    })

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo({"groceries", "coffee"}))

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"count": 3}  # a1, s1, h1


def test_counts_an_excluded_transfer_not_gated_on_budget(handler):
    # FAIL-ON-REVERT: an uncategorized charge the user excluded from budgets (a transfer)
    # still counts. The badge counts it (WHIT-330), so the tally must not gate on
    # contributes_to_budget — adding that gate would wrongly drop this row.
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "x", category=None,
                   counts_to_budget=False, budget_excluded=True)],
    })

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo(set()))

    assert json.loads(resp["body"]) == {"count": 1}


def test_counts_an_uncategorized_charge_on_a_later_page(handler):
    # The root bug: an old unfiled charge sits BEYOND the first page. Seed >100 filed rows on
    # one account plus one older uncategorized row, so the uncategorized one lands on page 2
    # (MAX_PAGE_SIZE = 100). It must still be counted, and the account must actually be paged.
    rows = [_row(ANZ, f"2026-05-{(i % 28) + 1:02d}", f"c{i}", category="groceries")
            for i in range(120)]
    rows.append(_row(ANZ, "2020-01-01", "old", category=None))  # oldest -> last page
    repo = FakeFeedRepo({ANZ: rows})

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo({"groceries"}))

    assert json.loads(resp["body"]) == {"count": 1}  # only "old"
    anz_calls = [call for call in repo.calls if call[0] == ANZ]
    assert len(anz_calls) > 1  # genuinely paged past the first page


def test_scans_whole_history_with_no_date_floor(handler):
    # The count must query each account with start=end=None (whole partition), not a window.
    repo = FakeFeedRepo({ANZ: [_row(ANZ, "2026-07-10", "a1", category=None)]})

    handler.get_uncategorized_count(repo, _FakeCategoryRepo(set()))

    anz_call = next(call for call in repo.calls if call[0] == ANZ)
    assert anz_call[1] is None and anz_call[2] is None  # no start/end date floor


def test_empty_history_counts_zero(handler):
    resp = handler.get_uncategorized_count(FakeFeedRepo({}), _FakeCategoryRepo({"groceries"}))
    assert json.loads(resp["body"]) == {"count": 0}


def test_route_wires_to_get_uncategorized_count(handler, monkeypatch):
    # GET /transactions/uncategorized/count reaches get_uncategorized_count and returns {count}.
    repo = FakeFeedRepo({ANZ: [_row(ANZ, "2026-07-10", "a1", category=None)]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _FakeCategoryRepo(set()))

    event = {
        "rawPath": "/transactions/uncategorized/count",
        "requestContext": {"http": {"method": "GET"}},
    }
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"count": 1}


def test_unbounded_pagination_raises(handler):
    # A cursor that never terminates must raise (bounded read), not hang.
    class _NeverEndsRepo:
        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
            return [_row(account_id, "2026-01-01", "x", category=None)], {"pk": "p", "sk": "s"}

    with pytest.raises(RuntimeError, match="did not terminate"):
        handler.get_uncategorized_count(_NeverEndsRepo(), _FakeCategoryRepo(set()))


# ---------------------------------------------------------------------------
# WHIT-500 adversarial gap tests (QA). Each notes the implementer test it does
# NOT duplicate. Predicate = category != "income" AND category not in taxonomy,
# mirroring the client's categoryIsUnmapped, ungated on budget.
# ---------------------------------------------------------------------------


def test_counts_row_with_no_category_key_at_all(handler):
    # GAP vs test_counts_uncategorized_across_all_accounts (uses explicit category=None):
    # a stored row with NO "category" key at all. The predicate must read via .get so a
    # missing key -> None -> counted, exactly like the client. A row["category"] access
    # would KeyError (500) instead.
    repo = FakeFeedRepo({ANZ: [_row(ANZ, "2026-07-10", "nokey")]})  # no category kwarg

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo({"groceries"}))

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"count": 1}


def test_counts_empty_string_category(handler):
    # GAP: predicate edge. category="" is not "income" and (as "" is never a real taxonomy
    # id) not in the taxonomy -> counted, matching the client. Locks that an empty-string
    # category is NOT silently treated as mapped.
    repo = FakeFeedRepo({ANZ: [_row(ANZ, "2026-07-10", "empty", category="")]})

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo({"groceries"}))

    assert json.loads(resp["body"]) == {"count": 1}


def test_counts_whitespace_category(handler):
    # GAP: a whitespace-only category is a raw junk value, not a taxonomy id -> counted,
    # matching the client (no trimming either side). Guards against a one-sided .strip()/
    # falsy filter that would diverge server from client.
    repo = FakeFeedRepo({ANZ: [_row(ANZ, "2026-07-10", "ws", category="   ")]})

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo(set()))

    assert json.loads(resp["body"]) == {"count": 1}


def test_income_match_is_case_sensitive_exact(handler):
    # GAP: the income exclusion is an EXACT match, mirroring the client's
    # categoryId !== 'income'. A raw uppercase "INCOME" enum is not the mapped income
    # bucket, so it counts as uncategorized on both sides.
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "raw", category="INCOME"),    # raw enum -> counted
              _row(ANZ, "2026-07-09", "real", category="income")],  # mapped income -> not
    })

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo(set()))

    assert json.loads(resp["body"]) == {"count": 1}  # only "INCOME"


def test_counts_deep_paged_rows_across_multiple_accounts(handler):
    # GAP vs test_counts_an_uncategorized_charge_on_a_later_page (ONE account): the count
    # must page EACH account to completion. Two accounts, each with >100 filed rows plus one
    # old uncategorized row on a later page. Both counted, both accounts paged past page 1.
    anz_rows = [_row(ANZ, f"2026-05-{(i % 28) + 1:02d}", f"anz{i}", category="groceries")
                for i in range(120)]
    anz_rows.append(_row(ANZ, "2020-01-01", "anz-old", category=None))
    wpc_rows = [_row(WESTPAC, f"2026-04-{(i % 28) + 1:02d}", f"w{i}", category="groceries")
                for i in range(120)]
    wpc_rows.append(_row(WESTPAC, "2019-01-01", "w-old", category=None))
    repo = FakeFeedRepo({ANZ: anz_rows, WESTPAC: wpc_rows})

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo({"groceries"}))

    assert json.loads(resp["body"]) == {"count": 2}  # anz-old + w-old
    assert len([c for c in repo.calls if c[0] == ANZ]) > 1
    assert len([c for c in repo.calls if c[0] == WESTPAC]) > 1


def test_empty_taxonomy_counts_every_non_income_charge(handler):
    # GAP: an EMPTY taxonomy (no categories created) -> every raw value is unmapped, so every
    # non-income charge counts. Guards that the count isn't anchored to a built-in category set.
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "g", category="groceries"),   # unmapped now -> counted
              _row(ANZ, "2026-07-09", "n", category=None),          # null -> counted
              _row(ANZ, "2026-07-08", "i", category="income")],     # income -> not
    })

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo(set()))

    assert json.loads(resp["body"]) == {"count": 2}  # g + n, never i


def test_counts_a_pending_excluded_transfer(handler):
    # GAP vs test_counts_an_excluded_transfer_not_gated_on_budget (a POSTED excluded
    # transfer): a PENDING excluded transfer with a null category still counts. The predicate
    # ignores status and budget flags alike, so the badge and the list agree.
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "p", category=None, status="pending",
                   counts_to_budget=False, budget_excluded=True)],
    })

    resp = handler.get_uncategorized_count(repo, _FakeCategoryRepo(set()))

    assert json.loads(resp["body"]) == {"count": 1}


def test_post_to_count_path_is_not_routed_to_count(handler, monkeypatch):
    # GAP vs test_route_wires_to_get_uncategorized_count (the GET happy path): the route is
    # method-gated. A POST to the same path must NOT reach get_uncategorized_count; it falls
    # through to 404. Guards against dropping the `and method == "GET"` gate.
    def _boom(*a, **k):
        raise AssertionError("get_uncategorized_count must not run for POST")

    monkeypatch.setattr(handler, "get_uncategorized_count", _boom)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: FakeFeedRepo({}))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _FakeCategoryRepo(set()))

    event = {
        "rawPath": "/transactions/uncategorized/count",
        "requestContext": {"http": {"method": "POST"}},
    }
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 404


def test_unbounded_pagination_propagates_through_handler(handler, monkeypatch):
    # GAP vs test_unbounded_pagination_raises (direct call): via the ROUTE, the RuntimeError
    # from the page ceiling is NOT caught by lambda_handler (only VersionConflictError -> 409
    # is), so it propagates. Documents the actual behaviour: a raw Lambda 5xx, not a JSON 500.
    # If a graceful mapping is added later, this test flips and should be updated deliberately.
    class _NeverEndsRepo:
        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
            return [_row(account_id, "2026-01-01", "x", category=None)], {"pk": "p", "sk": "s"}

    monkeypatch.setattr(handler, "TransactionRepository", lambda: _NeverEndsRepo())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _FakeCategoryRepo(set()))

    event = {
        "rawPath": "/transactions/uncategorized/count",
        "requestContext": {"http": {"method": "GET"}},
    }
    with pytest.raises(RuntimeError, match="did not terminate"):
        handler.lambda_handler(event, None)
