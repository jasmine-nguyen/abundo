"""Read constants out of a constants file without importing it (WHIT-393).

Importing would register a bare `constants` / `api_constants` module that the
lambda_api conftest re-imports fresh per test (its _COLLIDING list). Neither file
imports another project module (only stdlib), so exec'ing into a fresh namespace has
no side effects beyond the file's own load-time asserts: no sys.modules entry, and
no __pycache__ bytecode that could mask a real drift.

Lives in tests/shared because pytest.ini's `pythonpath` makes only that directory
importable by name. Test-only: never staged into the deployed shared layer.
"""

import pathlib

_API_CONSTANTS = pathlib.Path(__file__).resolve().parents[2] / "lambda_api" / "api_constants.py"


def constants_namespace(path) -> dict:
    """Exec a constants file into a fresh namespace and return it."""
    namespace: dict = {}
    exec(compile(path.read_text(), str(path), "exec"), namespace)
    return namespace


def api_constant(name: str):
    """The named constant's value from lambda_api/api_constants.py."""
    return constants_namespace(_API_CONSTANTS)[name]
