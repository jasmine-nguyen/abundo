"""WHIT-581 — lambda_api never reuses a shared module name, and each constant has one home.

The deployed API puts lambda_api/ ahead of the shared layer on the import path, so a
lambda_api module with a shared module's name silently replaces it. That is how the old
lambda_api/constants.py forced every shared constant to be mirrored by hand. These checks
are static (nothing is imported):

  [G1] no module name is both a lambda_api module and a shared module/package
  [G2] no constant is defined in both api_constants.py and shared/constants.py
  [G3] every name a lambda_api module imports from either constants file exists there

Fail-on-revert: re-add constants.py to LAMBDA_API_SOURCES (or create lambda_api/constants.py)
-> G1 reddens; re-add a mirror such as MAX_PAGE_SIZE to api_constants.py -> G2 reddens.
"""

import ast
import pathlib
import re

from _lambda_api_constants import constants_namespace

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_LAMBDA_API = _ROOT / "lambda_api"
_SHARED = _ROOT / "shared"
_BUILD_SCRIPT = _ROOT / "scripts" / "build_terraform_artifacts.sh"
_ALLOWLIST = re.compile(r"^LAMBDA_API_SOURCES=\(([^)]*)\)", re.MULTILINE)
_CONSTANT_FILES = {
    "constants": _SHARED / "constants.py",
    "api_constants": _LAMBDA_API / "api_constants.py",
}


def _lambda_api_names() -> set[str]:
    match = _ALLOWLIST.search(_BUILD_SCRIPT.read_text())
    assert match, "LAMBDA_API_SOURCES is no longer a single-line bash array in the build script"
    shipped = {pathlib.Path(name).stem for name in match.group(1).split()}
    # On disk too: tests put lambda_api/ first on the import path, so a stray file changes them.
    on_disk = {path.stem for path in _LAMBDA_API.glob("*.py")}
    return shipped | on_disk


def _shared_names() -> set[str]:
    modules = {path.stem for path in _SHARED.glob("*.py")}
    packages = {
        path.name for path in _SHARED.iterdir()
        if path.is_dir() and path.name not in ("__pycache__", "tests")
    }
    return modules | packages


def _uppercase_names(path: pathlib.Path) -> set[str]:
    return {name for name in constants_namespace(path) if name.isupper()}


def test_the_scans_find_real_names():
    # Guards a vacuous pass: an empty scan would make every check below trivially green.
    assert "constants" in _shared_names()
    assert "handler" in _lambda_api_names()
    assert "api_constants" in _lambda_api_names()
    assert _uppercase_names(_CONSTANT_FILES["constants"])
    assert _uppercase_names(_CONSTANT_FILES["api_constants"])


def test_no_lambda_api_module_shares_a_name_with_a_shared_module():
    # [G1]
    clashes = sorted(_lambda_api_names() & _shared_names())
    assert clashes == [], (
        f"lambda_api modules {clashes} have the same name as a shared module — at runtime the "
        "lambda_api copy silently replaces the shared one. Rename the lambda_api file."
    )


def test_no_constant_is_defined_in_both_constants_files():
    # [G2]
    both = sorted(
        _uppercase_names(_CONSTANT_FILES["api_constants"]) & _uppercase_names(_CONSTANT_FILES["constants"])
    )
    assert both == [], (
        f"{both} are defined in both lambda_api/api_constants.py and shared/constants.py. "
        "API-only constants go in api_constants.py; anything else only in shared/constants.py."
    )


def test_every_constants_import_resolves_in_its_file():
    # [G3] Catches a name left on the wrong side of the split, a bare `import constants`, and `*`.
    defined = {module: _uppercase_names(path) for module, path in _CONSTANT_FILES.items()}
    problems = []
    for path in sorted(_LAMBDA_API.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                problems += [
                    f"{path.name}: `import {alias.name}`"
                    for alias in node.names if alias.name in defined
                ]
            if not isinstance(node, ast.ImportFrom) or node.module not in defined:
                continue
            for alias in node.names:
                if alias.name not in defined[node.module]:
                    problems.append(f"{path.name}: `from {node.module} import {alias.name}`")
    assert problems == [], "constants imports that don't resolve in their file: " + "; ".join(problems)
