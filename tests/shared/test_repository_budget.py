"""Unit tests for BudgetRepository.delete_budget (WHIT-73): the cascade run when a
category is deleted, so a stale target can't linger and silently reappear if a
same-slug category is re-created.

The BUDGETS item uses a nested-map REMOVE + version SET under an optimistic lock,
which the shared FakeTable can't model, so these tests use the shared
``config_item_table`` fake from conftest (WHIT-251).
"""

from decimal import Decimal

import pytest


@pytest.fixture
def budget_repo(shared):
    r = shared.budget.BudgetRepository()
    r._table = None  # ensure the lazy boto3 path is never taken
    return r


def _with_table(budget_repo, table):
    budget_repo._table = table
    return budget_repo


def test_delete_budget_removes_an_existing_target(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": {"target": Decimal(300)}, "coffee": {"target": Decimal(60)}})
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert "groceries" not in table.item["items"]
    assert "coffee" in table.item["items"]          # only the one key removed
    assert table.item["version"] == Decimal(2)      # version bumped once
    assert table.update_calls == 1


def test_delete_budget_absent_target_is_a_silent_noop(shared, budget_repo, config_item_table):
    # The common case: the deleted category never had a budget. No write, no bump.
    table = config_item_table("BUDGETS", items={"coffee": {"target": Decimal(60)}}, version=5)
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert table.update_calls == 0                   # never touched the item
    assert table.item["version"] == Decimal(5)       # version unchanged
    assert "coffee" in table.item["items"]


def test_delete_budget_no_config_item_is_a_noop(shared, budget_repo, config_item_table):
    # No target was ever set -> the BUDGETS item doesn't exist. Nothing to cascade.
    table = config_item_table("BUDGETS", present=False)
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert table.update_calls == 0


def test_delete_budget_retries_once_under_a_version_race(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": {"target": Decimal(300)}})
    table.race_next_update()   # first update loses the lock; repo re-reads + retries
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert "groceries" not in table.item["items"]    # converged after the retry
    assert table.update_calls == 2


def test_delete_budget_raises_a_conflict_when_it_cannot_converge(shared, budget_repo, config_item_table):
    from repository_errors import VersionConflictError

    table = config_item_table("BUDGETS", items={"groceries": {"target": Decimal(300)}})
    table.always_race()   # every attempt loses the lock -> exhausts the retry budget
    _with_table(budget_repo, table)

    with pytest.raises(VersionConflictError):
        budget_repo.delete_budget("groceries")
    assert "groceries" in table.item["items"]        # never removed
