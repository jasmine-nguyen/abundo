"""The one-off clean-up that deletes saved bill spread fields from budgets and rules (ABU-91).

Drives ``run(table, budgets_item, rule_rows, dry_run)`` over the in-memory FakeTable, which
applies the script's real REMOVE / condition expressions, so the checks read the stored rows back.
"""

import copy
from decimal import Decimal

import pytest

from _boto_stubs import use_condition_fields
from _dynamo_fakes import FakeTable
from _migration_scripts import load_migration_script

_BUDGETS_KEY = ("BUDGETS", "BUDGETS")

_SPREAD_ENTRY = {
    "target": Decimal(250), "rollover": False,
    "spread_amount": Decimal("1390.91"), "spread_cycles": Decimal(4), "spread_from": "2026-08-06",
    "spread_len": Decimal(31), "spread_paydate": "2026-01-01",
}
_ROLLOVER_ENTRY = {
    "target": Decimal(100), "rollover": True, "carryover": Decimal(300),
    "carryover_from": "2026-08-06", "carryover_len": Decimal(31), "carryover_paydate": "2026-01-01",
}
_SPREAD_RULE = {
    "pk": "RULE", "sk": "RULE#r1", "id": "r1", "field": "description", "operator": "contains",
    "value": "rent", "category_id": "rent", "budget_excluded": False,
    "spread": True, "spread_amount": Decimal("1390.91"), "spread_gap_days": Decimal(30),
    "spread_seeded": "2026-08-06",
}
_PLAIN_RULE = {
    "pk": "RULE", "sk": "RULE#r2", "id": "r2", "field": "description", "operator": "contains",
    "value": "coffee", "category_id": "cafe", "spread": False,
}


def _strip(row, *fields):
    return {k: v for k, v in row.items() if k not in fields}


def _seeded_table():
    table = FakeTable()
    table.seed(
        {"pk": "BUDGETS", "sk": "BUDGETS", "version": Decimal(7),
         "items": {"bill": copy.deepcopy(_SPREAD_ENTRY), "sink": copy.deepcopy(_ROLLOVER_ENTRY)}},
        copy.deepcopy(_SPREAD_RULE),
        copy.deepcopy(_PLAIN_RULE),
    )
    return table


def _run(script, table, dry_run):
    rules = [row for key, row in table.store.items() if row["pk"] == "RULE"]
    return script.run(table, copy.deepcopy(table.store[_BUDGETS_KEY]), copy.deepcopy(rules), dry_run=dry_run)


@pytest.fixture
def script():
    with use_condition_fields():
        yield load_migration_script("remove_bill_spread_data")


def test_clean_up_removes_only_spread_fields_after_a_dry_run_and_is_safe_to_run_twice(script):
    table = _seeded_table()
    before = copy.deepcopy(table.store)

    preview = _run(script, table, dry_run=True)
    assert table.update_calls == []
    assert table.store == before
    assert preview["budgets_found"] == 1
    assert preview["rules_found"] == 2

    applied = _run(script, table, dry_run=False)
    budgets = table.store[_BUDGETS_KEY]
    assert budgets["items"]["bill"] == {"target": Decimal(250), "rollover": False}
    assert budgets["items"]["sink"] == _ROLLOVER_ENTRY
    assert budgets["version"] == Decimal(8)
    assert table.store[("RULE", "RULE#r1")] == _strip(
        _SPREAD_RULE, "spread", "spread_amount", "spread_gap_days", "spread_seeded")
    assert table.store[("RULE", "RULE#r2")] == _strip(_PLAIN_RULE, "spread")
    assert applied == {"budgets_found": 1, "budgets_cleaned": 1,
                       "rules_found": 2, "rules_cleaned": 2, "skipped": 0}

    writes = len(table.update_calls)
    again = _run(script, table, dry_run=False)
    assert len(table.update_calls) == writes
    assert again == {"budgets_found": 0, "budgets_cleaned": 0,
                     "rules_found": 0, "rules_cleaned": 0, "skipped": 0}


def test_a_lost_conditional_write_is_skipped_and_the_run_carries_on(script, client_error):
    table = _seeded_table()
    table.fail("update_item", error=client_error("ConditionalCheckFailedException"),
               when=lambda key: key["pk"] == "BUDGETS")

    result = _run(script, table, dry_run=False)

    assert result == {"budgets_found": 1, "budgets_cleaned": 0,
                      "rules_found": 2, "rules_cleaned": 2, "skipped": 1}
    assert "spread_amount" in table.store[_BUDGETS_KEY]["items"]["bill"]
    assert "spread" not in table.store[("RULE", "RULE#r1")]


def _two_spread_table():
    table = _seeded_table()
    table.store[_BUDGETS_KEY]["items"]["gym"] = copy.deepcopy(_SPREAD_ENTRY)
    return table


def test_every_spread_budget_in_one_run_is_cleaned_with_the_version_tracked_locally(script):
    # [A1] Two spread entries in the one BUDGETS item: the second write must expect the version
    # the first one saved, or it is refused and the entry left behind.
    table = _two_spread_table()

    result = _run(script, table, dry_run=False)

    budgets = table.store[_BUDGETS_KEY]
    assert budgets["items"]["bill"] == {"target": Decimal(250), "rollover": False}
    assert budgets["items"]["gym"] == {"target": Decimal(250), "rollover": False}
    assert budgets["version"] == Decimal(9)
    assert (result["budgets_cleaned"], result["skipped"]) == (2, 0)


def test_a_budget_edit_during_the_run_skips_the_rest_and_a_re_run_finishes_the_job(script):
    # [A2] Someone saves a budget just before the first clean-up write: that write and every
    # later budget write in the run are refused (the tracked version is stale), nothing is
    # half-written, rules still go, and the next run picks the budgets up.
    table = _two_spread_table()
    table.race_next_update()

    first = _run(script, table, dry_run=False)

    assert first == {"budgets_found": 2, "budgets_cleaned": 0,
                     "rules_found": 2, "rules_cleaned": 2, "skipped": 2}
    assert table.store[_BUDGETS_KEY]["items"]["bill"] == _SPREAD_ENTRY
    assert table.store[_BUDGETS_KEY]["items"]["gym"] == _SPREAD_ENTRY

    second = _run(script, table, dry_run=False)

    assert (second["budgets_cleaned"], second["skipped"]) == (2, 0)
    assert "spread_amount" not in table.store[_BUDGETS_KEY]["items"]["gym"]


def test_main_previews_by_default_and_apply_cleans_rules_across_every_page(script, monkeypatch, capsys):
    # [A3] The command Jas runs: no flag → nothing saved and the dry-run line printed; --apply →
    # saved. Rule rows are read a page at a time, so a rule past the first page is cleaned too.
    table = _seeded_table()
    table.seed({**copy.deepcopy(_PLAIN_RULE), "sk": "RULE#r3", "id": "r3"})
    table.page_size = 1
    monkeypatch.setattr(script.boto3, "resource", lambda *a, **k: type("R", (), {"Table": lambda self, name: table})())

    monkeypatch.setattr(script.sys, "argv", ["remove_bill_spread_data.py"])
    script.main()
    assert table.update_calls == []
    assert "Dry run — nothing saved. Re-run with --apply to save." in capsys.readouterr().out

    monkeypatch.setattr(script.sys, "argv", ["remove_bill_spread_data.py", "--apply"])
    script.main()
    rules = [row for key, row in table.store.items() if key[0] == "RULE"]
    assert len(rules) == 3
    assert not [field for row in rules for field in row if field.startswith("spread")]
    assert "spread_amount" not in table.store[_BUDGETS_KEY]["items"]["bill"]
    assert "Dry run" not in capsys.readouterr().out
