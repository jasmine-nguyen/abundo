"""WHIT-623 slice 2 QA — the RuleBook's edges the acceptance tests don't reach: the sweep's
write outcomes (gone / tapped / raw-label-back / DB error), the clock on the sweep, the reconcile
pass sharing the cap without eating matched_remaining, deleted-category rules, spread seeding, and
refile_touched's best-effort path. Real repositories over FakeTable."""

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
def load(rule_book, rule_repo, category_repo):
    return lambda: rule_book.RuleBook.load(rule_repo, category_repo)


class RecordingSeeder:
    def __init__(self):
        self.seeded = []

    def seed(self, rule):
        self.seeded.append(rule["id"] if rule else None)


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


def _broken_for(transaction_repo, method_name, bad_sk):
    """Make one repository write raise DatabaseError for a single row; the rest hit the real repo."""
    from repository_errors import DatabaseError

    real = getattr(transaction_repo, method_name)

    def flaky(pk, sk, *args, **kwargs):
        if sk == bad_sk:
            raise DatabaseError("boom")
        return real(pk, sk, *args, **kwargs)
    setattr(transaction_repo, method_name, flaky)


# [A1] (P0) each write outcome lands in the right bucket, and one DB error doesn't stop the loop.
def test_sweep_sorts_every_write_outcome_and_survives_a_db_error(rule_book, rule_repo, repo, load):
    rule_repo.create_rule("description", "contains", "COLES", "groceries")
    ok = _store_charge(repo, "ok", "COLES")
    gone = _store_charge(repo, "gone", "COLES")
    tapped = _store_charge(repo, "tapped", "COLES")
    raw_back = _store_charge(repo, "raw", "COLES")
    broken = _store_charge(repo, "broken", "COLES")
    book = load()
    transactions, plan = _plan(book, repo)
    assert len(plan["matched"]) == 5

    # Between the scan and the write: a row ages out, the user taps one, a re-sync brings a raw label.
    del repo._table.store[gone]
    repo._table.store[tapped]["category"] = "coffee"
    repo._table.store[raw_back]["category"] = "Groceries & Food"
    _broken_for(repo, "update_transaction_category_if_unchanged", broken[1])

    filed, vanished, failed, already_filed, matched_remaining = book.sweep(
        repo, transactions, plan, limit=rule_book.WriteLimit.none(), run_reconcile=False)

    assert filed == [{"id": "ok", "category": "groceries"}]
    assert vanished == ["gone"]
    assert already_filed == ["tapped"]
    assert sorted(failed) == ["broken", "raw"]
    assert matched_remaining == 0
    assert repo._table.store[ok]["category"] == "groceries"
    assert repo._table.store[tapped]["category"] == "coffee"          # the tap wins
    assert repo._table.store[raw_back]["category"] == "Groceries & Food"


# [A2] (P0) the clock stops the sweep — but only after one write, and the rest is reported.
def test_sweep_clock_stops_after_exactly_one_write_when_already_expired(rule_book, rule_repo, repo, load):
    rule_repo.create_rule("description", "contains", "COLES", "groceries")
    for transaction_id in ("t1", "t2", "t3"):
        _store_charge(repo, transaction_id, "COLES")
    book = load()
    transactions, plan = _plan(book, repo)
    expired = rule_book.WriteLimit(max_writes=None, time_budget=1, started=time.monotonic() - 100)

    filed, _, _, _, matched_remaining = book.sweep(
        repo, transactions, plan, limit=expired, run_reconcile=True)

    assert len(filed) == 1
    assert matched_remaining == 2


# [A3] (P0) the reconcile pass shares the cap but never counts against matched_remaining.
def test_reconcile_shares_the_cap_without_eating_matched_remaining(rule_book, rule_repo, repo, load):
    rule_repo.create_rule("description", "contains", "COLES", "groceries")
    _store_charge(repo, "t1", "COLES")
    orphans = [_store_charge(repo, f"o{index}", "WOOLWORTHS", category="groceries",
                             filed_by_rule="a-deleted-rule") for index in range(3)]
    book = load()
    transactions, plan = _plan(book, repo)
    progress = []

    filed, _, _, _, matched_remaining = book.sweep(
        repo, transactions, plan, run_reconcile=True, on_progress=progress.append,
        limit=rule_book.WriteLimit(max_writes=2, time_budget=60, started=time.monotonic()))

    assert len(filed) == 1
    assert matched_remaining == 0
    assert sum("filed_by_rule" not in repo._table.store[key] for key in orphans) == 1
    assert [update["attempted"] for update in progress] == [1, 2]


# [A4] (P1) run_reconcile=False (the inline path) never touches another rule's stamps.
def test_sweep_without_reconcile_leaves_orphan_stamps(rule_book, rule_repo, repo, load):
    orphan = _store_charge(repo, "o1", "WOOLWORTHS", category="groceries",
                           filed_by_rule="a-deleted-rule")
    book = load()
    transactions, plan = _plan(book, repo)

    book.sweep(repo, transactions, plan, limit=rule_book.WriteLimit.none(), run_reconcile=False)

    assert repo._table.store[orphan]["filed_by_rule"] == "a-deleted-rule"
    assert repo._table.store[orphan]["category"] == "groceries"


# [A5] (P0) a rule whose category was deleted: not applied, but still "alive" to the reconcile,
# so the charges it already filed are neither cleared nor moved onto a dangling id.
def test_rule_to_a_deleted_category_is_skipped_but_its_stamps_survive_reconcile(
        rule_book, rule_repo, repo, load):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "deleted-cat")
    unfiled = _store_charge(repo, "t1", "COLES")
    owned = _store_charge(repo, "t2", "COLES", category="groceries", filed_by_rule=rule["id"])
    book = load()
    assert book.applicable() == []
    assert book.target_by_id == {rule["id"]: "deleted-cat"}
    transactions, plan = _plan(book, repo)

    filed, *_ = book.sweep(repo, transactions, plan, limit=rule_book.WriteLimit.none(),
                           run_reconcile=True)

    assert filed == []
    assert "category" not in repo._table.store[unfiled]
    assert repo._table.store[owned]["category"] == "groceries"
    assert repo._table.store[owned]["filed_by_rule"] == rule["id"]


# [A6] (P1) the plain sweep hands the winning spread rule to the seeder; the inline path never does.
def test_sweep_seeds_the_winning_spread_rule_but_not_on_the_inline_path(
        rule_book, rule_repo, repo, load):
    spread, _ = rule_repo.create_rule("description", "contains", "NETFLIX", "subs", spread=True,
                                      spread_amount=Decimal("20"), spread_gap_days=30)
    _store_charge(repo, "t1", "NETFLIX")
    book = load()
    transactions, plan = _plan(book, repo)
    seeder = RecordingSeeder()
    book.sweep(repo, transactions, plan, limit=rule_book.WriteLimit.none(), run_reconcile=False,
               seeder=seeder)
    assert seeder.seeded == [spread["id"]]

    _store_charge(repo, "t2", "COLES")
    narrowed = load().only({"value": "COLES", "categoryId": "groceries"},
                           field="description", operator="contains")
    transactions, plan = _plan(narrowed, repo)
    inline_seeder = RecordingSeeder()
    narrowed.sweep(repo, transactions, plan, limit=rule_book.WriteLimit.none(),
                   inline_stamp="minted", run_reconcile=False, seeder=inline_seeder)
    assert inline_seeder.seeded in ([], [None])


# [A7] (P1) only() returns a narrowed copy — the original book still holds every rule.
def test_only_does_not_narrow_the_original_book(rule_repo, load):
    rule_repo.create_rule("description", "contains", "WOOLWORTHS", "groceries")
    book = load()

    narrowed = book.only({"value": "COLES", "categoryId": "groceries"},
                         field="description", operator="contains")

    assert [rule["value"] for rule in book.rules] == ["WOOLWORTHS"]
    assert [rule["value"] for rule in narrowed.rules] == ["COLES"]
    assert narrowed.rules[0]["id"] is None


# [A8] (P0) file_charges: deleted-category rule skipped, income left alone, counts_to_budget gets
# (account_id, category), an empty store is a no-op.
def test_file_charges_skips_deleted_category_rules_and_income(rule_repo, load):
    rule_repo.create_rule("description", "contains", "COLES", "deleted-cat")
    rule_repo.create_rule("description", "contains", "PAYROLL", "groceries")
    calls = []

    def counts_to_budget(account_id, category):
        calls.append((account_id, category))
        return True

    dangling = {"transaction_id": "t1", "account_id": ACCOUNT, "description": "COLES",
                "amount": Decimal("-5")}
    income = {"transaction_id": "t2", "account_id": ACCOUNT, "description": "PAYROLL",
              "amount": Decimal("500"), "category": "income"}
    raw = {"transaction_id": "t3", "account_id": ACCOUNT, "description": "PAYROLL",
           "amount": Decimal("-5"), "category": "Bank Raw Label"}

    load().file_charges([dangling, income, raw], counts_to_budget=counts_to_budget)

    assert "category" not in dangling
    assert income["category"] == "income"
    assert raw["category"] == "groceries"          # a raw bank label counts as unfiled
    assert calls == [(ACCOUNT, "groceries")]


def test_file_charges_with_no_rules_never_calls_counts_to_budget(load):
    charge = {"transaction_id": "t1", "account_id": ACCOUNT, "description": "COLES",
              "amount": Decimal("-5")}

    load().file_charges([charge], counts_to_budget=lambda *_: pytest.fail("called"))

    assert "category" not in charge


# [A9] (P1) refile_touched is best-effort: one failing row is skipped, the rest still undone.
def test_refile_touched_skips_a_failing_row_and_finishes_the_rest(rule_book, rule_repo, repo):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    bad = _store_charge(repo, "t1", "COLES", category="groceries", filed_by_rule=rule["id"])
    good = _store_charge(repo, "t2", "COLES", category="groceries", filed_by_rule=rule["id"])
    _broken_for(repo, "clear_rule_fill", bad[1])

    remaining = rule_book.RuleBook.refile_touched(rule["id"], None, repo, rule_book.WriteLimit.none())

    assert remaining == 0
    assert repo._table.store[bad]["filed_by_rule"] == rule["id"]
    assert "filed_by_rule" not in repo._table.store[good]


# [A10] (P1) refile_touched honours the clock too — one write, then the rest is reported.
def test_refile_touched_clock_stops_after_one_write(rule_book, rule_repo, repo):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    for transaction_id in ("t1", "t2", "t3"):
        _store_charge(repo, transaction_id, "COLES", category="groceries", filed_by_rule=rule["id"])
    expired = rule_book.WriteLimit(max_writes=None, time_budget=1, started=time.monotonic() - 100)

    assert rule_book.RuleBook.refile_touched(rule["id"], None, repo, expired) == 2


# [A11] (P1) a taxonomy read failure raises too (the webhook's fallback depends on it).
def test_load_raises_when_the_taxonomy_read_fails(rule_book, rule_repo, category_repo):
    from repository_errors import DatabaseError

    def broken():
        raise DatabaseError("boom")
    category_repo.list_categories = broken

    with pytest.raises(DatabaseError):
        rule_book.RuleBook.load(rule_repo, category_repo)


# [A12] (P1) is_unfiled follows the loaded taxonomy: income and live ids are filed.
def test_is_unfiled_follows_the_loaded_taxonomy(load):
    book = load()
    assert book.is_unfiled(None) is True
    assert book.is_unfiled("Bank Raw Label") is True
    assert book.is_unfiled("income") is False
    assert book.is_unfiled("groceries") is False


# [A13] (P0) book.plan wraps plan_rule_application with the book's own rules and taxonomy, so a
# caller goes load → plan → sweep without importing rule_engine.
def test_book_plan_is_the_engine_plan_for_the_books_rules_and_taxonomy(rule_repo, repo, load):
    import rule_engine
    from repository_transaction import read_window

    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    rule_repo.create_rule("description", "contains", "EXPRESS", "transport")
    _store_charge(repo, "t1", "COLES")
    _store_charge(repo, "t2", "COLES EXPRESS")
    _store_charge(repo, "t3", "COLES", category="Bank Raw Label")
    _store_charge(repo, "t4", "COLES", category="coffee")
    book = load()
    transactions = read_window(repo, None, None)

    plan = book.plan(transactions)

    assert plan == rule_engine.plan_rule_application(book.rules, transactions, book.is_unfiled)
    assert sorted((row["transaction_id"], category, rule_id)
                  for row, category, rule_id in plan["matched"]) == [
        ("t1", "groceries", rule["id"]), ("t3", "groceries", rule["id"])]
    assert plan["conflicted"] == 1


# [A14] (P1) a narrowed book plans with only the inline rule (rule_id None; the sweep stamps it).
def test_narrowed_book_plans_only_the_inline_rule(rule_repo, repo, load):
    from repository_transaction import read_window

    rule_repo.create_rule("description", "contains", "WOOLWORTHS", "groceries")
    _store_charge(repo, "t1", "COLES")
    _store_charge(repo, "t2", "WOOLWORTHS")

    narrowed = load().only({"value": "COLES", "categoryId": "groceries"},
                           field="description", operator="contains")
    plan = narrowed.plan(read_window(repo, None, None))

    assert [(row["transaction_id"], category, rule_id)
            for row, category, rule_id in plan["matched"]] == [("t1", "groceries", None)]
