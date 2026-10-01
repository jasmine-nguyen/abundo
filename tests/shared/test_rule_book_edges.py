"""WHIT-623 slice 2 QA (round 3) — RuleBook edges not pinned elsewhere: the bundle-safe import
(transitive, not just the source text), the inline "keep out of budget" stamp, reconcile not
spending the cap on rows it leaves alone, refile_touched touching only its own rule's stamps, and
the clock's exact boundary. Real repositories over FakeTable."""

import importlib
import pathlib
import subprocess
import sys
import time
from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable

ACCOUNT = "up-spending"
SHARED_DIR = pathlib.Path(__file__).resolve().parents[2] / "shared"


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


# [A15] (P0) importing rule_book pulls in no banksync, boto3 or SpreadSeeder — the source-text
# guard misses a top-level import of a module that itself imports those. (`constants` is allowed
# since WHIT-608: rule_engine reads the rule vocabulary from the one shared constants file.)
def test_importing_rule_book_is_bundle_safe_transitively():
    probe = (
        "import sys; import rule_book; "
        "print(sorted(m for m in ('banksync', 'boto3', 'rule_spreading', 'spend', "
        "'repository_transaction') if m in sys.modules))"
    )
    result = subprocess.run([sys.executable, "-c", probe], cwd=SHARED_DIR,
                            capture_output=True, text=True, check=False)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"


# [A16] (P0) an inline "file this shop" run stamps the minted id AND the inline "keep out of
# budget" flag on each row — not the whole store's flag for some other rule.
def test_inline_sweep_stamps_the_inline_keep_out_of_budget_flag(rule_book, rule_repo, repo, load):
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


# [A17] (P1) reconcile only spends the write cap on rows it actually writes: stamped charges
# already on their live rule's target cost nothing, so an orphan behind them is still undone.
def test_reconcile_does_not_spend_the_cap_on_charges_already_on_target(
        rule_book, rule_repo, repo, load):
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


# [A18] (P0) deleting one rule undoes only the charges IT filed — another rule's charges keep
# their category and stamp, and never use up the edit's write cap.
def test_refile_touched_only_touches_the_old_rules_own_charges(rule_book, rule_repo, repo):
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


# [A19] (P1) the clock boundary is inclusive: exactly `time_budget` seconds in → stop; a hair
# before → keep going (same `>=` as the old handler loops).
def test_write_limit_clock_boundary_is_inclusive(rule_book, monkeypatch):
    limit = rule_book.WriteLimit(max_writes=None, time_budget=10, started=100.0)

    monkeypatch.setattr(rule_book.time, "monotonic", lambda: 110.0)
    assert limit.reached(1) is True
    monkeypatch.setattr(rule_book.time, "monotonic", lambda: 109.999)
    assert limit.reached(1) is False


# [A20] (P1) a material edit of a MULTI-condition rule (merchant AND amount) re-evaluates on every
# condition: the owned charge that still meets both moves, the one that no longer does is cleared.
def test_material_edit_of_a_multi_condition_rule_reevaluates_all_conditions(
        rule_book, rule_repo, repo, load):
    old, _ = rule_repo.create_rule("description", "contains", "NETFLIX", "subs")
    conditions = [
        {"field": "description", "operator": "contains", "value": "NETFLIX"},
        {"field": "amount", "operator": "less_than", "value": "15"},
    ]
    edited, _ = rule_repo.create_rule("description", "contains", "NETFLIX", "streaming",
                                      conditions=conditions, logic="AND")
    still = _store_charge(repo, "t1", "NETFLIX", category="subs", filed_by_rule=old["id"])
    dropped = _store_charge(repo, "t2", "NETFLIX", category="subs", filed_by_rule=old["id"],
                            amount=Decimal("-20.00"))
    [edited_rule] = [rule for rule in load().rules if rule["id"] == edited["id"]]

    assert rule_book.RuleBook.refile_touched(old["id"], edited_rule, repo,
                                             rule_book.WriteLimit.none()) == 0

    assert repo._table.store[still]["category"] == "streaming"
    assert repo._table.store[still]["filed_by_rule"] == edited["id"]
    assert "category" not in repo._table.store[dropped]
    assert "filed_by_rule" not in repo._table.store[dropped]
