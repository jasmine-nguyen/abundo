"""WHIT-633 — load_rules hands back the rule book itself, not a `(book, is_unfiled)` tuple."""

from functools import partial

from _feed_fakes import FakeCategoryRepo
from _rule_ingest_fakes import FakeRuleStore


_Cats = partial(FakeCategoryRepo, category_ids=["groceries", "petrol"])


def _coles_rule():
    return {"id": "rule-coles", "field": "description", "operator": "contains",
            "value": "COLES", "category_id": "groceries", "budget_excluded": True}


def _charge():
    return {"transaction_id": "t1", "account_id": "up-spending", "description": "COLES 123 RICHMOND",
            "category": None, "counts_to_budget": True}


def test_load_rules_returns_the_rule_book_that_files_a_charge(lam):
    book = lam.rule_ingest.load_rules(FakeRuleStore([_coles_rule()]), _Cats())

    assert isinstance(book, lam.rule_ingest.RuleBook)
    assert book.is_unfiled("NOT_A_CATEGORY") is True and book.is_unfiled("groceries") is False

    charge = _charge()
    book.file_charges([charge], None, counts_to_budget=lam.rule_ingest.counts_to_budget)

    assert charge["category"] == "groceries"
    assert charge["filed_by_rule"] == "rule-coles"
    assert charge["budget_excluded"] is True
