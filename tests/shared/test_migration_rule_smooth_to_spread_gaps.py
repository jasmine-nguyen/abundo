"""WHIT-559 — adversarial gaps for the one-off smooth*->spread* rule-row migration.

Complements test_migration_rule_smooth_to_spread.py (single-row seeded/unseeded/plain/idempotent/
empty/both-keys/already-migrated). Here: MULTI-row mixes + counts, exact type preservation
(Decimal / int), a partial old field set (no `smooth` flag), the REMOVE-only UpdateExpression not
carrying an empty ExpressionAttributeValues, a large batch, and the attribute_exists(pk) guard that
stops a row deleted mid-run from being resurrected. Same import + seeding pattern as the sibling
suite: RAW pre-rename rows go straight into the FakeTable store, migrate() drives the real
RuleRepository.list_rules + update_item.
"""

import importlib.util
import pathlib
from decimal import Decimal

import pytest

_MOD_PATH = (pathlib.Path(__file__).resolve().parents[2]
             / "scripts" / "migrations" / "whit_rename_rule_smooth_to_spread.py")
_spec = importlib.util.spec_from_file_location("whit_rename_rule_smooth_to_spread", _MOD_PATH)
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)


def _seed(repo, sk, **fields):
    row = {"pk": "RULE", "sk": sk, "field": "description", "operator": "contains",
           "value": "ORIGIN", "category_id": "insurance", **fields}
    repo._table.store[("RULE", sk)] = row


def _row(repo, sk):
    return repo._table.store[("RULE", sk)]


def test_mixed_batch_counts_and_each_row_lands_correct(rule_repo):
    # [G1] A single run over a MIX: an old smooth rule, an already-migrated spread row, and a plain
    # non-spread old row. scanned counts every row; migrated counts only rows that carried a smooth*
    # key. Each row must end in its correct final shape.
    _seed(rule_repo, "RULE#old", smooth=True, smooth_amount=Decimal("42.50"),
          smooth_gap_days=30, smooth_seeded=True)                       # migrates
    _seed(rule_repo, "RULE#done", spread=True, spread_amount=Decimal("9"),
          spread_gap_days=14, spread_seeded=False)                      # already migrated -> skip
    _seed(rule_repo, "RULE#plain", smooth=False)                        # migrates (flag rename only)

    result = migration.migrate(rule_repo)

    assert result == {"scanned": 3, "migrated": 2}
    old = _row(rule_repo, "RULE#old")
    assert old["spread"] is True and old["spread_seeded"] is True
    assert old["spread_amount"] == Decimal("42.50") and old["spread_gap_days"] == 30
    assert not any(k.startswith("smooth") for k in old)
    done = _row(rule_repo, "RULE#done")   # untouched, still exactly its migrated shape
    assert done["spread"] is True and done["spread_seeded"] is False
    assert done["spread_amount"] == Decimal("9") and done["spread_gap_days"] == 14
    plain = _row(rule_repo, "RULE#plain")
    assert plain["spread"] is False and "smooth" not in plain


def test_value_types_preserved_exactly_decimal_and_int(rule_repo):
    # [G2] spread_amount must stay a Decimal (cents) and spread_gap_days a plain int — never
    # stringified or float-coerced through the SET write, or downstream cadence->cycles math breaks.
    # FAIL-ON-REVERT: rewriting plan_row to coerce the carried value (e.g. str(row[old])) reddens this.
    _seed(rule_repo, "RULE#r1", smooth=True, smooth_amount=Decimal("42.50"), smooth_gap_days=30,
          smooth_seeded=True)

    migration.migrate(rule_repo)

    row = _row(rule_repo, "RULE#r1")
    assert type(row["spread_amount"]) is Decimal and row["spread_amount"] == Decimal("42.50")
    assert type(row["spread_gap_days"]) is int and row["spread_gap_days"] == 30
    assert not isinstance(row["spread_gap_days"], bool)


def test_partial_old_fields_without_smooth_flag_still_migrate(rule_repo):
    # [G3] A row somehow carrying smooth_amount/smooth_gap_days but no `smooth` flag: the present
    # old keys still migrate, values preserved, and no smooth* key survives. The row simply never
    # gains a `spread` flag (none was there to rename) — the migration touches only present keys.
    _seed(rule_repo, "RULE#r1", smooth_amount=Decimal("7"), smooth_gap_days=21)

    result = migration.migrate(rule_repo)

    row = _row(rule_repo, "RULE#r1")
    assert result == {"scanned": 1, "migrated": 1}
    assert row["spread_amount"] == Decimal("7") and row["spread_gap_days"] == 21
    assert not any(k.startswith("smooth") for k in row)
    assert "spread" not in row


def test_remove_only_update_omits_empty_expression_attribute_values(rule_repo):
    # [G4] Both old+new present -> the new value wins, so plan_row emits an EMPTY set_map and a
    # REMOVE-only UpdateExpression. Real DynamoDB REJECTS an update carrying ExpressionAttributeValues={}
    # ("ExpressionAttributeValues must not be empty"), so the migration must OMIT the key entirely.
    # FAIL-ON-REVERT: making _apply always pass ExpressionAttributeValues reddens the `not in` assert.
    _seed(rule_repo, "RULE#r1", smooth=True, spread=True,
          smooth_seeded=False, spread_seeded=True)

    seen = []
    real_update = rule_repo._table.update_item
    def spy(**kwargs):
        seen.append(kwargs)
        return real_update(**kwargs)
    rule_repo._table.update_item = spy

    migration.migrate(rule_repo)

    assert len(seen) == 1
    kwargs = seen[0]
    assert "REMOVE" in kwargs["UpdateExpression"] and "SET" not in kwargs["UpdateExpression"]
    assert "ExpressionAttributeValues" not in kwargs
    row = _row(rule_repo, "RULE#r1")
    assert row["spread"] is True and row["spread_seeded"] is True   # new value kept, not clobbered
    assert not any(k.startswith("smooth") for k in row)


def test_large_batch_all_rows_migrate(rule_repo):
    # [G5] 50 old rows in one run: every row scanned and migrated, none left with a smooth* key.
    for i in range(50):
        _seed(rule_repo, f"RULE#r{i}", smooth=True, smooth_amount=Decimal(str(i)),
              smooth_gap_days=i + 1, smooth_seeded=bool(i % 2))

    result = migration.migrate(rule_repo)

    assert result == {"scanned": 50, "migrated": 50}
    for i in range(50):
        row = _row(rule_repo, f"RULE#r{i}")
        assert not any(k.startswith("smooth") for k in row)
        assert row["spread"] is True and row["spread_amount"] == Decimal(str(i))
        assert row["spread_gap_days"] == i + 1 and row["spread_seeded"] is bool(i % 2)


def test_apply_skips_a_vanished_row_without_resurrecting_it(rule_repo):
    # [G6] The scan-then-rewrite is not atomic. A rule deleted between the scan and its per-row
    # write must be SKIPPED via the attribute_exists(pk) guard, never upserted back as a keys-only
    # ghost row (no field/operator/value). FAIL-ON-REVERT: drop the ConditionExpression and the
    # update upserts the ghost -> _apply returns True and the key appears in the store.
    applied = migration._apply(rule_repo._table, "RULE", "RULE#gone",
                               {"spread": True}, ["smooth"])
    assert applied is False
    assert ("RULE", "RULE#gone") not in rule_repo._table.store
