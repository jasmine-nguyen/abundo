"""WHIT-559 GAPS — set_spread_if_absent, the create-only spread write for rule auto-spread.

The implementer's tests/shared/test_repository_budget.py pins create/never-clobber/no-target/absent/
rollover/strip-rollover/race. This suite adds the seams they did NOT cover:

  * an EMPTY entry ({}) — present but no target — skips (the create needs a target);
  * the written entry gains EXACTLY the spread fields and NO stray marker (e.g. no spread_origin) —
    the stored shape is unchanged from set_spread, and the version bumps by exactly one;
  * a rollover-ON entry that ALSO has a target still skips (rollover XOR spread; don't spread it).

Uses the shared conftest fixtures (`shared`, `config_item_table`) as the sibling suite does.
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


_EXPECTED_SPREAD_KEYS = {
    "target", "spread_amount", "spread_cycles", "spread_from", "spread_len", "spread_paydate"}


def test_set_spread_if_absent_skips_a_present_but_empty_entry(shared, budget_repo, config_item_table):
    table = config_item_table("BUDGETS", items={"insurance": {}})
    before_version = table.item["version"]
    _with_table(budget_repo, table)

    assert budget_repo.set_spread_if_absent("insurance", Decimal("600.00"), 3,
                                            "2026-09-05", 30, "2026-01-01") is None
    assert table.update_calls == 0
    assert table.item["version"] == before_version


def test_set_spread_if_absent_writes_exactly_the_spread_fields_no_stray_marker(
        shared, budget_repo, config_item_table):
    # FAIL-ON-REVERT for the stored shape: the create writes the target + the spread fields and
    # NOTHING else — no spread_origin / provenance marker. Add a stray field to the merged dict in
    # set_spread_if_absent and this reddens on the exact-key-set assert.
    table = config_item_table("BUDGETS", items={"insurance": {"target": Decimal(250)}})
    _with_table(budget_repo, table)

    budget_repo.set_spread_if_absent("insurance", Decimal("600.00"), 3, "2026-09-05", 30, "2026-01-01")

    stored = table.item["items"]["insurance"]
    assert set(stored) == _EXPECTED_SPREAD_KEYS
    assert table.item["version"] == Decimal(2)


def test_set_spread_if_absent_skips_a_rollover_category_that_also_has_a_target(
        shared, budget_repo, config_item_table):
    entry = {"target": Decimal(250), "rollover": True, "carryover": Decimal(50),
             "carryover_from": "2026-08-06", "carryover_len": Decimal(30),
             "carryover_paydate": "2026-01-01"}
    before = dict(entry)
    table = config_item_table("BUDGETS", items={"insurance": entry})
    _with_table(budget_repo, table)

    assert budget_repo.set_spread_if_absent("insurance", Decimal("600.00"), 3,
                                            "2026-09-05", 30, "2026-01-01") is None
    assert table.item["items"]["insurance"] == before
    assert table.update_calls == 0
