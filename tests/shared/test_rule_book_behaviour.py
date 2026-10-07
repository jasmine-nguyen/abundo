"""WHIT-623 slice 2 — the RuleBook's other behaviours, over real repositories on FakeTable:
the write limit, the inline narrowing, re-file after an edit, and filing incoming charges."""

import importlib
import sys
import time
from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable

ACCOUNT = "up-spending"


@pytest.fixture
def rule_book(shared):
    sys.modules.pop("rule_book", None)
    module = importlib.import_module("rule_book")
    try:
        yield module
    finally:
        sys.modules.pop("rule_book", None)


@pytest.fixture
def category_repo(shared):
    import repository_category

    repository = repository_category.CategoryRepository()
    repository._table = FakeTable()
    return repository


@pytest.fixture
def book(rule_book, rule_repo, category_repo):
    def load():
        return rule_book.RuleBook.load(rule_repo, category_repo)
    return load


class RecordingSeeder:
    def __init__(self):
        self.seeded = []

    def seed(self, rule):
        if rule:
            self.seeded.append(rule["id"])


def _store_charge(transaction_repo, transaction_id, description, **fields):
    key = (f"ACCOUNT#{ACCOUNT}", f"TXN#{transaction_id}")
    transaction_repo._table.store[key] = {
        "pk": key[0], "sk": key[1], "transaction_id": transaction_id, "account_id": ACCOUNT,
        "date": "2026-09-01", "description": description, "amount": Decimal("-12.50"), **fields,
    }
    return key


def _plan(book, transaction_repo):
    from repository_transaction import read_window

    transactions = read_window(transaction_repo, None, None)
    return transactions, book.plan(transactions)


def test_write_limit_stops_at_the_cap_and_after_the_clock_but_never_before_one_write(rule_book):
    capped = rule_book.WriteLimit(max_writes=2, time_budget=60, started=time.monotonic(), clock=time.monotonic)
    assert [capped.reached(attempted) for attempted in (0, 1, 2)] == [False, False, True]

    expired = rule_book.WriteLimit(max_writes=None, time_budget=1, started=time.monotonic() - 100, clock=time.monotonic)
    assert expired.reached(0) is False
    assert expired.reached(1) is True

    assert rule_book.WriteLimit.none().reached(10_000) is False


def test_sweep_stops_at_the_write_cap_and_reports_the_unreached(rule_book, rule_repo, repo, book):
    rule_repo.create_rule("description", "contains", "COLES", "groceries")
    for transaction_id in ("t1", "t2", "t3"):
        _store_charge(repo, transaction_id, "COLES")
    loaded = book()
    transactions, plan = _plan(loaded, repo)

    filed, _, _, _, matched_remaining = loaded.sweep(
        repo, transactions, plan, run_reconcile=True,
        limit=rule_book.WriteLimit(max_writes=2, time_budget=60, started=time.monotonic(), clock=time.monotonic))

    assert len(filed) == 2
    assert matched_remaining == 1


def test_sweep_moves_a_drifted_charge_back_onto_its_live_rules_target(rule_book, rule_repo, repo, book):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    drifted = _store_charge(repo, "t1", "COLES", category="transport", filed_by_rule=rule["id"])
    loaded = book()
    transactions, plan = _plan(loaded, repo)

    loaded.sweep(repo, transactions, plan, limit=rule_book.WriteLimit.none(), run_reconcile=True)

    assert repo._table.store[drifted]["category"] == "groceries"
    assert repo._table.store[drifted]["filed_by_rule"] == rule["id"]


def test_only_files_just_the_inline_shop_but_keeps_whole_store_lookups(
        rule_book, rule_repo, repo, book):
    woolworths, _ = rule_repo.create_rule("description", "contains", "WOOLWORTHS", "groceries",
                                          budget_excluded=True)
    coles = _store_charge(repo, "t1", "COLES")
    woolies = _store_charge(repo, "t2", "WOOLWORTHS")
    inline = {"value": "COLES", "categoryId": "groceries", "budgetExcluded": False}

    narrowed = book().only(inline, field="description", operator="contains")
    transactions, plan = _plan(narrowed, repo)
    filed, *_ = narrowed.sweep(repo, transactions, plan, limit=rule_book.WriteLimit.none(),
                               inline_stamp="minted-id", run_reconcile=False)

    assert filed == [{"id": "t1", "category": "groceries"}]
    assert repo._table.store[coles]["filed_by_rule"] == "minted-id"
    assert "category" not in repo._table.store[woolies]
    assert narrowed.target_by_id == {woolworths["id"]: "groceries"}
    assert narrowed.excluded_by_id == {woolworths["id"]: True}


def test_a_material_edit_refiles_what_still_matches_and_clears_the_rest(
        rule_book, rule_repo, repo, book):
    old, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    express = _store_charge(repo, "t1", "COLES EXPRESS", category="groceries", filed_by_rule=old["id"])
    plain = _store_charge(repo, "t2", "COLES", category="groceries", filed_by_rule=old["id"])
    edited, _ = rule_repo.create_rule("description", "contains", "COLES EXPRESS", "transport")
    [edited_rule] = [rule for rule in book().rules if rule["id"] == edited["id"]]

    remaining = rule_book.RuleBook.refile_touched(old["id"], edited_rule, repo,
                                                  rule_book.WriteLimit.none())

    assert remaining == 0
    assert repo._table.store[express]["category"] == "transport"
    assert repo._table.store[express]["filed_by_rule"] == edited["id"]
    assert "category" not in repo._table.store[plain]


@pytest.mark.parametrize("field, operator, value, moves_id", [
    ("description", "contains", "COLES", False),   # in place: the id is unchanged
    ("category", "equals", "coffee", True),        # filing overwrote the category it matched on
])
def test_an_in_place_or_category_rule_edit_refiles_every_owned_charge_blind(
        rule_book, rule_repo, repo, book, field, operator, value, moves_id):
    rule, _ = rule_repo.create_rule(field, operator, value, "groceries")
    owned = _store_charge(repo, "t1", "WOOLWORTHS", category="groceries", filed_by_rule=rule["id"])
    [edited_rule] = book().rules
    edited_rule = {**edited_rule, "categoryId": "shopping"}
    if moves_id:
        edited_rule["id"] = "edited-rule-id"

    assert book().refile_touched(rule["id"], edited_rule, repo, rule_book.WriteLimit.none()) == 0

    assert repo._table.store[owned]["category"] == "shopping"
    assert repo._table.store[owned]["filed_by_rule"] == edited_rule["id"]


def _counts_to_budget(account_id, category):
    return category != "savings"


def test_file_charges_files_an_agreed_charge_with_its_rules_actions(rule_book, rule_repo, book):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries",
                                    budget_excluded=True, spread=True,
                                    spread_amount=Decimal("40"), spread_gap_days=30)
    first = {"transaction_id": "t1", "account_id": ACCOUNT, "description": "COLES 1",
             "amount": Decimal("-5")}
    second = {**first, "transaction_id": "t2"}
    seeder = RecordingSeeder()

    book().file_charges([first, second], seeder, counts_to_budget=_counts_to_budget)

    assert first["category"] == "groceries"
    assert first["filed_by_rule"] == rule["id"]
    assert first["budget_excluded"] is True
    assert first["counts_to_budget"] is True
    assert seeder.seeded == [rule["id"], rule["id"]]


def test_file_charges_leaves_a_charge_unfiled_when_rules_disagree(rule_repo, book):
    rule_repo.create_rule("description", "contains", "COLES", "groceries")
    rule_repo.create_rule("description", "contains", "EXPRESS", "transport")
    charge = {"transaction_id": "t1", "account_id": ACCOUNT, "description": "COLES EXPRESS",
              "amount": Decimal("-5")}

    book().file_charges([charge], counts_to_budget=_counts_to_budget)

    assert "category" not in charge
    assert "filed_by_rule" not in charge


def test_file_charges_leaves_an_already_filed_charge_alone(rule_repo, book):
    rule_repo.create_rule("description", "contains", "COLES", "groceries")
    charge = {"transaction_id": "t1", "account_id": ACCOUNT, "description": "COLES",
              "amount": Decimal("-5"), "category": "shopping"}

    book().file_charges([charge], counts_to_budget=_counts_to_budget)

    assert charge["category"] == "shopping"
    assert "filed_by_rule" not in charge


def test_load_failure_raises_for_the_caller_to_handle(rule_book, rule_repo, category_repo):
    from repository_errors import DatabaseError

    def broken():
        raise DatabaseError("boom")
    rule_repo.list_rules = broken

    with pytest.raises(DatabaseError):
        rule_book.RuleBook.load(rule_repo, category_repo)
