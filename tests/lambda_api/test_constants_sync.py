"""WHIT-136: guard that lambda_api/constants.py stays in sync with the shared layer.

lambda_api/ ships its OWN constants.py that shadows the shared layer at runtime
(terraform/lambda.tf copies it into the function dir, which wins over /opt/python).
The layer's shared modules do `from constants import ...` at module load, and
lambda_api loads them (its handler imports the `repository` facade, which pulls in
every repository_* module). So every name those modules import from `constants`
must ALSO exist — with the same value — in lambda_api/constants.py, or the deployed
lambda_api 500s at import.

This happened in WHIT-54: a new DEAD_LETTER_TTL_SECONDS in shared/constants.py,
imported by repository_transaction, was missing from lambda_api/constants.py and
surfaced only as 239 cryptic import errors. This test fails fast instead, naming
the missing/mismatched constant.
"""

import ast
import pathlib

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SHARED_DIR = _ROOT / "shared"
_API_CONSTANTS = _ROOT / "lambda_api" / "constants.py"


def _constants_namespace(path):
    """Exec a constants.py into a fresh namespace and return it.

    Compiles the source directly rather than importing it, so (a) the two bare
    `constants` modules can't collide in sys.modules, and (b) no __pycache__
    bytecode is ever consulted — a stale .pyc can't mask a real drift."""
    namespace: dict = {}
    exec(compile(path.read_text(), str(path), "exec"), namespace)
    return namespace


def _names_imported_from_constants(py_path):
    """Every name a module pulls via `from constants import ...` (any depth).

    The guard can only enumerate names through the `from constants import <names>`
    form, so it rejects the two styles that would defeat that enumeration silently
    — `from constants import *` and `import constants[/ as c]` + attribute access —
    reintroducing the exact WHIT-54 blind spot. No shared module uses either today;
    the asserts keep it that way.
    """
    tree = ast.parse(py_path.read_text())
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert alias.name != "constants", (
                    f"{py_path.name} uses `import constants` — the sync guard only "
                    "sees `from constants import <names>`; use that form so the names "
                    "it needs stay enumerable"
                )
        elif isinstance(node, ast.ImportFrom) and node.module == "constants":
            for alias in node.names:
                assert alias.name != "*", (
                    f"{py_path.name} uses `from constants import *` — the sync guard "
                    "can't enumerate names through a star import"
                )
                names.add(alias.name)
    return names


def _needed_constant_names():
    """The union of constants every shared module (bar constants.py itself) imports.
    lambda_api loads them all transitively via the `repository` facade, so each name
    must resolve against the shadowing lambda_api/constants.py at runtime."""
    needed = set()
    for py_path in sorted(_SHARED_DIR.glob("*.py")):
        if py_path.name == "constants.py":
            continue
        needed |= _names_imported_from_constants(py_path)
    return needed


def test_lambda_api_constants_cover_what_the_shared_layer_imports():
    needed = _needed_constant_names()
    # Sanity: the scan found something (guards against a silently-empty guard, e.g.
    # if the shared layout changed and this test stopped seeing any imports).
    assert needed, "expected the shared layer to import at least one constant"

    api = _constants_namespace(_API_CONSTANTS)
    missing = sorted(n for n in needed if n not in api)
    assert not missing, (
        "lambda_api/constants.py is missing constants the shared layer imports at "
        f"load — the deployed API lambda would 500 on import: {missing}"
    )


def test_lambda_api_constants_have_the_same_values_as_shared():
    needed = _needed_constant_names()
    shared = _constants_namespace(_SHARED_DIR / "constants.py")
    api = _constants_namespace(_API_CONSTANTS)

    mismatched = {
        n: {"shared": shared[n], "lambda_api": api[n]}
        for n in sorted(needed)
        if n in api and n in shared and api[n] != shared[n]
    }
    assert not mismatched, (
        "lambda_api/constants.py has drifted from shared/constants.py: " + str(mismatched)
    )
