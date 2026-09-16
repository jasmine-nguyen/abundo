"""WHIT-559 rename: the one-off smooth*->spread* rule-row migration.

Drives the real migration against a RuleRepository backed by an in-memory FakeTable, seeding RAW
pre-rename rows (smooth* keys) directly into the store as a live table would hold them. Proves the
rewrite preserves values (especially spread_seeded, so a seeded plan is never re-created), is
idempotent, and no-ops on an empty / already-migrated table.
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


def test_migrates_a_seeded_spread_rule_and_preserves_the_marker(rule_repo):
    # [A1] The load-bearing case: a rule that already seeded its plan carries smooth_seeded=True.
    # After the rename the marker MUST survive as spread_seeded=True, or the apply path would treat
    # the rule as unseeded and re-create a plan the user may have dismissed. FAIL-ON-REVERT: drop
    # the value-preserving carry-over and spread_seeded comes back False/absent.
    _seed(rule_repo, "RULE#r1", smooth=True, smooth_amount=Decimal("42.50"),
          smooth_gap_days=30, smooth_seeded=True)

    result = migration.migrate(rule_repo)

    row = _row(rule_repo, "RULE#r1")
    assert result == {"scanned": 1, "migrated": 1}
    assert row["spread"] is True and row["spread_seeded"] is True
    assert row["spread_amount"] == Decimal("42.50") and row["spread_gap_days"] == 30
    assert not any(k.startswith("smooth") for k in row)


def test_migrates_an_unseeded_spread_rule(rule_repo):
    # [A2] A spread rule that has not seeded yet keeps spread_seeded=False so a later run still seeds.
    _seed(rule_repo, "RULE#r1", smooth=True, smooth_amount=Decimal("10"),
          smooth_gap_days=14, smooth_seeded=False)

    migration.migrate(rule_repo)

    row = _row(rule_repo, "RULE#r1")
    assert row["spread"] is True and row["spread_seeded"] is False
    assert not any(k.startswith("smooth") for k in row)


def test_migrates_a_plain_non_spread_rule(rule_repo):
    # [A3] Every rule row carries the flag (smooth=False on a plain rule). The rename cleans it to
    # spread=False and leaves no stale smooth key behind.
    _seed(rule_repo, "RULE#r1", smooth=False)

    migration.migrate(rule_repo)

    row = _row(rule_repo, "RULE#r1")
    assert row["spread"] is False and "smooth" not in row


def test_is_idempotent(rule_repo):
    # [A4] Safe to run twice: the second pass finds no smooth* keys and rewrites nothing.
    _seed(rule_repo, "RULE#r1", smooth=True, smooth_amount=Decimal("42.50"),
          smooth_gap_days=30, smooth_seeded=True)

    migration.migrate(rule_repo)
    before = dict(_row(rule_repo, "RULE#r1"))
    second = migration.migrate(rule_repo)

    assert second == {"scanned": 1, "migrated": 0}
    assert _row(rule_repo, "RULE#r1") == before


def test_empty_table_is_a_no_op(rule_repo):
    # [A5] No rules -> nothing scanned, nothing migrated.
    assert migration.migrate(rule_repo) == {"scanned": 0, "migrated": 0}


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
