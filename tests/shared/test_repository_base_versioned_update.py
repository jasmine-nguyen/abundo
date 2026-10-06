"""RepositoryBase's shared settings-record steps (WHIT-763 slice 2): read, create-if-missing and
'save with version check, retry once' — the steps budgets, goals, pay cycle and categories share."""

from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable

_SETTINGS_KEY = {"pk": "SETTINGS", "sk": "TEST"}

# (module, class) for the four settings stores that now use the shared steps.
_SETTINGS_STORES = [
    ("repository_budget", "BudgetRepository"),
    ("repository_goals", "GoalsRepository"),
    ("repository_paycycle", "PayCycleRepository"),
    ("repository_category", "CategoryRepository"),
]


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
    import importlib

    import repository_base

    for module_name, class_name in _SETTINGS_STORES:
        cls = getattr(importlib.import_module(module_name), class_name)
        assert issubclass(cls, repository_base.RepositoryBase), class_name
        for step in ("_get_config", "_ensure_seeded", "_versioned_update"):
            assert step not in vars(cls), f"{class_name} still has its own {step}"
        assert isinstance(cls._config_key, dict) and cls._config_key, class_name

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
