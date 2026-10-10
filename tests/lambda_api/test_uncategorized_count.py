"""Tests for GET /transactions/uncategorized/count (get_uncategorized_count) — the
full-history uncategorized tally the app's badge, tab-bar dot, and "All caught up" empty
state read, so they reflect ALL history, not just the loaded feed pages (WHIT-500).

The count mirrors the client's categoryIsUnmapped EXACTLY: a charge whose category is null
or a raw value not in the user's taxonomy, excluding income — and deliberately NOT gated on
contributes_to_budget, so an excluded transfer still counts (the badge shows it, WHIT-330).

Runs the real TransactionRepository over a FakeTable (paged date-index reads) so the "deep
page" case — an old unfiled charge beyond page 1 — is genuinely exercised, since that is the bug.
"""

import json

import pytest

from _feed_fakes import ANZ, HOMELOAN, FakeCategoryRepo, date_reads, real_repos, _row

_NO_KEY = object()


@pytest.mark.parametrize(("account", "category", "counted"), [
    (ANZ, None, 1),
    (ANZ, _NO_KEY, 1),                # a stored row with no category key at all
    (ANZ, "FOOD_AND_DRINK", 1),       # a raw BankSync enum, not in the taxonomy
    (ANZ, "groceries", 0),            # mapped
    (ANZ, "income", 0),
    (ANZ, "INCOME", 1),               # the income match is exact, like the client's
    (HOMELOAN, None, 1),              # every account is scanned, the home loan too
])
def test_counts_uncategorized_across_all_accounts(handler, account, category, counted):
    if category is _NO_KEY:
        row = _row(account, "2026-07-10", "t1")
    else:
        row = _row(account, "2026-07-10", "t1", category=category)
    table, repo, _ = real_repos({account: [row]})

    resp = handler.get_uncategorized_count(repo, FakeCategoryRepo({"groceries", "coffee"}))

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"count": counted}


def test_counts_an_excluded_transfer_not_gated_on_budget(handler):
    # FAIL-ON-REVERT: an uncategorized charge the user excluded from budgets (a transfer)
    # still counts. The badge counts it (WHIT-330), so the tally must not gate on
    # contributes_to_budget — adding that gate would wrongly drop this row.
    table, repo, _ = real_repos({
        ANZ: [_row(ANZ, "2026-07-10", "x", category=None,
                   counts_to_budget=False, budget_excluded=True)],
    })

    resp = handler.get_uncategorized_count(repo, FakeCategoryRepo(set()))

    assert json.loads(resp["body"]) == {"count": 1}


def test_counts_an_uncategorized_charge_on_a_later_page(handler):
    # The root bug: an old unfiled charge sits BEYOND the first page. Seed >100 filed rows on
    # one account plus one older uncategorized row, so the uncategorized one lands on page 2
    # (MAX_PAGE_SIZE = 100). It must still be counted, and the account must actually be paged.
    rows = [_row(ANZ, f"2026-05-{(i % 28) + 1:02d}", f"c{i}", category="groceries")
            for i in range(120)]
    rows.append(_row(ANZ, "2020-01-01", "old", category=None))  # oldest -> last page
    table, repo, _ = real_repos({ANZ: rows})

    resp = handler.get_uncategorized_count(repo, FakeCategoryRepo({"groceries"}))

    assert json.loads(resp["body"]) == {"count": 1}  # only "old"
    anz_calls = [call for call in date_reads(table) if call[0] == ANZ]
    assert len(anz_calls) > 1  # genuinely paged past the first page



