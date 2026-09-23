"""Tests for the Transactions-tab search over ALL history (WHIT-576): the pure matcher in
lambda_api/transaction_search.py and the GET /transactions/search route.

The bug: the app filtered only its loaded feed pages (30 rows each), so an older match showed
"No matches". The route reads every row once, so a match deep in one account's history is
found. FakeFeedRepo pages at MAX_PAGE_SIZE, so the deep case genuinely crosses a page boundary.
"""

import json
import pathlib

import pytest

from _feed_fakes import ANZ, SPENDING, HOMELOAN, WESTPAC, _row, FakeFeedRepo

_FIXTURE = json.loads(
    (pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "transaction_search_parity.json").read_text()
)


class _NamedCategoryRepo:
    """Taxonomy stub WITH names — search matches on the category's name, which FakeCategoryRepo
    (ids only) doesn't carry."""

    def __init__(self, categories):
        self._categories = categories

    def list_categories(self):
        return [dict(category) for category in self._categories]


_CATEGORIES = _NamedCategoryRepo(_FIXTURE["categories"])


def _search_event(params):
    return {
        "rawPath": "/transactions/search",
        "requestContext": {"http": {"method": "GET"}},
        "queryStringParameters": params,
    }


def _search(handler, repo, params):
    return handler.get_transactions_search(_search_event(params), repo, _CATEGORIES)


def _body(response):
    assert response["statusCode"] == 200
    return json.loads(response["body"])


# --- parity with the app's matcher ------------------------------------------


@pytest.mark.parametrize("case", _FIXTURE["cases"], ids=lambda case: case["name"])
def test_matcher_reproduces_every_shared_parity_case(transaction_search, case):
    category_names = {category["id"]: category["name"] for category in _FIXTURE["categories"]}
    expected = case["match"] and (case.get("via") != "notesTags" or _FIXTURE["includeNotesAndTags"])
    assert transaction_search.transaction_matches_search(case["txn"], case["query"], category_names) is expected


def test_server_settings_match_the_shared_fixture(transaction_search):
    assert transaction_search.SEARCH_NOTES_AND_TAGS is _FIXTURE["includeNotesAndTags"]
    assert transaction_search.SEARCH_QUERY_MAX_LEN == _FIXTURE["queryMaxLength"]


# --- the route: whole history -----------------------------------------------


def test_finds_a_match_deeper_than_the_first_page(handler):
    # The "steven" bug: 150 newer ANZ rows push the match past one MAX_PAGE_SIZE page.
    newer = [_row(ANZ, f"2026-08-{day:02d}", f"a{index}", merchant_name="Coles", description="COLES", amount=-5)
             for index, day in enumerate([1 + index % 28 for index in range(150)])]
    old = _row(ANZ, "2025-01-03", "old", merchant_name="Steven Nguyen", description="OSKO", amount=-50)
    repo = FakeFeedRepo({ANZ: newer + [old]})

    body = _body(_search(handler, repo, {"q": "steven"}))

    assert [txn["transaction_id"] for txn in body["transactions"]] == ["old"]
    assert body["truncated"] is False
    anz_cursors = [call[4] for call in repo.calls if call[0] == ANZ]
    assert any(cursor is not None for cursor in anz_cursors), "the scan must page past ANZ's first page"


def test_matches_every_account_newest_first_with_feed_tie_order(handler):
    repo = FakeFeedRepo({
        ANZ: [_row(ANZ, "2026-07-10", "a1", description="GIFT FOR STEVEN", amount=-1)],
        SPENDING: [_row(SPENDING, "2026-07-12", "s1", description="STEVEN", amount=-1)],
        HOMELOAN: [_row(HOMELOAN, "2026-07-10", "h1", description="steven loan", amount=-1)],
        WESTPAC: [_row(WESTPAC, "2026-07-11", "w1", description="Steven", amount=-1),
                  _row(WESTPAC, "2026-07-11", "w2", description="nobody", amount=-1)],
    })

    body = _body(_search(handler, repo, {"q": "steven"}))

    # Equal 07-10 dates keep ACCOUNT_ID_MAP order (ANZ before the home loan), as the feed does.
    assert [txn["transaction_id"] for txn in body["transactions"]] == ["s1", "w1", "a1", "h1"]


def test_rows_are_shaped_like_feed_rows(handler):
    repo = FakeFeedRepo({ANZ: [_row(ANZ, "2026-07-10", "a1", description="STEVEN", amount=-1)]})

    [txn] = _body(_search(handler, repo, {"q": "steven"}))["transactions"]

    assert "pk" not in txn and "sk" not in txn
    assert txn["category"] is None


def test_matches_on_category_name(handler):
    repo = FakeFeedRepo({ANZ: [_row(ANZ, "2026-07-10", "a1", description="PHO", amount=-1, category="eating_out"),
                               _row(ANZ, "2026-07-09", "a2", description="COLES", amount=-1, category="groceries")]})

    body = _body(_search(handler, repo, {"q": "eating out"}))

    assert [txn["transaction_id"] for txn in body["transactions"]] == ["a1"]


def test_uncategorized_tab_keeps_only_unfiled_matches(handler):
    repo = FakeFeedRepo({ANZ: [
        _row(ANZ, "2026-07-10", "null", description="STEVEN", amount=-1, category=None),
        _row(ANZ, "2026-07-09", "enum", description="STEVEN", amount=-1, category="FOOD_AND_DRINK"),
        _row(ANZ, "2026-07-08", "filed", description="STEVEN", amount=-1, category="groceries"),
        _row(ANZ, "2026-07-07", "income", description="STEVEN", amount=100, category="income"),
    ]})

    body = _body(_search(handler, repo, {"q": "steven", "tab": "uncategorized"}))

    assert [txn["transaction_id"] for txn in body["transactions"]] == ["null", "enum"]


def test_caps_results_and_flags_truncated(handler, transaction_search):
    limit = transaction_search.SEARCH_RESULT_LIMIT
    rows = [_row(ANZ, f"2026-{1 + index // 28 % 12:02d}-{1 + index % 28:02d}", f"a{index}",
                 description="STEVEN", amount=-1) for index in range(limit + 1)]

    body = _body(_search(handler, FakeFeedRepo({ANZ: rows}), {"q": "steven"}))

    assert len(body["transactions"]) == limit
    assert body["truncated"] is True
    dates = [txn["date"] for txn in body["transactions"]]
    assert dates == sorted(dates, reverse=True)


def test_exactly_the_limit_is_not_truncated(handler, transaction_search):
    limit = transaction_search.SEARCH_RESULT_LIMIT
    rows = [_row(ANZ, "2026-07-10", f"a{index}", description="STEVEN", amount=-1) for index in range(limit)]

    body = _body(_search(handler, FakeFeedRepo({ANZ: rows}), {"q": "steven"}))

    assert len(body["transactions"]) == limit
    assert body["truncated"] is False


# --- bad input --------------------------------------------------------------


@pytest.mark.parametrize("params", [None, {}, {"q": ""}, {"q": "   "}])
def test_blank_query_is_a_400(handler, params):
    response = handler.get_transactions_search(_search_event(params), FakeFeedRepo({}), _CATEGORIES)
    assert response["statusCode"] == 400


def test_query_length_limit(handler, transaction_search):
    max_len = transaction_search.SEARCH_QUERY_MAX_LEN
    assert _search(handler, FakeFeedRepo({}), {"q": "a" * max_len})["statusCode"] == 200
    assert _search(handler, FakeFeedRepo({}), {"q": "a" * (max_len + 1)})["statusCode"] == 400


def test_unknown_tab_is_a_400(handler):
    assert _search(handler, FakeFeedRepo({}), {"q": "steven", "tab": "budgets"})["statusCode"] == 400


def test_the_router_dispatches_the_search_path(handler, monkeypatch):
    seen = {}

    def fake_search(event, transaction_repo, category_repo):
        seen["event"] = event
        return {"statusCode": 200, "body": "{}"}

    monkeypatch.setattr(handler, "get_transactions_search", fake_search)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: object())

    handler.lambda_handler(_search_event({"q": "steven"}), None)

    assert seen["event"]["queryStringParameters"] == {"q": "steven"}
