"""WHIT-632 QA — the handler routes that read a date window stop at the page ceiling, now that
they call the shared read_window directly. These drive the real routes, so swapping any one call
site back to an unbounded loop reddens.
"""

import pytest
from _budget_endpoint_fakes import _FakeCategoryRepo
from _rule_ingest_fakes import FakeRuleStore
from _transaction_range_fakes import _EndlessTransactionRepo


def _unfiled_row(account_id, transaction_id):
    return {"transaction_id": transaction_id, "account_id": account_id, "date": "2026-07-01",
            "category": None, "amount": -1, "description": "shop"}


def _routes(handler):
    # Every route whose only transaction read is the windowed one.
    return {
        "recent": lambda repo: handler.get_recent_transactions(repo),
        "uncategorized_count": lambda repo: handler.get_uncategorized_count(repo, _FakeCategoryRepo()),
        "uncategorized_merchants": lambda repo: handler.get_uncategorized_merchants(repo, _FakeCategoryRepo()),
        "filing_suggestions": lambda repo: handler.get_filing_suggestions(
            repo, _FakeCategoryRepo(), FakeRuleStore()),
    }


@pytest.mark.parametrize("route", ["recent", "uncategorized_count", "uncategorized_merchants",
                                   "filing_suggestions"])
def test_a_route_stops_at_the_page_ceiling_instead_of_hanging(handler, route):
    # [A1] a never-ending cursor -> RuntimeError at exactly DATE_RANGE_MAX_PAGES, not a hang.
    import constants

    repo = _EndlessTransactionRepo(page=[_unfiled_row("up-spending", "t1")])

    with pytest.raises(RuntimeError, match="did not finish"):
        _routes(handler)[route](repo)

    assert len(repo.calls) == constants.DATE_RANGE_MAX_PAGES
