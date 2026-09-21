"""WHIT-559 — adversarial gaps for the one-off smooth*->spread* rule-row migration.

Complements test_migration_rule_smooth_to_spread.py (single-row seeded/unseeded/plain/idempotent/
empty/both-keys/already-migrated). Here: MULTI-row mixes + counts, exact type preservation
(Decimal / int), a partial old field set (no `smooth` flag), the REMOVE-only UpdateExpression not
carrying an empty ExpressionAttributeValues, a large batch, and the attribute_exists(pk) guard that
stops a row deleted mid-run from being resurrected.
"""

from decimal import Decimal

import pytest

from _dynamo_fakes import FakeTable
from _migration_spread_fakes import migration, seed, row


@pytest.fixture
def table():
    return FakeTable()


def test_mixed_batch_counts_and_each_row_lands_correct(table):
    # [G1] A single run over a MIX: an old smooth rule, an already-migrated spread row, and a plain
    # non-spread old row. scanned counts every row; migrated counts only rows that carried a smooth*
    # key. Each row must end in its correct final shape.
    seed(table, "RULE#old", smooth=True, smooth_amount=Decimal("42.50"),
         smooth_gap_days=30, smooth_seeded=True)                       # migrates
    seed(table, "RULE#done", spread=True, spread_amount=Decimal("9"),
         spread_gap_days=14, spread_seeded=False)                      # already migrated -> skip
    seed(table, "RULE#plain", smooth=False)                            # migrates (flag rename only)

    result = migration.run(table, list(table.store.values()))

    assert result == {"scanned": 3, "migrated": 2}
    old = row(table, "RULE#old")
    assert old["spread"] is True and old["spread_seeded"] is True
    assert old["spread_amount"] == Decimal("42.50") and old["spread_gap_days"] == 30
    assert not any(k.startswith("smooth") for k in old)
    done = row(table, "RULE#done")   # untouched, still exactly its migrated shape
    assert done["spread"] is True and done["spread_seeded"] is False
    assert done["spread_amount"] == Decimal("9") and done["spread_gap_days"] == 14
    plain = row(table, "RULE#plain")
    assert plain["spread"] is False and "smooth" not in plain


def test_value_types_preserved_exactly_decimal_and_int(table):
    # [G2] spread_amount must stay a Decimal (cents) and spread_gap_days a plain int — never
    # stringified or float-coerced through the SET write, or downstream cadence->cycles math breaks.
    # FAIL-ON-REVERT: rewriting plan_row to coerce the carried value (e.g. str(row[old])) reddens this.
    seed(table, "RULE#r1", smooth=True, smooth_amount=Decimal("42.50"), smooth_gap_days=30,
         smooth_seeded=True)

    migration.run(table, list(table.store.values()))

    r = row(table, "RULE#r1")
    assert type(r["spread_amount"]) is Decimal and r["spread_amount"] == Decimal("42.50")
    assert type(r["spread_gap_days"]) is int and r["spread_gap_days"] == 30
    assert not isinstance(r["spread_gap_days"], bool)


def test_partial_old_fields_without_smooth_flag_still_migrate(table):
    # [G3] A row somehow carrying smooth_amount/smooth_gap_days but no `smooth` flag: the present
    # old keys still migrate, values preserved, and no smooth* key survives. The row simply never
    # gains a `spread` flag (none was there to rename) — the migration touches only present keys.
    seed(table, "RULE#r1", smooth_amount=Decimal("7"), smooth_gap_days=21)

    result = migration.run(table, list(table.store.values()))

    r = row(table, "RULE#r1")
    assert result == {"scanned": 1, "migrated": 1}
    assert r["spread_amount"] == Decimal("7") and r["spread_gap_days"] == 21
    assert not any(k.startswith("smooth") for k in r)
    assert "spread" not in r


def test_remove_only_update_omits_empty_expression_attribute_values(table):
    # [G4] Both old+new present -> the new value wins, so plan_row emits an EMPTY set_map and a
    # REMOVE-only UpdateExpression. Real DynamoDB REJECTS an update carrying ExpressionAttributeValues={}
    # ("ExpressionAttributeValues must not be empty"), so the migration must OMIT the key entirely.
    # FAIL-ON-REVERT: making apply always pass ExpressionAttributeValues reddens the `not in` assert.
    seed(table, "RULE#r1", smooth=True, spread=True,
         smooth_seeded=False, spread_seeded=True)

    seen = []
    real_update = table.update_item

    def spy(**kwargs):
        seen.append(kwargs)
        return real_update(**kwargs)

    table.update_item = spy

    migration.run(table, list(table.store.values()))

    assert len(seen) == 1
    kwargs = seen[0]
    assert "REMOVE" in kwargs["UpdateExpression"] and "SET" not in kwargs["UpdateExpression"]
    assert "ExpressionAttributeValues" not in kwargs
    r = row(table, "RULE#r1")
    assert r["spread"] is True and r["spread_seeded"] is True   # new value kept, not clobbered
    assert not any(k.startswith("smooth") for k in r)


def test_large_batch_all_rows_migrate(table):
    # [G5] 50 old rows in one run: every row scanned and migrated, none left with a smooth* key.
    for i in range(50):
        seed(table, f"RULE#r{i}", smooth=True, smooth_amount=Decimal(str(i)),
             smooth_gap_days=i + 1, smooth_seeded=bool(i % 2))

    result = migration.run(table, list(table.store.values()))

    assert result == {"scanned": 50, "migrated": 50}
    for i in range(50):
        r = row(table, f"RULE#r{i}")
        assert not any(k.startswith("smooth") for k in r)
        assert r["spread"] is True and r["spread_amount"] == Decimal(str(i))
        assert r["spread_gap_days"] == i + 1 and r["spread_seeded"] is bool(i % 2)


def test_apply_skips_a_vanished_row_without_resurrecting_it(table):
    # [G6] The scan-then-rewrite is not atomic. A rule deleted between the scan and its per-row
    # write must be SKIPPED via the attribute_exists(pk) guard, never upserted back as a keys-only
    # ghost row (no field/operator/value). FAIL-ON-REVERT: drop the ConditionExpression and the
    # update upserts the ghost -> apply returns True and the key appears in the store.
    applied = migration.apply(table, "RULE#gone",
                              {"spread": True}, ["smooth"])
    assert applied is False
    assert ("RULE", "RULE#gone") not in table.store


def test_migration_does_not_count_a_row_that_vanished_mid_run(table):
    # [G7] End-to-end coupling: the scan finds a row, but it is gone by the time apply runs.
    # The scan counts it, but it is NOT counted as migrated. Locks the `if apply(...)` wiring
    # in run(), not just apply in isolation.
    # FAIL-ON-REVERT: `apply(...); migrated += 1` (unconditional) in run() reddens this.
    phantom = {"pk": "RULE", "sk": "RULE#gone", "field": "description", "operator": "contains",
               "value": "ORIGIN", "category_id": "insurance", "smooth": True, "smooth_seeded": True}

    assert migration.run(table, [dict(phantom)]) == {"scanned": 1, "migrated": 0}
    assert ("RULE", "RULE#gone") not in table.store
