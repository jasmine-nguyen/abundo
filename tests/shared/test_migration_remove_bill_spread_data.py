"""The one-off clean-up that deletes saved bill spread fields from budgets and rules (ABU-91).

Drives ``run(table, budgets_item, rule_rows, dry_run)`` over the in-memory FakeTable, which
applies the script's real REMOVE / condition expressions, so the checks read the stored rows back.
"""

import copy
from decimal import Decimal

import pytest

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
    return load_migration_script("remove_bill_spread_data")


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
