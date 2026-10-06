"""WHIT-632 QA — the handler routes that read a date window still walk every page of every
account, and still stop at the page ceiling, now that they call the shared read_window directly.

The deleted handler tests proved this for the old private wrapper only. These drive the real
routes, so swapping any one call site back to a single-page read (or an unbounded loop) reddens.
"""

import json

import pytest
from _budget_endpoint_fakes import _FakeCategoryRepo


class _EndlessRepo:
    """A date-index cursor that never runs out."""

    def __init__(self):
        self.calls = 0

    def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
        self.calls += 1
        return [{"transaction_id": f"t{self.calls}", "account_id": account_id, "date": "2026-07-01",
                 "category": None, "amount": -1}], {"cur": self.calls}


class _TwoPagesPerAccountRepo:
    """Two pages for every account: one unfiled row on each page."""

    def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
        page = 2 if cursor else 1
        row = {"transaction_id": f"{account_id}-{page}", "account_id": account_id,
               "date": "2026-07-01", "category": None, "amount": -1, "description": "shop"}
        if page == 1:
            return [row], {"cur": 1}
        return [row], None


class _RuleRepo:
    def list_rules(self):
        return []


def _routes(handler):
    # Every route whose only transaction read is the windowed one.
    return {
        "recent": lambda repo: handler.get_recent_transactions(repo),
        "uncategorized_count": lambda repo: handler.get_uncategorized_count(repo, _FakeCategoryRepo()),
        "uncategorized_merchants": lambda repo: handler.get_uncategorized_merchants(repo, _FakeCategoryRepo()),
        "filing_suggestions": lambda repo: handler.get_filing_suggestions(
            repo, _FakeCategoryRepo(), _RuleRepo()),
    }


@pytest.mark.parametrize("route", ["recent", "uncategorized_count", "uncategorized_merchants",
                                   "filing_suggestions"])
def test_a_route_stops_at_the_page_ceiling_instead_of_hanging(handler, route):
    # [A1] a never-ending cursor -> RuntimeError at exactly DATE_RANGE_MAX_PAGES, not a hang.
    import constants

    repo = _EndlessRepo()

    with pytest.raises(RuntimeError, match="did not finish"):
        _routes(handler)[route](repo)

    assert repo.calls == constants.DATE_RANGE_MAX_PAGES


def test_the_uncategorized_count_sums_every_page_of_every_account(handler):
    # [A2] two pages x every mapped account -> each row counted once.
    accounts = list(handler.ACCOUNT_ID_MAP.values())
    assert len(accounts) > 1

    response = handler.get_uncategorized_count(_TwoPagesPerAccountRepo(), _FakeCategoryRepo())

    assert json.loads(response["body"]) == {"count": 2 * len(accounts)}


def test_the_recent_feed_merges_every_page_of_every_account(handler):
    # [A3] the feed keeps rows from each account's second page, not just the first.
    accounts = list(handler.ACCOUNT_ID_MAP.values())

    result = handler.get_recent_transactions(_TwoPagesPerAccountRepo())

    assert {row["transaction_id"] for row in result} == {
        f"{account}-{page}" for account in accounts for page in (1, 2)
    }
