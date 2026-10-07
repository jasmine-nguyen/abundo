"""WHIT-623 — the server's one rule book module, shared/rule_book.py.

Slice 1: one converter (`rule_from_row`, saved rule row → the matcher's shape) and one rule-ID
calculation (`rule_engine.rule_identity`). Driven with the real RuleRepository over FakeTable, so
the rows converted are exactly what the store saves.
"""

import importlib
import sys
import time
from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable

COLES_AND_GROCERY = [
    {"field": "description", "operator": "contains", "value": "COLES"},
    {"field": "description", "operator": "contains", "value": "grocery"},
]


@pytest.fixture
def rule_book(shared):
    sys.modules.pop("rule_book", None)
    module = importlib.import_module("rule_book")
    try:
        yield module
    finally:
        sys.modules.pop("rule_book", None)


def test_every_saved_rule_field_reaches_the_matcher_including_spread_seeded(rule_book, rule_repo):
    # FAIL-ON-REVERT: dropping spread_seeded is how the old converters drifted apart.
    created, _ = rule_repo.create_rule(
        "description", "contains", "COLES", "groceries", budget_excluded=True,
        conditions=COLES_AND_GROCERY, logic="AND",
        spread=True, spread_amount=Decimal("42.50"), spread_gap_days=30,
    )
    rule_repo.mark_spread_seeded(created["id"])
    [row] = rule_repo.list_rules()

    assert rule_book.rule_from_row(row) == {
        "id": created["id"],
        "field": "description",
        "operator": "contains",
        "value": "COLES",
        "categoryId": "groceries",
        "budgetExcluded": True,
        "spread": True,
        "spreadSeeded": True,
        "spreadAmount": Decimal("42.50"),
        "spreadGapDays": 30,
        "conditions": COLES_AND_GROCERY,
        "logic": "AND",
    }


@pytest.mark.parametrize("conditions, logic", [
    (None, None),
    ([{"field": "description", "operator": "contains", "value": "COLES"}], "AND"),
    (COLES_AND_GROCERY, "AND"),
    (COLES_AND_GROCERY, "OR"),
])
def test_store_and_engine_agree_on_one_rule_id(shared, rule_repo, conditions, logic):
    import rule_engine

    expected = rule_engine.rule_identity("description", "contains", "COLES", conditions, logic)
    saved, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries",
                                     conditions=conditions, logic=logic)

    assert saved["id"] == expected
    # A 1-condition rule keeps its legacy single-condition id.
    if conditions is None or len(conditions) == 1:
        assert expected == rule_engine.rule_id_for("description", "contains", "COLES")


# --------------------------------------------------------------------------- #
# Slice 2 — the RuleBook: load once, sweep, re-file after an edit/delete.      #
# Real RuleRepository / CategoryRepository / TransactionRepository over         #
# FakeTable, so every write lands in (and is read back from) the fake store.   #
# --------------------------------------------------------------------------- #

ACCOUNT = "up-spending"


@pytest.fixture
def category_repo(shared):
    import repository_category

    repository = repository_category.CategoryRepository()
    repository._table = FakeTable()
    return repository


def _store_charge(transaction_repo, transaction_id, description, **fields):
    key = (f"ACCOUNT#{ACCOUNT}", f"TXN#{transaction_id}")
    transaction_repo._table.store[key] = {
        "pk": key[0], "sk": key[1], "transaction_id": transaction_id, "account_id": ACCOUNT,
        "date": "2026-09-01", "description": description, "amount": Decimal("-12.50"), **fields,
    }
    return key


def test_sweep_files_unfiled_charges_by_the_loaded_rule_book_and_undoes_orphan_stamps(
        rule_book, rule_repo, category_repo, repo):
    from repository_transaction import read_window

    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries",
                                    budget_excluded=True)
    unfiled = _store_charge(repo, "t1", "COLES 1234 SYDNEY")
    orphaned = _store_charge(repo, "t2", "WOOLWORTHS", category="groceries",
                             filed_by_rule="a-deleted-rule")

    book = rule_book.RuleBook.load(rule_repo, category_repo)
    transactions = read_window(repo, None, None)
    plan = book.plan(transactions)
    progress = []
    filed, vanished, failed, already_filed, matched_remaining = book.sweep(
        repo, transactions, plan, limit=rule_book.WriteLimit.none(), run_reconcile=True,
        on_progress=progress.append,
    )

    assert filed == [{"id": "t1", "category": "groceries"}]
    assert (vanished, failed, already_filed, matched_remaining) == ([], [], [], 0)
    # The winning rule's stamp and its "keep out of budget" action ride the one write.
    assert repo._table.store[unfiled]["category"] == "groceries"
    assert repo._table.store[unfiled]["filed_by_rule"] == rule["id"]
    assert repo._table.store[unfiled]["budget_excluded"] is True
    # The reconcile pass undoes a fill whose rule no longer exists.
    assert "category" not in repo._table.store[orphaned]
    assert "filed_by_rule" not in repo._table.store[orphaned]
    assert progress[-1] == {"filed": 1, "vanished": 0, "failed": 0, "alreadyFiled": 0,
                            "attempted": 2}


def test_deleting_a_rule_undoes_its_charges_within_the_write_limit_then_finishes(
        rule_book, rule_repo, category_repo, repo):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    owned = [
        _store_charge(repo, transaction_id, "COLES", category="groceries", filed_by_rule=rule["id"])
        for transaction_id in ("t1", "t2")
    ]
    hand_filed = _store_charge(repo, "t3", "COLES", category="coffee")
    book = rule_book.RuleBook.load(rule_repo, category_repo)

    capped = rule_book.WriteLimit(max_writes=1, time_budget=60, started=time.monotonic(), clock=time.monotonic)
    assert book.refile_touched(rule["id"], None, repo, capped) == 1
    assert sum("category" not in repo._table.store[key] for key in owned) == 1

    assert book.refile_touched(rule["id"], None, repo, rule_book.WriteLimit.none()) == 0
    for key in owned:
        assert "category" not in repo._table.store[key]
        assert "filed_by_rule" not in repo._table.store[key]
    assert repo._table.store[hand_filed]["category"] == "coffee"
