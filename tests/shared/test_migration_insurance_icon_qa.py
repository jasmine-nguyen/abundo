"""WHIT-735 QA: edges of the one-off Insurance → shield icon fix.

Several matches in one write, the per-icon and per-category guards, an empty table, and main()'s
printed lines (boto3.resource swapped for a FakeTable).
"""

from decimal import Decimal

from _dynamo_fakes import FakeTable
from test_migration_insurance_icon import _KEY, _icons, _load_script


def _item():
    return {
        "pk": "CATEGORIES", "sk": "CATEGORIES", "version": Decimal(3),
        "items": {
            "health": {"name": "Health", "icon": "health"},
            "c-ins": {"name": "Insurance", "icon": "health"},
            "c-pet": {"name": "  Pet INSURANCE ", "icon": "health"},
        },
    }


_BEFORE = {"health": "health", "c-ins": "health", "c-pet": "health"}


def _seeded():
    table = FakeTable()
    table.seed(_item())
    return table


# [A8] (P0) every matching category switches in ONE conditional write; version goes up by one.
def test_several_matches_switch_together_in_one_write():
    script = _load_script()
    table = _seeded()

    result = script.run(table, _item(), dry_run=False)

    assert sorted(result["matched"]) == ["  Pet INSURANCE ", "Insurance"]
    assert result["updated"] == 2
    assert len(table.update_calls) == 1
    assert _icons(table) == {"health": "health", "c-ins": "insurance", "c-pet": "insurance"}
    assert table.store[_KEY]["version"] == Decimal(4)


# [A9] (P0) an icon picked in between, without a version bump, still blocks the whole write.
def test_an_icon_changed_after_the_read_blocks_the_write():
    script = _load_script()
    table = _seeded()
    table.before_next_write(lambda key, t: t.store[_KEY]["items"]["c-pet"].update(icon="paw"))

    result = script.run(table, _item(), dry_run=False)

    assert result.get("conflict") is True
    assert result["updated"] == 0
    assert _icons(table) == {**_BEFORE, "c-pet": "paw"}
    assert table.store[_KEY]["version"] == Decimal(3)


# [A10] (P1) a category deleted after the read is a conflict, never re-created by the write.
def test_a_category_deleted_after_the_read_is_not_recreated():
    script = _load_script()
    table = _seeded()
    table.before_next_write(lambda key, t: t.store[_KEY]["items"].pop("c-pet"))

    result = script.run(table, _item(), dry_run=False)

    assert result.get("conflict") is True
    assert "c-pet" not in table.store[_KEY]["items"]
    assert _icons(table) == {"health": "health", "c-ins": "health"}


# [A11] (P1) no categories item at all → nothing matched, nothing written, no crash.
def test_a_missing_categories_item_is_a_no_op():
    script = _load_script()
    table = FakeTable()

    assert script.run(table, {}, dry_run=False) == {"matched": [], "updated": 0}
    assert table.update_calls == []


def _patch_table(script, monkeypatch, table):
    class _Resource:
        def Table(self, name):
            return table

    monkeypatch.setattr(script.boto3, "resource", lambda *a, **k: _Resource(), raising=False)


# [A12] (P0) main() previews by default: prints the dry-run line, writes nothing, reads consistently.
def test_main_previews_without_apply(monkeypatch, capsys):
    script = _load_script()
    table = _seeded()
    _patch_table(script, monkeypatch, table)
    monkeypatch.setattr(script.sys, "argv", ["insurance_icon_to_shield.py"])

    script.main()

    out = capsys.readouterr().out
    assert "Dry run — nothing written. Re-run with --apply." in out
    assert "'updated': 0" in out
    assert table.update_calls == []
    assert table.consistent_reads == [True]
    assert _icons(table) == _BEFORE


# [A13] (P0) main() --apply writes; on a race it prints the re-run line and writes nothing.
def test_main_apply_writes_and_reports_a_conflict(monkeypatch, capsys):
    script = _load_script()
    table = _seeded()
    _patch_table(script, monkeypatch, table)
    monkeypatch.setattr(script.sys, "argv", ["insurance_icon_to_shield.py", "--apply"])

    table.race_next_update()
    script.main()
    out = capsys.readouterr().out
    assert "Categories changed since read — nothing written. Re-run." in out
    assert "Dry run" not in out
    assert _icons(table) == _BEFORE

    script.main()
    out = capsys.readouterr().out
    assert "'updated': 2" in out
    assert "changed since read" not in out
    assert _icons(table) == {"health": "health", "c-ins": "insurance", "c-pet": "insurance"}
