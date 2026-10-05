"""Load a one-off script from scripts/migrations/ as a fresh module, for the migration test suites."""

import importlib.util
import pathlib

_MIGRATIONS_DIR = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "migrations"


def load_migration_script(name):
    spec = importlib.util.spec_from_file_location(name, _MIGRATIONS_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
