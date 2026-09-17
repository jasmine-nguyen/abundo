"""Shared helpers for the smooth->spread migration test suites (WHIT-559)."""

import importlib.util
import pathlib

_MOD_PATH = (pathlib.Path(__file__).resolve().parents[2]
             / "scripts" / "migrations" / "rename_rule_smooth_to_spread.py")
_spec = importlib.util.spec_from_file_location("rename_rule_smooth_to_spread", _MOD_PATH)
migration = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migration)


def seed(table, sk, **fields):
    row = {"pk": "RULE", "sk": sk, "field": "description", "operator": "contains",
           "value": "ORIGIN", "category_id": "insurance", **fields}
    table.store[("RULE", sk)] = row


def row(table, sk):
    return table.store[("RULE", sk)]
