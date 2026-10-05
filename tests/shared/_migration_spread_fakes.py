"""Shared helpers for the smooth->spread migration test suites (WHIT-559)."""

from _migration_scripts import load_migration_script

migration = load_migration_script("rename_rule_smooth_to_spread")


def seed(table, sk, **fields):
    row = {"pk": "RULE", "sk": sk, "field": "description", "operator": "contains",
           "value": "ORIGIN", "category_id": "insurance", **fields}
    table.store[("RULE", sk)] = row


def row(table, sk):
    return table.store[("RULE", sk)]
