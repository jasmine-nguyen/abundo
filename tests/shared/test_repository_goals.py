"""Unit tests for GoalsRepository (WHIT-231): the goals config item (pk=sk="GOALS",
an `items` map of goal id -> goal object, plus a numeric `version`) written under an
optimistic lock. Mirrors the budget repository tests; the shared FakeTable only parses
flat SET expressions, so these tests use the shared ``config_item_table`` fake from
conftest, which models the seed put_item + the nested SET/REMOVE-plus-version-bump the
repo issues (WHIT-251).
"""

from decimal import Decimal

import pytest


@pytest.fixture
def goals_repo(shared):
    r = shared.goals.GoalsRepository()
    r._table = None  # ensure the lazy boto3 path is never taken
    return r


def _with_table(goals_repo, table):
    goals_repo._table = table
    return goals_repo


def _goal(**over):
    g = {
        "name": "Holiday fund", "icon": "palm", "direction": "grow",
        "target_amount": Decimal(5000), "target_date": "2026-12-01",
        "manual_balance": Decimal(3200), "manual_as_of": "2026-07-01",
    }
    g.update(over)
    return g


# --- list ------------------------------------------------------------------


def test_list_goals_seeds_empty_then_is_stable(shared, goals_repo, config_item_table):
    table = config_item_table("GOALS", present=False)   # nothing ever created
    _with_table(goals_repo, table)

    assert goals_repo.list_goals() == {}
    assert table.put_calls == 1                      # seeded once
    assert table.item["version"] == Decimal(1)

    assert goals_repo.list_goals() == {}             # already present -> no re-seed
    assert table.put_calls == 1


# --- upsert ----------------------------------------------------------------


def test_upsert_goal_writes_the_object_and_bumps_version(shared, goals_repo, config_item_table):
    table = config_item_table("GOALS", items={})
    _with_table(goals_repo, table)

    result = goals_repo.upsert_goal("g1", _goal())

    assert result == {"id": "g1", **_goal()}
    assert table.item["items"]["g1"] == _goal()      # whole object stored
    assert table.item["version"] == Decimal(2)       # bumped once
    assert table.update_calls == 1


def test_upsert_goal_overwrites_same_id_and_bumps_again(shared, goals_repo, config_item_table):
    table = config_item_table("GOALS", items={"g1": _goal()}, version=2)
    _with_table(goals_repo, table)

    goals_repo.upsert_goal("g1", _goal(name="Bigger holiday", target_amount=Decimal(8000)))

    assert table.item["items"]["g1"]["name"] == "Bigger holiday"
    assert table.item["items"]["g1"]["target_amount"] == Decimal(8000)
    assert table.item["version"] == Decimal(3)


def test_upsert_goal_preserves_other_goals(shared, goals_repo, config_item_table):
    other = _goal(name="Car loan", direction="paydown", target_amount=Decimal(0))
    table = config_item_table("GOALS", items={"g2": other})
    _with_table(goals_repo, table)

    goals_repo.upsert_goal("g1", _goal())

    assert table.item["items"]["g2"] == other        # only g1's key was written
    assert "g1" in table.item["items"]


def test_upsert_goal_retries_once_under_a_version_race(shared, goals_repo, config_item_table):
    table = config_item_table("GOALS", items={})
    table.race_next_update()                          # first update loses the lock
    _with_table(goals_repo, table)

    goals_repo.upsert_goal("g1", _goal())

    assert "g1" in table.item["items"]                # converged after the retry
    assert table.update_calls == 2


def test_upsert_goal_raises_a_conflict_when_it_cannot_converge(shared, goals_repo, config_item_table):
    from repository_errors import VersionConflictError

    table = config_item_table("GOALS", items={})
    original = table.update_item

    def _always_race(*a, **k):                        # every attempt loses
        table._bump_before_next_update = True
        return original(*a, **k)

    table.update_item = _always_race
    _with_table(goals_repo, table)

    with pytest.raises(VersionConflictError):
        goals_repo.upsert_goal("g1", _goal())
    assert "g1" not in table.item["items"]            # never written


# --- delete ----------------------------------------------------------------


def test_delete_goal_removes_an_existing_goal(shared, goals_repo, config_item_table):
    table = config_item_table("GOALS", items={"g1": _goal(), "g2": _goal(name="Car")})
    _with_table(goals_repo, table)

    goals_repo.delete_goal("g1")

    assert "g1" not in table.item["items"]
    assert "g2" in table.item["items"]                # only the one key removed
    assert table.item["version"] == Decimal(2)
    assert table.update_calls == 1


def test_delete_goal_absent_is_a_silent_noop(shared, goals_repo, config_item_table):
    table = config_item_table("GOALS", items={"g2": _goal()}, version=5)
    _with_table(goals_repo, table)

    goals_repo.delete_goal("g1")

    assert table.update_calls == 0                    # never touched the item
    assert table.item["version"] == Decimal(5)        # version unchanged


def test_delete_goal_no_config_item_is_a_noop(shared, goals_repo, config_item_table):
    table = config_item_table("GOALS", present=False)                # nothing ever created
    _with_table(goals_repo, table)

    goals_repo.delete_goal("g1")

    assert table.update_calls == 0
    assert table.put_calls == 0                       # delete never seeds


def test_delete_goal_retries_once_under_a_version_race(shared, goals_repo, config_item_table):
    table = config_item_table("GOALS", items={"g1": _goal()})
    table.race_next_update()
    _with_table(goals_repo, table)

    goals_repo.delete_goal("g1")

    assert "g1" not in table.item["items"]            # converged after the retry
    assert table.update_calls == 2


def test_delete_goal_raises_a_conflict_when_it_cannot_converge(shared, goals_repo, config_item_table):
    from repository_errors import VersionConflictError

    table = config_item_table("GOALS", items={"g1": _goal()})
    original = table.update_item

    def _always_race(*a, **k):
        table._bump_before_next_update = True
        return original(*a, **k)

    table.update_item = _always_race
    _with_table(goals_repo, table)

    with pytest.raises(VersionConflictError):
        goals_repo.delete_goal("g1")
    assert "g1" in table.item["items"]                # never removed
