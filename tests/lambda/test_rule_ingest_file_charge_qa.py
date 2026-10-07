"""WHIT-623 slice 3 QA — reprocess's per-row shape: `load_rules(...)`, then `book.file_charges([charge], ...)`.

load_rules returns the RuleBook (WHIT-633). The reprocess suite files one charge this way; these pin
the rest of what the per-row path must still do (stamp, keep-out-of-budget, disagreement, deleted-category skip).
"""

from functools import partial

from _feed_fakes import FakeCategoryRepo
from _rule_ingest_fakes import FakeRuleStore


_Cats = partial(FakeCategoryRepo, category_ids=["groceries", "petrol"])


def _rule(value, category_id="groceries", **extra):
    return {"id": f"rule-{value}-{category_id}", "field": "description", "operator": "contains",
            "value": value, "category_id": category_id, **extra}


def _charge(txn_id="t1", description="COLES 123 RICHMOND"):
    return {"transaction_id": txn_id, "account_id": "up-spending", "description": description,
            "category": None, "counts_to_budget": True}


def _file(lam, charge, rules):
    book = lam.rule_ingest.load_rules(FakeRuleStore(rules), _Cats())
    book.file_charges([charge], None, counts_to_budget=lam.rule_ingest.counts_to_budget)
    return book


def test_per_row_filing_stamps_and_keeps_an_excluded_charge_out_of_the_budget(lam):
    # [A6] FAIL-ON-REVERT: make file_charges a no-op (or drop the book) and nothing is filed.
    charge = _charge()
    book = _file(lam, charge, [_rule("COLES", budget_excluded=True)])

    assert charge["category"] == "groceries"
    assert charge["filed_by_rule"] == "rule-COLES-groceries"
    assert charge["budget_excluded"] is True
    # The book's taxonomy check is what reprocess threads into insert_or_reconcile.
    assert book.is_unfiled("NOT_A_CATEGORY") is True and book.is_unfiled("groceries") is False


def test_per_row_filing_leaves_a_disagreed_charge_unfiled(lam):
    # [A7] Two non-nested rules to different categories -> unfiled, no stamp.
    charge = _charge(description="COLES EXPRESS FUEL")
    _file(lam, charge, [_rule("COLES", "groceries"), _rule("FUEL", "petrol")])

    assert charge["category"] is None and "filed_by_rule" not in charge


def test_per_row_filing_skips_a_rule_to_a_deleted_category(lam):
    # [A8] The only matching rule points at a category no longer in the taxonomy -> unfiled.
    # FAIL-ON-REVERT: have file_charges iterate book.rules instead of book.applicable() and the
    # charge is filed into the deleted category.
    charge = _charge()
    _file(lam, charge, [_rule("COLES", "gone_category")])

    assert charge["category"] is None and "filed_by_rule" not in charge
