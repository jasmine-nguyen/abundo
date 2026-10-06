"""QA edges for RepositoryBase's settings-record steps (WHIT-763 slice 2): error labels, the extra
write condition, re-planning on every attempt, and what each settings store seeds."""

from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable, _client_error
from test_repository_base_versioned_update import _SETTINGS_KEY, _set_entry, _settings_repo

_STORE_KEY = (_SETTINGS_KEY["pk"], _SETTINGS_KEY["sk"])


def _seeded(items):
    table = FakeTable()
    table.seed({**_SETTINGS_KEY, "items": items, "version": Decimal(1)})
    return table


# [A1] (P0)
def test_a_non_conflict_write_error_is_a_database_error_with_the_action_and_is_not_retried(
        shared, database_error):
    table = _seeded({})
    table.fail("update_item", _client_error("InternalServerError", "down"))
    repo = _settings_repo(table)
    conflicts = []

    with pytest.raises(database_error, match="^Database set test failed: down$"):
        repo._versioned_update(_set_entry("a", "x"), action="set test",
                               on_conflict=lambda: conflicts.append("lost"))
    assert len(table.update_calls) == 1
    assert conflicts == []


# [A2] (P0)
def test_the_extra_condition_guards_the_write_alongside_the_version_check(shared):
    import repository_errors

    table = _seeded({"a": "taken"})
    repo = _settings_repo(table)

    def create_once(entry_id):
        def build(item):
            return {
                "expression": "SET #items.#id = :value, #v = :next",
                "condition": "attribute_not_exists(#items.#id)",
                "names": {"#items": "items", "#id": entry_id},
                "values": {":value": "new"},
            }, "created"
        return build

    with pytest.raises(repository_errors.VersionConflictError):
        repo._versioned_update(create_once("a"), action="create test")
    assert table.store[_STORE_KEY]["items"] == {"a": "taken"}
    assert table.store[_STORE_KEY]["version"] == Decimal(1)

    assert repo._versioned_update(create_once("b"), action="create test") == "created"
    assert table.store[_STORE_KEY]["items"] == {"a": "taken", "b": "new"}
    assert table.store[_STORE_KEY]["version"] == Decimal(2)


# [A3] (P0)
def test_each_attempt_plans_against_a_fresh_read_so_a_racers_write_is_kept(shared):
    table = _seeded({})
    repo = _settings_repo(table)
    seen = []

    def racer(key, fake):
        row = fake.store[_STORE_KEY]
        row["items"]["racer"] = "theirs"
        row["version"] += 1

    table.before_next_write(racer)

    def build(item):
        seen.append(dict(item["items"]))
        return _set_entry("mine", "ours")(item)

    assert repo._versioned_update(build, action="set test") == "saved"
    assert seen == [{}, {"racer": "theirs"}]
    assert table.store[_STORE_KEY]["items"] == {"racer": "theirs", "mine": "ours"}
    assert table.store[_STORE_KEY]["version"] == Decimal(3)


# [A4] (P1)
def test_a_retry_that_finds_nothing_left_to_do_stops_without_writing(shared):
    table = _seeded({"gone": "soon"})
    repo = _settings_repo(table)

    def racer_removes(key, fake):
        row = fake.store[_STORE_KEY]
        row["items"].pop("gone")
        row["version"] += 1

    table.before_next_write(racer_removes)

    def remove_if_present(item):
        if "gone" not in item["items"]:
            return None
        return {"expression": "REMOVE #items.#id SET #v = :next",
                "names": {"#items": "items", "#id": "gone"}}, "removed"

    assert repo._versioned_update(remove_if_present, action="remove test", seed=False) is None
    assert len(table.update_calls) == 1
    assert table.store[_STORE_KEY]["version"] == Decimal(2)  # only the racer's bump


# [A5] (P1)
def test_read_and_seed_failures_are_database_errors_labelled_with_the_store(shared, database_error):
    table = FakeTable()
    table.fail("get_item", _client_error("InternalServerError", "down"))
    repo = _settings_repo(table)
    with pytest.raises(database_error, match="^Database read test settings failed: down$"):
        repo._get_config()

    table = FakeTable()
    table.fail("put_item", _client_error("InternalServerError", "down"))
    repo = _settings_repo(table)
    with pytest.raises(database_error, match="^Database seed test settings failed: down$"):
        repo._versioned_update(_set_entry("a", "x"), action="set test")
    assert table.get_item_calls == 0
    assert table.update_calls == []


# [A6] (P1)
def test_the_give_up_error_names_the_action(shared):
    import repository_errors

    table = _seeded({})
    table.always_race()
    repo = _settings_repo(table)
    with pytest.raises(repository_errors.VersionConflictError,
                       match="^set test: exhausted retries under write contention$"):
        repo._versioned_update(_set_entry("a", "x"), action="set test")


# [A7] (P1)
def test_saving_to_a_missing_record_seeds_it_first_then_bumps_it_to_version_2(shared):
    table = FakeTable()
    repo = _settings_repo(table)
    seen = []

    def build(item):
        seen.append(item)
        return _set_entry("a", "x")(item)

    assert repo._versioned_update(build, action="set test") == "saved"
    assert seen[0]["version"] == Decimal(1) and seen[0]["items"] == {}
    assert table.store[_STORE_KEY] == {**_SETTINGS_KEY, "items": {"a": "x"}, "version": Decimal(2)}


# [A8] (P0)
def test_each_settings_store_seeds_its_own_starting_record(shared):
    import repository_budget
    import repository_category
    import repository_goals
    import repository_paycycle
    from constants import DEFAULT_PAYCYCLE

    expected = {
        repository_budget.BudgetRepository: {"pk": "BUDGETS", "sk": "BUDGETS", "items": {}},
        repository_goals.GoalsRepository: {"pk": "GOALS", "sk": "GOALS", "items": {}},
        repository_paycycle.PayCycleRepository: {
            "pk": "PAYCYCLE", "sk": "PAYCYCLE",
            "length": Decimal(DEFAULT_PAYCYCLE["length"]),
            "last_pay_date": DEFAULT_PAYCYCLE["last_pay_date"],
        },
        repository_category.CategoryRepository: {
            "pk": "CATEGORIES", "sk": "CATEGORIES",
            "items": dict(repository_category.SEED_CATEGORIES),
            "colorSlotSchema": Decimal(2),
        },
    }
    for cls, fields in expected.items():
        table = FakeTable()
        repo = cls()
        repo._table = table
        repo._ensure_seeded()
        repo._ensure_seeded()
        assert table.put_calls[0] == {**fields, "version": Decimal(1)}, cls.__name__
        assert list(table.store.values()) == [{**fields, "version": Decimal(1)}], cls.__name__


# [A9] (P0)
def test_set_paycycle_on_a_fresh_store_survives_one_race_and_keeps_its_values(shared):
    import repository_paycycle

    repo = repository_paycycle.PayCycleRepository()
    repo._table = FakeTable()
    repo._table.race_next_update()

    assert repo.set_paycycle(28, "2026-10-01") == {"length": 28, "last_pay_date": "2026-10-01"}
    stored = repo._table.store[("PAYCYCLE", "PAYCYCLE")]
    assert stored["length"] == Decimal(28)
    assert stored["last_pay_date"] == "2026-10-01"
    assert stored["version"] == Decimal(3)
