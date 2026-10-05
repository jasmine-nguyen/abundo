"""Load a one-off script from scripts/migrations/ as a fresh module, for the migration test suites."""

import importlib.util
import pathlib

_MIGRATIONS_DIR = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "migrations"


def load_migration_script(name):
    spec = importlib.util.spec_from_file_location(name, _MIGRATIONS_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def use_fake_table(monkeypatch, script, table):
    """Make the script's boto3.resource(...).Table(...) hand back `table`."""

    class _Resource:
        def Table(self, name):
            return table

    monkeypatch.setattr(script.boto3, "resource", lambda *a, **k: _Resource(), raising=False)
