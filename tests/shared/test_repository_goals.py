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
    original = table.update_item

    def _always_race(*a, **k):
        table._bump_before_next_update = True
        return original(*a, **k)

    table.update_item = _always_race
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
