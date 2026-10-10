"""WHIT-623 — the server's one rule book module, shared/rule_book.py.

One converter (`rule_from_row`, saved rule row → the matcher's shape), one rule-ID calculation
(`rule_engine.rule_identity`), and the RuleBook: load once, sweep, re-file after an edit/delete,
and file incoming charges. Driven with the real Rule/Category/TransactionRepository over FakeTable,
so every write lands in (and is read back from) the fake store.
"""

import importlib
import pathlib
import subprocess
import sys
import time
from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable

SHARED_DIR = pathlib.Path(__file__).resolve().parents[2] / "shared"
ACCOUNT = "up-spending"
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


def _broken_for(transaction_repo, method_name, bad_sk):
    """Make one repository write raise DatabaseError for a single row; the rest hit the real repo."""
    from repository_errors import DatabaseError

    real = getattr(transaction_repo, method_name)

    def flaky(pk, sk, *args, **kwargs):
        if sk == bad_sk:
            raise DatabaseError("boom")
        return real(pk, sk, *args, **kwargs)
    setattr(transaction_repo, method_name, flaky)


def _counts_to_budget(account_id, category):
    return category != "savings"


# --- the converter and the one rule id ---------------------------------------------------------


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


@pytest.mark.parametrize("conditions, logic", [
    (None, None),
    (COLES_AND_GROCERY, "all"),
])
def test_update_moves_to_the_same_id_in_the_store_and_the_engine(
        shared, rule_repo, conditions, logic):
    # Edit a WOOLWORTHS rule to the given identity; the moved row's id must agree everywhere.
    import rule_engine

    expected = rule_engine.rule_identity("description", "contains", "COLES", conditions, logic)
    saved, _ = rule_repo.create_rule("description", "contains", "WOOLWORTHS", "groceries")

    moved = rule_repo.update_rule(saved["id"], "description", "contains", "COLES", "groceries",
                                  conditions=conditions, logic=logic)

    assert moved["id"] == expected
    assert [row["id"] for row in rule_repo.list_rules()] == [expected]


def test_importing_rule_book_is_bundle_safe_transitively():
    # Importing rule_book pulls in no banksync, boto3 or SpreadSeeder — a source-text guard misses
    # a top-level import of a module that itself imports those. (`constants` is allowed since
    # WHIT-608: rule_engine reads the rule vocabulary from the one shared constants file.)
    probe = (
        "import sys; import rule_book; "
        "print(sorted(m for m in ('banksync', 'boto3', 'rule_spreading', 'spend', "
        "'repository_transaction') if m in sys.modules))"
    )
    result = subprocess.run([sys.executable, "-c", probe], cwd=SHARED_DIR,
                            capture_output=True, text=True, check=False)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"


def test_load_failure_raises_for_the_caller_to_handle(rule_book, rule_repo, category_repo):
    from repository_errors import DatabaseError

    def broken():
        raise DatabaseError("boom")
    rule_repo.list_rules = broken

    with pytest.raises(DatabaseError):
        rule_book.RuleBook.load(rule_repo, category_repo)


# --- the sweep and its write limit -------------------------------------------------------------


def test_write_limit_stops_at_the_cap_and_after_the_clock_but_never_before_one_write(rule_book):
    capped = rule_book.WriteLimit(max_writes=2, time_budget=60, started=time.monotonic())
    assert [capped.reached(attempted) for attempted in (0, 1, 2)] == [False, False, True]

    expired = rule_book.WriteLimit(max_writes=None, time_budget=1, started=time.monotonic() - 100)
    assert expired.reached(0) is False
    assert expired.reached(1) is True

    assert rule_book.WriteLimit.none().reached(10_000) is False


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


def test_sweep_stops_at_the_write_cap_and_reports_the_unreached(rule_book, rule_repo, repo, load):
    rule_repo.create_rule("description", "contains", "COLES", "groceries")
    for transaction_id in ("t1", "t2", "t3"):
        _store_charge(repo, transaction_id, "COLES")
    loaded = load()
    transactions, plan = _plan(loaded, repo)

    filed, _, _, _, matched_remaining = loaded.sweep(
        repo, transactions, plan, run_reconcile=True,
        limit=rule_book.WriteLimit(max_writes=2, time_budget=60, started=time.monotonic()))

    assert len(filed) == 2
    assert matched_remaining == 1


def test_reconcile_does_not_spend_the_cap_on_charges_already_on_target(rule_book, rule_repo, repo, load):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    # History reads newest first: the on-target charges come before the older orphan.
    for transaction_id in ("a1", "a2", "a3"):
        _store_charge(repo, transaction_id, "COLES", category="groceries", filed_by_rule=rule["id"],
                      date="2026-09-05")
    orphan = _store_charge(repo, "z9", "WOOLWORTHS", category="groceries",
                           filed_by_rule="a-deleted-rule", date="2026-08-01")
    book = load()
    transactions, plan = _plan(book, repo)
    assert plan["matched"] == []

    book.sweep(repo, transactions, plan, run_reconcile=True,
               limit=rule_book.WriteLimit(max_writes=1, time_budget=60, started=time.monotonic()))

    assert "filed_by_rule" not in repo._table.store[orphan]
    assert "category" not in repo._table.store[orphan]


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


def test_sweep_moves_a_drifted_charge_back_onto_its_live_rules_target(rule_book, rule_repo, repo, load):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    drifted = _store_charge(repo, "t1", "COLES", category="transport", filed_by_rule=rule["id"])
    loaded = load()
    transactions, plan = _plan(loaded, repo)

    loaded.sweep(repo, transactions, plan, limit=rule_book.WriteLimit.none(), run_reconcile=True)

    assert repo._table.store[drifted]["category"] == "groceries"
    assert repo._table.store[drifted]["filed_by_rule"] == rule["id"]


def test_rule_to_a_deleted_category_is_skipped_but_its_stamps_survive_reconcile(
        rule_book, rule_repo, repo, load):
    # Not applied, but still "alive" to the reconcile, so the charges it already filed are neither
    # cleared nor moved onto a dangling id.
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
    assert inline_seeder.seeded == []


# --- the inline "file this shop" narrowing -----------------------------------------------------


def test_only_files_just_the_inline_shop_but_keeps_whole_store_lookups(
        rule_book, rule_repo, repo, load):
    woolworths, _ = rule_repo.create_rule("description", "contains", "WOOLWORTHS", "groceries",
                                          budget_excluded=True)
    coles = _store_charge(repo, "t1", "COLES")
    woolies = _store_charge(repo, "t2", "WOOLWORTHS")
    inline = {"value": "COLES", "categoryId": "groceries", "budgetExcluded": False}

    narrowed = load().only(inline, field="description", operator="contains")
    transactions, plan = _plan(narrowed, repo)
    filed, *_ = narrowed.sweep(repo, transactions, plan, limit=rule_book.WriteLimit.none(),
                               inline_stamp="minted-id", run_reconcile=False)

    assert filed == [{"id": "t1", "category": "groceries"}]
    assert repo._table.store[coles]["filed_by_rule"] == "minted-id"
    assert "category" not in repo._table.store[woolies]
    assert narrowed.target_by_id == {woolworths["id"]: "groceries"}
    assert narrowed.excluded_by_id == {woolworths["id"]: True}


def test_inline_sweep_stamps_the_inline_keep_out_of_budget_flag(rule_book, rule_repo, repo, load):
    # An inline run stamps the minted id AND the inline "keep out of budget" flag on each row —
    # not the whole store's flag for some other rule.
    rule_repo.create_rule("description", "contains", "WOOLWORTHS", "groceries")
    coles = _store_charge(repo, "t1", "COLES")
    narrowed = load().only({"value": "COLES", "categoryId": "groceries"},
                           field="description", operator="contains")
    transactions, plan = _plan(narrowed, repo)

    filed, *_ = narrowed.sweep(repo, transactions, plan, limit=rule_book.WriteLimit.none(),
                               inline_stamp="minted-id", inline_excluded=True,
                               run_reconcile=False)

    assert filed == [{"id": "t1", "category": "groceries"}]
    assert repo._table.store[coles]["filed_by_rule"] == "minted-id"
    assert repo._table.store[coles]["budget_excluded"] is True


# --- re-file after an edit or delete -----------------------------------------------------------


def test_deleting_a_rule_undoes_its_charges_within_the_write_limit_then_finishes(
        rule_book, rule_repo, category_repo, repo):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    owned = [
        _store_charge(repo, transaction_id, "COLES", category="groceries", filed_by_rule=rule["id"])
        for transaction_id in ("t1", "t2")
    ]
    hand_filed = _store_charge(repo, "t3", "COLES", category="coffee")
    book = rule_book.RuleBook.load(rule_repo, category_repo)

    capped = rule_book.WriteLimit(max_writes=1, time_budget=60, started=time.monotonic())
    assert book.refile_touched(rule["id"], None, repo, capped) == 1
    assert sum("category" not in repo._table.store[key] for key in owned) == 1

    assert book.refile_touched(rule["id"], None, repo, rule_book.WriteLimit.none()) == 0
    for key in owned:
        assert "category" not in repo._table.store[key]
        assert "filed_by_rule" not in repo._table.store[key]
    assert repo._table.store[hand_filed]["category"] == "coffee"


def test_a_material_edit_refiles_what_still_matches_and_clears_the_rest(
        rule_book, rule_repo, repo, load):
    old, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    express = _store_charge(repo, "t1", "COLES EXPRESS", category="groceries", filed_by_rule=old["id"])
    plain = _store_charge(repo, "t2", "COLES", category="groceries", filed_by_rule=old["id"])
    edited, _ = rule_repo.create_rule("description", "contains", "COLES EXPRESS", "transport")
    [edited_rule] = [rule for rule in load().rules if rule["id"] == edited["id"]]

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
        rule_book, rule_repo, repo, load, field, operator, value, moves_id):
    rule, _ = rule_repo.create_rule(field, operator, value, "groceries")
    owned = _store_charge(repo, "t1", "WOOLWORTHS", category="groceries", filed_by_rule=rule["id"])
    [edited_rule] = load().rules
    edited_rule = {**edited_rule, "categoryId": "shopping"}
    if moves_id:
        edited_rule["id"] = "edited-rule-id"

    assert load().refile_touched(rule["id"], edited_rule, repo, rule_book.WriteLimit.none()) == 0

    assert repo._table.store[owned]["category"] == "shopping"
    assert repo._table.store[owned]["filed_by_rule"] == edited_rule["id"]


def test_refile_touched_only_touches_the_old_rules_own_charges(rule_book, rule_repo, repo):
    # Deleting one rule undoes only the charges IT filed — another rule's charges keep their
    # category and stamp, and never use up the edit's write cap.
    deleted, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    kept, _ = rule_repo.create_rule("description", "contains", "UBER", "transport")
    # History reads newest first: the other rule's charge comes before this rule's one.
    mine = _store_charge(repo, "t1", "COLES", category="groceries", filed_by_rule=deleted["id"],
                         date="2026-08-01")
    theirs = _store_charge(repo, "t2", "UBER", category="transport", filed_by_rule=kept["id"],
                           date="2026-09-05")
    one_write = rule_book.WriteLimit(max_writes=1, time_budget=60, started=time.monotonic())

    remaining = rule_book.RuleBook.refile_touched(deleted["id"], None, repo, one_write)

    assert remaining == 0
    assert "filed_by_rule" not in repo._table.store[mine]
    assert repo._table.store[theirs]["category"] == "transport"
    assert repo._table.store[theirs]["filed_by_rule"] == kept["id"]


def test_refile_touched_skips_a_failing_row_and_finishes_the_rest(rule_book, rule_repo, repo):
    # Best-effort: one failing row is skipped, the rest are still undone.
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries")
    bad = _store_charge(repo, "t1", "COLES", category="groceries", filed_by_rule=rule["id"])
    good = _store_charge(repo, "t2", "COLES", category="groceries", filed_by_rule=rule["id"])
    _broken_for(repo, "clear_rule_fill", bad[1])

    remaining = rule_book.RuleBook.refile_touched(rule["id"], None, repo, rule_book.WriteLimit.none())

    assert remaining == 0
    assert repo._table.store[bad]["filed_by_rule"] == rule["id"]
    assert "filed_by_rule" not in repo._table.store[good]


# --- filing incoming charges -------------------------------------------------------------------


def test_file_charges_files_an_agreed_charge_with_its_rules_actions(rule_book, rule_repo, load):
    rule, _ = rule_repo.create_rule("description", "contains", "COLES", "groceries",
                                    budget_excluded=True, spread=True,
                                    spread_amount=Decimal("40"), spread_gap_days=30)
    first = {"transaction_id": "t1", "account_id": ACCOUNT, "description": "COLES 1",
             "amount": Decimal("-5")}
    second = {**first, "transaction_id": "t2"}
    seeder = RecordingSeeder()

    load().file_charges([first, second], seeder, counts_to_budget=_counts_to_budget)

    assert first["category"] == "groceries"
    assert first["filed_by_rule"] == rule["id"]
    assert first["budget_excluded"] is True
    assert first["counts_to_budget"] is True
    assert seeder.seeded == [rule["id"], rule["id"]]


def test_file_charges_leaves_a_charge_unfiled_when_rules_disagree(rule_repo, load):
    rule_repo.create_rule("description", "contains", "COLES", "groceries")
    rule_repo.create_rule("description", "contains", "EXPRESS", "transport")
    charge = {"transaction_id": "t1", "account_id": ACCOUNT, "description": "COLES EXPRESS",
              "amount": Decimal("-5")}

    load().file_charges([charge], counts_to_budget=_counts_to_budget)

    assert "category" not in charge
    assert "filed_by_rule" not in charge


def test_file_charges_leaves_an_already_filed_charge_alone(rule_repo, load):
    rule_repo.create_rule("description", "contains", "COLES", "groceries")
    charge = {"transaction_id": "t1", "account_id": ACCOUNT, "description": "COLES",
              "amount": Decimal("-5"), "category": "shopping"}

    load().file_charges([charge], counts_to_budget=_counts_to_budget)

    assert charge["category"] == "shopping"
    assert "filed_by_rule" not in charge


def test_file_charges_skips_deleted_category_rules_and_income(rule_repo, load):
    # A deleted-category rule is skipped, income is left alone, and counts_to_budget gets
    # (account_id, category).
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
