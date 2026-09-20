"""WHIT-559 rename: the one-off smooth*->spread* rule-row migration.

Drives plan_row + apply against an in-memory FakeTable, seeding RAW pre-rename rows (smooth* keys)
directly into the store as a live table would hold them. Proves the rewrite preserves values
(especially spread_seeded, so a seeded plan is never re-created), is idempotent, and no-ops on an
empty / already-migrated table.
"""

from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable
from _migration_spread_fakes import migration, seed, row


@pytest.fixture
def table():
    return FakeTable()


def test_migrates_a_seeded_spread_rule_and_preserves_the_marker(table):
    # [A1] The load-bearing case: a rule that already seeded its plan carries smooth_seeded=True.
    # After the rename the marker MUST survive as spread_seeded=True, or the apply path would treat
    # the rule as unseeded and re-create a plan the user may have dismissed. FAIL-ON-REVERT: drop
    # the value-preserving carry-over and spread_seeded comes back False/absent.
    seed(table, "RULE#r1", smooth=True, smooth_amount=Decimal("42.50"),
         smooth_gap_days=30, smooth_seeded=True)

    result = migration.run(table, list(table.store.values()))

    r = row(table, "RULE#r1")
    assert result == {"scanned": 1, "migrated": 1}
    assert r["spread"] is True and r["spread_seeded"] is True
    assert r["spread_amount"] == Decimal("42.50") and r["spread_gap_days"] == 30
    assert not any(k.startswith("smooth") for k in r)


def test_migrates_an_unseeded_spread_rule(table):
    # [A2] A spread rule that has not seeded yet keeps spread_seeded=False so a later run still seeds.
    seed(table, "RULE#r1", smooth=True, smooth_amount=Decimal("10"),
         smooth_gap_days=14, smooth_seeded=False)

    migration.run(table, list(table.store.values()))

    r = row(table, "RULE#r1")
    assert r["spread"] is True and r["spread_seeded"] is False
    assert not any(k.startswith("smooth") for k in r)


def test_migrates_a_plain_non_spread_rule(table):
    # [A3] Every rule row carries the flag (smooth=False on a plain rule). The rename cleans it to
    # spread=False and leaves no stale smooth key behind.
    seed(table, "RULE#r1", smooth=False)

    migration.run(table, list(table.store.values()))

    r = row(table, "RULE#r1")
    assert r["spread"] is False and "smooth" not in r


def test_is_idempotent(table):
    # [A4] Safe to run twice: the second pass finds no smooth* keys and rewrites nothing.
    seed(table, "RULE#r1", smooth=True, smooth_amount=Decimal("42.50"),
         smooth_gap_days=30, smooth_seeded=True)

    migration.run(table, list(table.store.values()))
    before = dict(row(table, "RULE#r1"))
    second = migration.run(table, list(table.store.values()))

    assert second == {"scanned": 1, "migrated": 0}
    assert row(table, "RULE#r1") == before


def test_empty_table_is_a_no_op(table):
    # [A5] No rules -> nothing scanned, nothing migrated.
    assert migration.run(table, []) == {"scanned": 0, "migrated": 0}


def test_plan_row_keeps_the_new_value_when_both_keys_exist():
    # [A6] A half-applied row (both old and new present) keeps the NEW value and only drops the stale
    # old key — the newest write wins, never re-seeding from a stale marker.
    plan = migration.plan_row(
        {"smooth_seeded": False, "spread_seeded": True, "smooth": True, "spread": True})
    set_map, remove = plan
    assert "spread_seeded" not in set_map and "spread" not in set_map
    assert set(remove) == {"smooth", "smooth_seeded"}


def test_plan_row_none_when_already_migrated():
    # [A7] A fully-migrated row has no smooth* keys -> no work.
    assert migration.plan_row({"spread": True, "spread_seeded": True}) is None
