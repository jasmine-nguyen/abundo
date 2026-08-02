"""Read constants out of a constants.py without importing it (WHIT-393).

Both `constants` modules (shared/ and lambda_api/) are bare top-level names that
collide in sys.modules — `constants` is in the _COLLIDING list in
tests/lambda_api/conftest.py, so whichever suite imported one first would win for
the rest of the pytest process. Neither file imports another project module (only
stdlib), so exec'ing into a fresh namespace has no side effects beyond the file's
own load-time asserts: no sys.modules entry, and no __pycache__ bytecode that could
mask a real drift.

Lives in tests/shared because pytest.ini's `pythonpath` makes only that directory
importable by name. Test-only: never staged into the deployed shared layer.
"""

import pathlib

_API_CONSTANTS = pathlib.Path(__file__).resolve().parents[2] / "lambda_api" / "constants.py"


def constants_namespace(path) -> dict:
    """Exec a constants.py into a fresh namespace and return it."""
    namespace: dict = {}
    exec(compile(path.read_text(), str(path), "exec"), namespace)
    return namespace


def api_constant(name: str):
    """The named constant's value from lambda_api/constants.py."""
    return constants_namespace(_API_CONSTANTS)[name]
