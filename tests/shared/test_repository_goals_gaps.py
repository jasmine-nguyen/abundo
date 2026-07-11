"""WHIT-231 — adversarial concurrency/realism gaps for GoalsRepository.

The implementer's race test bumps the version but keeps a STATIC map, so it never
proves the retry re-reads and MERGES a sibling goal a concurrent writer committed
during the race window (the whole point of the nested SET). These fill that gap plus
the lost seed-race re-read and the literal-attribute-name (dotted id) behaviour.
Keeps its own bespoke racing fakes below, modelling the same pk=sk="GOALS" config
item as the shared `ConfigItemTable` in conftest (a different race mechanism, so not
folded into it).
"""

import copy
from decimal import Decimal

import pytest


def _client_error(code):
    from botocore.exceptions import ClientError
    err = ClientError()
    err.response = {"Error": {"Code": code, "Message": "boom"}}
    return err


def _goal(**over):
    g = {
        "name": "Holiday fund", "icon": "palm", "direction": "grow",
        "target_amount": Decimal(5000), "target_date": "2026-12-01",
        "manual_balance": Decimal(3200), "manual_as_of": "2026-07-01",
    }
    g.update(over)
    return g


class _RacingGoalsTable:
    """Config item whose next update_item is preceded by a concurrent writer that
    commits its OWN goal key and bumps the version — so the repo's first guarded
    update fails and the retry must re-read (picking up the sibling) and converge."""

    def __init__(self, items=None, version=1):
        self.item = {
            "pk": "GOALS", "sk": "GOALS",
            "items": dict(items or {}), "version": Decimal(version),
        }
        self.present = True
        self.update_calls = 0
        self._inject = None

    def inject_concurrent(self, goal_id, goal):
        self._inject = (goal_id, goal)

    def get_item(self, Key):
        return {"Item": copy.deepcopy(self.item)}

    def put_item(self, Item, ConditionExpression=None):
        if ConditionExpression == "attribute_not_exists(pk)" and self.present:
            raise _client_error("ConditionalCheckFailedException")
        self.item = copy.deepcopy(Item)
        self.present = True

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames,
                    ExpressionAttributeValues, ConditionExpression=None):
        self.update_calls += 1
        if self._inject is not None:
            gid, goal = self._inject
            self._inject = None
            self.item["items"][gid] = goal                 # concurrent writer commits
            self.item["version"] = self.item["version"] + Decimal(1)
        expected = ExpressionAttributeValues[":expected"]
        if not self.present or expected != self.item["version"]:
            raise _client_error("ConditionalCheckFailedException")
        gid = ExpressionAttributeNames["#id"]              # literal attr name (aliased)
        if UpdateExpression.startswith("REMOVE"):
            self.item["items"].pop(gid, None)
        else:
            self.item["items"][gid] = ExpressionAttributeValues[":val"]
        self.item["version"] = ExpressionAttributeValues[":next"]


class _SeedRaceTable:
    """Never seeded from our view: the first get_item is empty, but our seed put loses
    the race to a concurrent caller who ALSO created goals — so the re-read must reflect
    their state, not an empty map."""

    def __init__(self, concurrent_items):
        self._concurrent = concurrent_items
        self.present = False
        self.item = None
        self.put_calls = 0
        self.update_calls = 0

    def get_item(self, Key):
        return {"Item": copy.deepcopy(self.item)} if self.present else {}

    def put_item(self, Item, ConditionExpression=None):
        self.put_calls += 1
        self.item = {
            "pk": "GOALS", "sk": "GOALS",
            "items": dict(self._concurrent), "version": Decimal(2),
        }
        self.present = True
        raise _client_error("ConditionalCheckFailedException")


@pytest.fixture
def goals_repo(shared):
    r = shared.goals.GoalsRepository()
    r._table = None
    return r


# --- concurrency convergence -------------------------------------------------


def test_upsert_converges_and_preserves_a_concurrent_sibling(shared, goals_repo):
    # Race writes a DIFFERENT goal (g2) during the window. The retry must re-read and
    # keep g2 while adding g1 — the sibling-preservation the static-map race can't prove.
    table = _RacingGoalsTable(items={})
    table.inject_concurrent("g2", _goal(name="Car"))
    goals_repo._table = table

    goals_repo.upsert_goal("g1", _goal())

    assert set(table.item["items"]) == {"g1", "g2"}       # neither clobbered
    assert table.item["items"]["g2"]["name"] == "Car"
    assert table.update_calls == 2                        # converged on the retry
    assert table.item["version"] == Decimal(3)            # concurrent bump + our bump


def test_delete_converges_and_preserves_a_concurrent_sibling(shared, goals_repo):
    # Delete g1 while a concurrent writer adds g2 mid-race. Retry removes g1, keeps g2.
    table = _RacingGoalsTable(items={"g1": _goal()})
    table.inject_concurrent("g2", _goal(name="Car"))
    goals_repo._table = table

    goals_repo.delete_goal("g1")

    assert set(table.item["items"]) == {"g2"}
    assert table.update_calls == 2


# --- lost seed race ----------------------------------------------------------


def test_list_reflects_a_concurrent_seed_and_create(shared, goals_repo):
    # Our seed loses to a concurrent caller who seeded AND created g1. The re-read must
    # surface g1 (not {}, not a crash). Load-bears the re-read line in list_goals.
    table = _SeedRaceTable({"g1": _goal()})
    goals_repo._table = table

    result = goals_repo.list_goals()

    assert set(result) == {"g1"}
    assert table.put_calls == 1                           # tried to seed once, lost


# --- literal attribute name (dotted id) --------------------------------------


def test_upsert_stores_a_dotted_id_as_one_literal_key(shared, goals_repo):
    # The #id alias makes the goal id a literal attribute name, so a dot does NOT create
    # a nested map path (which real DynamoDB would do with an inlined path).
    table = _RacingGoalsTable(items={})
    goals_repo._table = table

    goals_repo.upsert_goal("a.b.c", _goal())

    assert list(table.item["items"]) == ["a.b.c"]
