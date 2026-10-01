"""WHIT-633 — load_rules hands back the rule book itself, and file_charge takes just (charge, book).

No more `(book, is_unfiled)` tuple and no unused placeholder argument on file_charge.
"""

import pytest


class _Store:
    def __init__(self, rules):
        self._rules = [dict(rule) for rule in rules]

    def list_rules(self):
        return [dict(rule) for rule in self._rules]


class _Cats:
    def list_categories(self):
        return [{"id": "groceries"}, {"id": "petrol"}]


def _coles_rule():
    return {"id": "rule-coles", "field": "description", "operator": "contains",
            "value": "COLES", "category_id": "groceries", "budget_excluded": True}


def _charge():
    return {"transaction_id": "t1", "account_id": "up-spending", "description": "COLES 123 RICHMOND",
            "category": None, "counts_to_budget": True}


def test_load_rules_returns_the_rule_book_that_files_a_charge(lam):
    book = lam.rule_ingest.load_rules(_Store([_coles_rule()]), _Cats())

    assert isinstance(book, lam.rule_ingest.RuleBook)
    assert book.is_unfiled("NOT_A_CATEGORY") is True and book.is_unfiled("groceries") is False

    charge = _charge()
    lam.rule_ingest.file_charge(charge, book)

    assert charge["category"] == "groceries"
    assert charge["filed_by_rule"] == "rule-coles"
    assert charge["budget_excluded"] is True


def test_file_charge_has_no_placeholder_argument(lam):
    book = lam.rule_ingest.RuleBook.load(_Store([_coles_rule()]), _Cats())

    with pytest.raises(TypeError):
        lam.rule_ingest.file_charge(_charge(), book, book.is_unfiled)
