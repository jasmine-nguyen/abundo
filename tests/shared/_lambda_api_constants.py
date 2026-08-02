"""Read a constant out of lambda_api/constants.py without importing it (WHIT-393).

`constants` is in the _COLLIDING list in tests/lambda_api/conftest.py — a plain
`import constants` here would poison sys.modules for the suites that import their
own. lambda_api/constants.py has no imports of its own, so exec'ing it into a fresh
namespace is safe, needs no fixture, and can't be masked by a stale .pyc.

Lives in tests/shared because pytest.ini's `pythonpath` makes only that directory
importable by name. Test-only: never staged into the deployed shared layer.
"""

import pathlib

_API_CONSTANTS = pathlib.Path(__file__).resolve().parents[2] / "lambda_api" / "constants.py"


def api_constant(name: str):
    """The named constant's value from lambda_api/constants.py."""
    namespace: dict = {}
    exec(compile(_API_CONSTANTS.read_text(), str(_API_CONSTANTS), "exec"), namespace)
    return namespace[name]
