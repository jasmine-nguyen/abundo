"""WHIT-633 QA — reprocess and apply() now hold the RuleBook directly (no tuple, no splat)."""

from functools import partial

from _deadletter_fakes import _failed_keys, _txn_rows
from _feed_fakes import FakeCategoryRepo
from _rule_ingest_fakes import KKV_RULE, FakeRuleStore, apply_rules

_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _raw_row(txn_id):
    return {
        "id": txn_id, "date": "2026-06-29", "authorizedDate": "2026-06-29",
        "description": "SQ *KKV INTERNATIONAL PTY", "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": -5.50, "accountId": _MAPPED_ACCOUNT, "accountName": "ANZ Rewards Black Visa",
        "category": "FOOD_AND_DRINK", "pending": False, "type": "PAYMENT",
        "pendingTransactionId": None,
    }


_Cats = partial(FakeCategoryRepo, category_ids=["groceries"])


def test_reprocess_with_an_unreadable_rule_book_still_recovers_every_row_unfiled(lam, repo):
    # [A1] load_rules returns None on a read failure; reprocess must not touch book.is_unfiled
    # or file its charges then. FAIL-ON-REVERT: drop the `if book is not None` guard on is_unfiled
    # (or on the filing) and the sweep crashes with AttributeError on None.
    repo.save_failed_transactions([_raw_row("r1"), _raw_row("r2")])

    summary = lam.reprocess.reprocess_failed(
        repo, rule_repo=FakeRuleStore(error=True), category_repo=_Cats())

    assert summary == {"reprocessed": 2, "skipped": 0, "errors": 0, "dropped_zero": 0}
    rows = _txn_rows(repo)
    assert rows["TXN#r1"]["category"] == "FOOD_AND_DRINK"
    assert rows["TXN#r2"]["category"] == "FOOD_AND_DRINK"
    assert _failed_keys(repo) == []


def test_apply_files_in_place_and_returns_the_books_taxonomy_check(lam):
    # [A2] apply()'s is_unfiled is what handler.py threads into insert_or_reconcile.
    # FAIL-ON-REVERT: return `book` (or None) instead of book.is_unfiled and the check is lost.
    charge = {"transaction_id": "t1", "account_id": "up-spending",
              "description": "SQ *KKV INTERNATIONAL PTY", "category": None, "counts_to_budget": True}

    is_unfiled = apply_rules(lam.rule_ingest, [charge], rule_repo=FakeRuleStore([KKV_RULE]), category_repo=_Cats())

    assert charge["category"] == "groceries"
    assert is_unfiled("FOOD_AND_DRINK") is True
    assert is_unfiled("groceries") is False


def test_apply_with_an_unreadable_rule_book_returns_no_taxonomy_check(lam):
    # [A3] FAIL-ON-REVERT: drop the `if book is None` early return and apply crashes on None.
    charge = {"transaction_id": "t1", "account_id": "up-spending",
              "description": "SQ *KKV INTERNATIONAL PTY", "category": None, "counts_to_budget": True}

    is_unfiled = apply_rules(lam.rule_ingest, [charge], rule_repo=FakeRuleStore(error=True), category_repo=_Cats())

    assert charge["category"] is None
    assert is_unfiled is None
