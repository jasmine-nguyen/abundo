"""RepositoryBase's shared settings-record steps (WHIT-763 slice 2): read, create-if-missing and
'save with version check, retry once' — the steps budgets, goals, pay cycle and categories share."""

from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable

_SETTINGS_KEY = {"pk": "SETTINGS", "sk": "TEST"}
_STORE_KEY = (_SETTINGS_KEY["pk"], _SETTINGS_KEY["sk"])


def _settings_repo(table):
    import repository_base

    class _Settings(repository_base.RepositoryBase):
        _config_key = _SETTINGS_KEY
        _config_label = "test settings"

    repo = _Settings()
    repo._table = table
    return repo


def _set_entry(entry_id, value, result="saved"):
    def build(item):
        update = {
            "expression": "SET #items.#id = :value, #v = :next",
            "names": {"#items": "items", "#id": entry_id},
            "values": {":value": value},
        }
        return update, result

    return build


def test_a_clashing_save_retries_once_then_gives_up_with_a_version_conflict(shared):
    import repository_errors

    table = FakeTable()
    repo = _settings_repo(table)
    conflicts = []

    # One lost race → the second attempt re-reads, writes and returns the build's result.
    table.race_next_update()
    result = repo._versioned_update(
        _set_entry("a", "x"), action="set test", on_conflict=lambda: conflicts.append("lost"),
    )
    assert result == "saved"
    assert conflicts == ["lost"]
    assert len(table.update_calls) == 2
    stored = table.store[("SETTINGS", "TEST")]
    assert stored["items"] == {"a": "x"}
    assert stored["version"] == Decimal(3)  # seeded at 1, bumped by the racer to 2, saved as 3

    # Always losing → exactly two attempts, on_conflict after each, then VersionConflictError.
    table.update_calls.clear()
    conflicts.clear()
    table.always_race()
    with pytest.raises(repository_errors.VersionConflictError):
        repo._versioned_update(
            _set_entry("b", "y"), action="set test", on_conflict=lambda: conflicts.append("lost"),
        )
    assert len(table.update_calls) == 2
    assert conflicts == ["lost", "lost"]
    assert "b" not in table.store[("SETTINGS", "TEST")]["items"]

    # An error raised by on_conflict (e.g. a duplicate found on re-read) reaches the caller as-is.
    class _Duplicate(Exception):
        pass

    def found_duplicate():
        raise _Duplicate()

    table.update_calls.clear()
    with pytest.raises(_Duplicate):
        repo._versioned_update(_set_entry("c", "z"), action="set test", on_conflict=found_duplicate)
    assert len(table.update_calls) == 1


def test_settings_stores_use_the_shared_steps_and_skip_writes_when_nothing_changes(shared):
    # seed=False on a missing record: nothing is created, nothing is written.
    table = FakeTable()
    repo = _settings_repo(table)
    assert repo._get_config() is None
    assert repo._versioned_update(lambda item: None, action="remove test", seed=False) is None
    assert table.store == {}
    assert table.update_calls == [] and table.put_calls == []

    # Create-if-missing seeds the record once at version 1 with the default empty items map.
    repo._ensure_seeded()
    repo._ensure_seeded()
    assert table.store[("SETTINGS", "TEST")] == {**_SETTINGS_KEY, "items": {}, "version": Decimal(1)}

    # A build that finds nothing to change writes nothing and leaves the version alone.
    assert repo._versioned_update(lambda item: None, action="remove test") is None
    assert table.update_calls == []
    assert repo._get_config()["version"] == Decimal(1)


def _seeded(items):
    table = FakeTable()
    table.seed({**_SETTINGS_KEY, "items": items, "version": Decimal(1)})
    return table


def test_a_non_conflict_write_error_is_a_database_error_with_the_action_and_is_not_retried(
        shared, client_error, database_error):
    table = _seeded({})
    table.fail("update_item", client_error("InternalServerError", "down"))
    repo = _settings_repo(table)
    conflicts = []

    with pytest.raises(database_error):
        repo._versioned_update(_set_entry("a", "x"), action="set test",
                               on_conflict=lambda: conflicts.append("lost"))
    assert len(table.update_calls) == 1
    assert conflicts == []


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
