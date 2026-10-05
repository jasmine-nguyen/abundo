"""WHIT-735: the one-off fix that switches Insurance categories from the heartbeat to the shield icon.

Imports scripts/migrations/insurance_icon_to_shield.py through importlib (like the other migration
suites) and drives run(table, item, dry_run) over an in-memory FakeTable. `item` stands in for the
script's get_item read of the single CATEGORIES item.
"""

from decimal import Decimal

from _dynamo_fakes import FakeTable
from _migration_scripts import load_migration_script

_KEY = ("CATEGORIES", "CATEGORIES")


def _load_script():
    return load_migration_script("insurance_icon_to_shield")


def _categories_item():
    return {
        "pk": "CATEGORIES", "sk": "CATEGORIES", "version": Decimal(7),
        "items": {
            "health": {"name": "Health", "bucket": "Living", "icon": "health"},
            "c-ins": {"name": "Insurance", "bucket": "Living", "icon": "health"},
            "c-gym": {"name": "Gym", "bucket": "Lifestyle", "icon": "health"},
            "c-car": {"name": "Car Insurance", "bucket": "Living", "icon": "car"},
        },
    }


def _icons(table):
    return {cat_id: cat["icon"] for cat_id, cat in table.store[_KEY]["items"].items()}


_BEFORE = {"health": "health", "c-ins": "health", "c-gym": "health", "c-car": "car"}


def test_insurance_switches_to_shield_only_when_applied_and_a_rerun_changes_nothing():
    script = _load_script()
    table = FakeTable()
    table.seed(_categories_item())

    dry = script.run(table, _categories_item(), dry_run=True)

    assert dry["matched"] == ["Insurance"]
    assert dry["updated"] == 0
    assert table.update_calls == []
    assert _icons(table) == _BEFORE

    applied = script.run(table, _categories_item(), dry_run=False)

    assert applied["updated"] == 1
    assert _icons(table) == {**_BEFORE, "c-ins": "insurance"}
    assert table.store[_KEY]["version"] == Decimal(8)

    calls_before_rerun = len(table.update_calls)
    again = script.run(table, table.store[_KEY], dry_run=False)

    assert again["matched"] == []
    assert again["updated"] == 0
    assert len(table.update_calls) == calls_before_rerun
    assert _icons(table) == {**_BEFORE, "c-ins": "insurance"}


def test_a_save_between_read_and_write_is_a_conflict_and_writes_nothing():
    script = _load_script()
    table = FakeTable()
    table.seed(_categories_item())
    table.race_next_update()

    result = script.run(table, _categories_item(), dry_run=False)

    assert result["conflict"] is True
    assert result["updated"] == 0
    assert _icons(table) == _BEFORE
