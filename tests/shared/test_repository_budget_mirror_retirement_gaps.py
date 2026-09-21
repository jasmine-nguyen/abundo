"""WHIT-551 — adversarial GAP tests for the unified-buffer mirror retirement.

The mirror code (_unified_mirror, _with_mirror, _BUFFER_FIELDS, _PAYBACK_FIELDS,
backfill_unified) is deleted. These tests pin the consequences for entries that
still carry orphan mirror keys in the database:

  1. Writes carry orphan mirror keys through harmlessly (no crash, no corruption
     of the old fields).
  2. clear_rollover / clear_spread no longer strip the orphan mirror keys (they
     are not in the strip tuples anymore). The orphan keys survive as inert data.
  3. Switching from spread to rollover (or vice versa) on an entry with orphan
     mirror keys does not interfere with the drop logic for the OLD fields.
  4. A delete still removes the whole entry, orphan keys included.

These are regression guards for the retirement: if someone re-adds mirror stripping
or breaks the merge for entries with extra keys, these fail.

Fixtures: shared, budget_repo, config_item_table, _with_table — per the
tests/shared/conftest.py + test_repository_budget.py pattern.
"""

from decimal import Decimal

import pytest


@pytest.fixture
def budget_repo(shared):
    r = shared.budget.BudgetRepository()
    r._table = None
    return r


def _with_table(budget_repo, table):
    budget_repo._table = table
    return budget_repo


# ─── helpers: entries with orphan mirror keys from the old dual-write era ───


def _rollover_entry_with_orphan_buffer():
    return {
        "target": Decimal(250),
        "rollover": True,
        "carryover": Decimal("50"),
        "carryover_from": "2026-07-01",
        "carryover_len": Decimal(14),
        "carryover_paydate": "2026-07-01",
        "buffer": Decimal("50"),
        "buffer_from": "2026-07-01",
        "buffer_len": Decimal(14),
        "buffer_paydate": "2026-07-01",
    }


def _spread_entry_with_orphan_payback():
    return {
        "target": Decimal(250),
        "spread_amount": Decimal("1390.91"),
        "spread_cycles": Decimal(4),
        "spread_from": "2026-08-06",
        "spread_len": Decimal(30),
        "spread_paydate": "2026-01-01",
        "payback_amount": Decimal("1390.91"),
        "payback_cycles": Decimal(4),
        "payback_from": "2026-08-06",
        "payback_len": Decimal(30),
        "payback_paydate": "2026-01-01",
    }


def test_set_budget_amount_edit_carries_orphan_buffer_keys_through(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": _rollover_entry_with_orphan_buffer()})
    _with_table(budget_repo, table)

    budget_repo.set_budget("groceries", Decimal(300))

    entry = table.item["items"]["groceries"]
    assert entry["target"] == Decimal(300)
    assert entry["rollover"] is True
    assert entry["carryover"] == Decimal("50")
    assert entry["buffer"] == Decimal("50")
    assert entry["buffer_from"] == "2026-07-01"


def test_set_budget_amount_edit_carries_orphan_payback_keys_through(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"insurance": _spread_entry_with_orphan_payback()})
    _with_table(budget_repo, table)

    budget_repo.set_budget("insurance", Decimal(300))

    entry = table.item["items"]["insurance"]
    assert entry["target"] == Decimal(300)
    assert entry["spread_amount"] == Decimal("1390.91")
    assert entry["payback_amount"] == Decimal("1390.91")


def test_clear_rollover_does_not_strip_orphan_buffer_keys(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": _rollover_entry_with_orphan_buffer()})
    _with_table(budget_repo, table)

    budget_repo.clear_rollover("groceries")

    entry = table.item["items"]["groceries"]
    assert entry["target"] == Decimal(250)
    assert "rollover" not in entry
    assert "carryover" not in entry
    assert "carryover_from" not in entry
    assert entry["buffer"] == Decimal("50")
    assert entry["buffer_from"] == "2026-07-01"
    assert entry["buffer_len"] == Decimal(14)
    assert entry["buffer_paydate"] == "2026-07-01"
    assert table.update_calls == 1


def test_clear_spread_does_not_strip_orphan_payback_keys(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"insurance": _spread_entry_with_orphan_payback()})
    _with_table(budget_repo, table)

    budget_repo.clear_spread("insurance")

    entry = table.item["items"]["insurance"]
    assert entry["target"] == Decimal(250)
    assert "spread_amount" not in entry
    assert "spread_cycles" not in entry
    assert entry["payback_amount"] == Decimal("1390.91")
    assert entry["payback_cycles"] == Decimal(4)
    assert entry["payback_from"] == "2026-08-06"
    assert entry["payback_len"] == Decimal(30)
    assert entry["payback_paydate"] == "2026-01-01"
    assert table.update_calls == 1


def test_settle_carryover_does_not_update_orphan_buffer(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": _rollover_entry_with_orphan_buffer()})
    _with_table(budget_repo, table)

    budget_repo.settle_carryover("groceries", Decimal("-100.50"), "2026-08-01", 30, "2026-08-01")

    entry = table.item["items"]["groceries"]
    assert entry["carryover"] == Decimal("-100.50")
    assert entry["carryover_from"] == "2026-08-01"
    assert entry["buffer"] == Decimal("50")


def test_set_budget_rollover_on_strips_spread_but_orphan_payback_survives(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"insurance": _spread_entry_with_orphan_payback()})
    _with_table(budget_repo, table)
    anchor = {"carryover_from": "2026-08-06", "carryover_len": Decimal(30), "carryover_paydate": "2026-01-01"}

    budget_repo.set_budget("insurance", Decimal(250), rollover=True, anchor=anchor)

    entry = table.item["items"]["insurance"]
    assert entry["rollover"] is True
    assert entry["carryover_from"] == "2026-08-06"
    assert "spread_amount" not in entry
    assert "spread_cycles" not in entry
    assert "spread_from" not in entry
    assert entry["payback_amount"] == Decimal("1390.91")
    assert entry["payback_cycles"] == Decimal(4)


def test_set_spread_strips_rollover_but_orphan_buffer_survives(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": _rollover_entry_with_orphan_buffer()})
    _with_table(budget_repo, table)

    budget_repo.set_spread("groceries", Decimal("100.00"), 2, "2026-09-01", 30, "2026-09-01")

    entry = table.item["items"]["groceries"]
    assert entry["spread_amount"] == Decimal("100.00")
    assert entry["target"] == Decimal(250)
    assert "rollover" not in entry
    assert "carryover" not in entry
    assert "carryover_from" not in entry
    assert entry["buffer"] == Decimal("50")
    assert entry["buffer_from"] == "2026-07-01"


def test_delete_budget_drops_entry_with_orphan_mirror_keys(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={
        "groceries": _rollover_entry_with_orphan_buffer(),
        "food": {"target": Decimal(80)},
    })
    _with_table(budget_repo, table)

    budget_repo.delete_budget("groceries")

    assert "groceries" not in table.item["items"]
    assert table.item["items"]["food"] == {"target": Decimal(80)}


def test_merge_entry_handles_corrupt_entry_with_both_mirror_families(shared, budget_repo, config_item_table):
    corrupt = {
        "target": Decimal(250),
        "rollover": True,
        "carryover": Decimal("50"),
        "buffer": Decimal("50"),
        "buffer_from": "2026-07-01",
        "payback_amount": Decimal("1390.91"),
        "payback_cycles": Decimal(4),
    }
    table = config_item_table("BUDGETS", items={"mixed": corrupt})
    _with_table(budget_repo, table)

    budget_repo.set_budget("mixed", Decimal(300))

    entry = table.item["items"]["mixed"]
    assert entry["target"] == Decimal(300)
    assert entry["rollover"] is True
    assert entry["carryover"] == Decimal("50")
    assert entry["buffer"] == Decimal("50")
    assert entry["payback_amount"] == Decimal("1390.91")


def test_list_budgets_returns_entries_with_orphan_mirror_keys(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"groceries": _rollover_entry_with_orphan_buffer()})
    _with_table(budget_repo, table)

    result = budget_repo.list_budgets()

    assert "groceries" in result
    assert result["groceries"]["target"] == Decimal(250)
    assert result["groceries"]["buffer"] == Decimal("50")


def test_set_spread_on_entry_with_orphan_buffer_from_cleared_rollover(shared, budget_repo, config_item_table):
    entry_after_clear = {
        "target": Decimal(250),
        "buffer": Decimal("50"),
        "buffer_from": "2026-07-01",
    }
    table = config_item_table("BUDGETS", items={"groceries": entry_after_clear})
    _with_table(budget_repo, table)

    budget_repo.set_spread("groceries", Decimal("200.00"), 3, "2026-09-01", 14, "2026-09-01")

    entry = table.item["items"]["groceries"]
    assert entry["spread_amount"] == Decimal("200.00")
    assert entry["spread_cycles"] == Decimal(3)
    assert entry["target"] == Decimal(250)
    assert entry["buffer"] == Decimal("50")
    assert entry["buffer_from"] == "2026-07-01"


def test_no_mirror_field_names_in_strip_tuples(shared):
    mirror_field_names = {
        "buffer", "buffer_from", "buffer_len", "buffer_paydate",
        "payback_amount", "payback_cycles", "payback_from", "payback_len", "payback_paydate",
    }
    rollover_set = set(shared.budget._ROLLOVER_FIELDS)
    spread_set = set(shared.budget._SPREAD_FIELDS)
    assert not rollover_set & mirror_field_names, f"mirror fields leaked into _ROLLOVER_FIELDS: {rollover_set & mirror_field_names}"
    assert not spread_set & mirror_field_names, f"mirror fields leaked into _SPREAD_FIELDS: {spread_set & mirror_field_names}"


def test_xor_drop_still_correct_when_orphan_mirror_keys_present(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"cat": _spread_entry_with_orphan_payback()})
    _with_table(budget_repo, table)
    anchor = {"carryover_from": "2026-09-01", "carryover_len": Decimal(14), "carryover_paydate": "2026-09-01"}

    budget_repo.set_budget("cat", Decimal(250), rollover=True, anchor=anchor)
    entry = table.item["items"]["cat"]

    assert entry["rollover"] is True
    assert entry["carryover_from"] == "2026-09-01"
    for f in shared.budget._SPREAD_FIELDS:
        assert f not in entry, f"spread field {f} should have been dropped"
    assert "payback_amount" in entry

    budget_repo.set_spread("cat", Decimal("500.00"), 2, "2026-09-15", 14, "2026-09-15")
    entry2 = table.item["items"]["cat"]

    for f in shared.budget._ROLLOVER_FIELDS:
        assert f not in entry2, f"rollover field {f} should have been dropped"
    assert entry2["spread_amount"] == Decimal("500.00")
    assert entry2["payback_amount"] == Decimal("1390.91")
