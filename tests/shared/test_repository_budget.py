"""Unit tests for BudgetRepository.delete_budget (WHIT-73): the cascade run when a
category is deleted, so a stale target can't linger and silently reappear if a
same-slug category is re-created.

The shared FakeTable in conftest only parses flat SET expressions; the BUDGETS
item uses a nested-map REMOVE + version SET under an optimistic lock. So this
module carries its own tiny stand-in that models exactly those operations,
leaving the shared FakeTable (and the suites that depend on it) untouched.
"""

import copy
from decimal import Decimal

import pytest


def _client_error(code):
    from botocore.exceptions import ClientError
    err = ClientError()
    err.response = {"Error": {"Code": code, "Message": "boom"}}
    return err


class _BudgetTable:
    """Models the single pk=sk="BUDGETS" config item: an `items` map + a numeric
    `version`, updated under an `attribute_exists(pk) AND #v = :expected` guard.
    """

    def __init__(self, items=None, version=1, present=True):
        self.item = {
            "pk": "BUDGETS", "sk": "BUDGETS",
            "items": dict(items or {}), "version": Decimal(version),
        }
        self.present = present   # False -> config item never seeded
        self.update_calls = 0
        self._bump_before_next_update = False

    def get_item(self, Key):
        return {"Item": copy.deepcopy(self.item)} if self.present else {}

    def race_next_update(self):
        """Arm a one-shot optimistic-lock race: the next update_item sees a version
        that moved under it (someone else wrote), then the retry converges."""
        self._bump_before_next_update = True

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues, ConditionExpression=None):
        self.update_calls += 1
        if self._bump_before_next_update:
            self._bump_before_next_update = False
            self.item["version"] = self.item["version"] + Decimal(1)  # concurrent writer
        expected = ExpressionAttributeValues[":expected"]
        if not self.present or expected != self.item["version"]:
            raise _client_error("ConditionalCheckFailedException")
        cat = ExpressionAttributeNames["#id"]
        self.item["items"].pop(cat, None)             # REMOVE #items.#id
        self.item["version"] = ExpressionAttributeValues[":next"]  # SET #v = :next


@pytest.fixture
def budget_repo(shared):
    r = shared.budget.BudgetRepository()
    r._table = None  # ensure the lazy boto3 path is never taken
    return r


def _with_table(budget_repo, table):
    budget_repo._table = table
    return budget_repo


def test_delete_budget_removes_an_existing_target(shared, budget_repo):
    table = _BudgetTable(items={"groceries": {"target": Decimal(300)}, "coffee": {"target": Decimal(60)}})
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert "groceries" not in table.item["items"]
    assert "coffee" in table.item["items"]          # only the one key removed
    assert table.item["version"] == Decimal(2)      # version bumped once
    assert table.update_calls == 1


def test_delete_budget_absent_target_is_a_silent_noop(shared, budget_repo):
    # The common case: the deleted category never had a budget. No write, no bump.
    table = _BudgetTable(items={"coffee": {"target": Decimal(60)}}, version=5)
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert table.update_calls == 0                   # never touched the item
    assert table.item["version"] == Decimal(5)       # version unchanged
    assert "coffee" in table.item["items"]


def test_delete_budget_no_config_item_is_a_noop(shared, budget_repo):
    # No target was ever set -> the BUDGETS item doesn't exist. Nothing to cascade.
    table = _BudgetTable(present=False)
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert table.update_calls == 0


def test_delete_budget_retries_once_under_a_version_race(shared, budget_repo):
    table = _BudgetTable(items={"groceries": {"target": Decimal(300)}})
    table.race_next_update()   # first update loses the lock; repo re-reads + retries
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert "groceries" not in table.item["items"]    # converged after the retry
    assert table.update_calls == 2


def test_delete_budget_raises_a_conflict_when_it_cannot_converge(shared, budget_repo):
    from repository_errors import VersionConflictError

    table = _BudgetTable(items={"groceries": {"target": Decimal(300)}})
    # Keep re-arming the race so every attempt loses -> exhausts the retry budget.
    original = table.update_item

    def _always_race(*a, **k):
        table._bump_before_next_update = True
        return original(*a, **k)

    table.update_item = _always_race
    _with_table(budget_repo, table)

    with pytest.raises(VersionConflictError):
        budget_repo.delete_budget("groceries")
    assert "groceries" in table.item["items"]        # never removed
