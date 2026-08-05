"""Unit tests for GoalsRepository (WHIT-231): the goals config item (pk=sk="GOALS",
an `items` map of goal id -> goal object, plus a numeric `version`) written under an
optimistic lock. Mirrors the budget repository tests; the shared FakeTable only parses
flat SET expressions, so these tests use the shared ``config_item_table`` fake from
conftest, which models the seed put_item + the nested SET/REMOVE-plus-version-bump the
repo issues (WHIT-251).
"""

from decimal import Decimal

import pytest
import copy


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
    table.always_race()                               # every attempt loses
    _with_table(goals_repo, table)

    with pytest.raises(VersionConflictError):
        goals_repo.upsert_goal("g1", _goal())
    assert "g1" not in table.item["items"]            # never written


# --- WHIT-252: immutable start (start_date + start_balance) ------------------

_START = {"start_date": "2026-07-11", "start_balance": Decimal(3200)}


def test_upsert_stamps_start_candidate_on_create(shared, goals_repo, config_item_table):
    table = config_item_table("GOALS", items={})
    _with_table(goals_repo, table)

    result = goals_repo.upsert_goal("g1", _goal(), start_candidate=dict(_START))

    stored = table.item["items"]["g1"]
    assert stored["start_date"] == "2026-07-11"
    assert stored["start_balance"] == Decimal(3200)
    assert result["start_date"] == "2026-07-11"


def test_upsert_preserves_start_on_edit(shared, goals_repo, config_item_table):
    # g1 already has a start; an edit (new name) with a DIFFERENT candidate must not move it.
    table = config_item_table("GOALS", items={"g1": _goal(**_START)}, version=2)
    _with_table(goals_repo, table)

    goals_repo.upsert_goal(
        "g1", _goal(name="Bigger holiday"),
        start_candidate={"start_date": "2027-01-01", "start_balance": Decimal(9999)})

    stored = table.item["items"]["g1"]
    assert stored["name"] == "Bigger holiday"          # the edit applied
    assert stored["start_date"] == "2026-07-11"         # original start frozen
    assert stored["start_balance"] == Decimal(3200)


def test_upsert_preserves_start_on_balance_update(shared, goals_repo, config_item_table):
    # A WHIT-235 balance update sends a changed manual_balance/manual_as_of; start stays put.
    table = config_item_table("GOALS", items={"g1": _goal(**_START)}, version=2)
    _with_table(goals_repo, table)

    goals_repo.upsert_goal(
        "g1", _goal(manual_balance=Decimal(1500), manual_as_of="2026-09-01"),
        start_candidate={"start_date": "2026-09-01", "start_balance": Decimal(1500)})

    stored = table.item["items"]["g1"]
    assert stored["manual_balance"] == Decimal(1500)    # current balance moved
    assert stored["start_date"] == "2026-07-11"         # but the start didn't
    assert stored["start_balance"] == Decimal(3200)


def test_upsert_fills_absent_start_once_then_freezes(shared, goals_repo, config_item_table):
    # Option A: a synced goal created pre-poll has no start; the first upsert with a real
    # candidate fills it, and a later upsert can no longer move it.
    no_start = {k: v for k, v in _goal().items() if not k.startswith("start_")}
    table = config_item_table("GOALS", items={"g1": no_start})
    _with_table(goals_repo, table)

    goals_repo.upsert_goal("g1", _goal(), start_candidate=dict(_START))
    assert table.item["items"]["g1"]["start_balance"] == Decimal(3200)

    goals_repo.upsert_goal(
        "g1", _goal(),
        start_candidate={"start_date": "2028-08-08", "start_balance": Decimal(1)})
    assert table.item["items"]["g1"]["start_date"] == "2026-07-11"   # frozen at the first fill
    assert table.item["items"]["g1"]["start_balance"] == Decimal(3200)


def test_upsert_stamps_no_start_when_candidate_empty(shared, goals_repo, config_item_table):
    # Synced goal still not polled: empty candidate, no existing start -> nothing stamped.
    table = config_item_table("GOALS", items={})
    _with_table(goals_repo, table)

    goals_repo.upsert_goal("g1", _goal(), start_candidate={})

    stored = table.item["items"]["g1"]
    assert "start_date" not in stored
    assert "start_balance" not in stored


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
    table.always_race()
    _with_table(goals_repo, table)

    with pytest.raises(VersionConflictError):
        goals_repo.delete_goal("g1")
    assert "g1" in table.item["items"]                # never removed


# --- WHIT-252 QA GAPS: race-retry preserve, partial-start merge, source switch ---
# (Independent of the implementer's WHIT-252 tests above. Reuse the shared config_item_table
# fake + client_error factory, _goal / _with_table / _START. Every start value is a pinned literal.)


def test_upsert_race_retry_preserves_a_concurrently_stamped_start(shared, goals_repo, config_item_table, client_error):
    # [A15] The version-race retry must re-READ and re-MERGE the start INSIDE the loop.
    # Setup: a synced goal exists with NO start (created pre-poll); our upsert carries an
    # EMPTY candidate (still unpolled on our side). Mid-write, a concurrent poll-fill stamps
    # the start and bumps the version, so our first update loses the lock. The retry must
    # carry that freshly-stamped start forward -- never clobber it back to "no start".
    # This is the test that pins the merge inside the retry loop (fail-on-revert target).
    no_start = {k: v for k, v in _goal().items() if not k.startswith("start_")}
    table = config_item_table("GOALS", items={"g1": no_start})
    original = table.update_item
    attempts = {"n": 0}

    def _concurrent_fill_then_race(*a, **k):
        attempts["n"] += 1
        if attempts["n"] == 1:
            # A concurrent writer stamps the start and moves the version under us.
            table.item["items"]["g1"] = {
                **no_start, "start_date": "2026-07-11", "start_balance": Decimal(3200)}
            table.item["version"] = table.item["version"] + Decimal(1)
            raise client_error("ConditionalCheckFailedException")
        return original(*a, **k)

    table.update_item = _concurrent_fill_then_race
    _with_table(goals_repo, table)

    goals_repo.upsert_goal("g1", _goal(name="Edited after race"), start_candidate={})

    stored = table.item["items"]["g1"]
    assert attempts["n"] == 2                              # lost the lock once, converged on retry
    assert stored["name"] == "Edited after race"          # our edit applied
    assert stored["start_date"] == "2026-07-11"           # concurrent start preserved...
    assert stored["start_balance"] == Decimal(3200)       # ...not clobbered back to absent


def test_upsert_with_only_one_stored_start_key_is_discarded_as_a_pair(shared, goals_repo, config_item_table):
    # [A16] DEFENSIVE: a corrupted/hand-crafted goal holding ONLY start_date (no
    # start_balance) must not crash AND must not produce a MIXED pair. The merge is
    # pair-atomic: a half-pair isn't a valid frozen start, so it's discarded and the whole
    # coherent candidate is stamped instead (both fields describe the same moment).
    half = {k: v for k, v in _goal().items() if not k.startswith("start_")}
    half["start_date"] = "2026-07-11"
    table = config_item_table("GOALS", items={"g1": half})
    _with_table(goals_repo, table)

    goals_repo.upsert_goal(
        "g1", _goal(),
        start_candidate={"start_date": "2030-01-01", "start_balance": Decimal(77)})

    stored = table.item["items"]["g1"]
    # The stray half-pair is dropped; the candidate pair wins whole (no date/balance mismatch).
    assert stored["start_date"] == "2030-01-01"
    assert stored["start_balance"] == Decimal(77)


def test_upsert_switching_source_preserves_start_and_drops_stale_manual(shared, goals_repo, config_item_table):
    # [A17] An edit that changes the balance SOURCE (manual -> synced account) still freezes
    # the original start, and the whole-object replace drops the now-stale manual_balance.
    table = config_item_table("GOALS", items={"g1": _goal(**_START)}, version=2)   # manual goal + a start
    _with_table(goals_repo, table)

    synced = {
        "name": "Holiday fund", "icon": "palm", "direction": "grow",
        "target_amount": Decimal(5000), "target_date": "2026-12-01",
        "account_id": "up-spending",
    }
    goals_repo.upsert_goal(
        "g1", synced,
        start_candidate={"start_date": "2027-01-01", "start_balance": Decimal(1)})

    stored = table.item["items"]["g1"]
    assert stored["account_id"] == "up-spending"          # new source applied
    assert "manual_balance" not in stored                 # stale source dropped by full replace
    assert stored["start_date"] == "2026-07-11"           # start frozen across the source switch
    assert stored["start_balance"] == Decimal(3200)


# --- folded from test_repository_goals_gaps.py (WHIT-463) ---


def _client_error(code):
    from botocore.exceptions import ClientError
    err = ClientError()
    err.response = {"Error": {"Code": code, "Message": "boom"}}
    return err


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


def test_list_reflects_a_concurrent_seed_and_create(shared, goals_repo):
    # Our seed loses to a concurrent caller who seeded AND created g1. The re-read must
    # surface g1 (not {}, not a crash). Load-bears the re-read line in list_goals.
    table = _SeedRaceTable({"g1": _goal()})
    goals_repo._table = table

    result = goals_repo.list_goals()

    assert set(result) == {"g1"}
    assert table.put_calls == 1                           # tried to seed once, lost


def test_upsert_stores_a_dotted_id_as_one_literal_key(shared, goals_repo):
    # The #id alias makes the goal id a literal attribute name, so a dot does NOT create
    # a nested map path (which real DynamoDB would do with an inlined path).
    table = _RacingGoalsTable(items={})
    goals_repo._table = table

    goals_repo.upsert_goal("a.b.c", _goal())

    assert list(table.item["items"]) == ["a.b.c"]
