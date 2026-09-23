"""WHIT-576 — QA gap tests for GET /transactions/search, beyond test_transaction_search.py (which
calls get_transactions_search directly):

  [S2] only GET runs the search; a POST to the same path never does.
  [S3] a row with no `date` (missing or null) neither crashes the sort nor jumps ahead of dated rows.
"""


import pytest

from _feed_fakes import ANZ, _row, FakeFeedRepo


class _NamedCategoryRepo:
    def __init__(self):
        self.calls = 0

    def list_categories(self):
        self.calls += 1
        return [{"id": "groceries", "name": "Groceries"}]


def _event(params, method="GET"):
    return {
        "rawPath": "/transactions/search",
        "requestContext": {"http": {"method": method}},
        "queryStringParameters": params,
    }


@pytest.fixture
def routed(handler, monkeypatch):
    """lambda_handler wired to fakes, so the REAL get_transactions_search runs behind the router."""
    repo = FakeFeedRepo({ANZ: [_row(ANZ, "2026-07-10", "a1", description="STEVEN", amount=-1)]})
    categories = _NamedCategoryRepo()
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: categories)
    return handler, repo, categories


def test_post_to_the_search_path_never_runs_the_search(routed, monkeypatch):
    handler, repo, _categories = routed
    ran = []
    monkeypatch.setattr(handler, "get_transactions_search", lambda *args: ran.append(args))

    response = handler.lambda_handler(_event({"q": "steven"}, method="POST"), None)

    assert ran == []
    assert response["statusCode"] != 200
    assert repo.calls == []


def test_rows_without_a_date_sort_last_and_do_not_crash(transaction_search):
    rows = [
        {"transaction_id": "no-date", "description": "STEVEN", "amount": -1, "category": None},
        {"transaction_id": "null-date", "date": None, "description": "STEVEN", "amount": -1, "category": None},
        {"transaction_id": "old", "date": "2024-01-01", "description": "STEVEN", "amount": -1, "category": None},
        {"transaction_id": "new", "date": "2026-07-01", "description": "STEVEN", "amount": -1, "category": None},
    ]

    matches, truncated = transaction_search.search_transactions(rows, "steven", {}, unfiled_only=False)

    assert [row["transaction_id"] for row in matches] == ["new", "old", "no-date", "null-date"]
    assert truncated is False
