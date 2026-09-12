"""Every lambda_api module the handler imports must actually be SHIPPED.

Same class of miss as the WHIT-506 route that terraform never declared: the code is perfect and
the deploy is broken. `scripts/build_terraform_artifacts.sh` copies a hand-written allowlist
(LAMBDA_API_SOURCES) into the deployment bundle — a NEW sibling module left off it is silently
dropped, and `from merchant_groups import ...` then raises ImportError at cold start. That takes out
EVERY route on the API, not just the new one.

scripts/tests/build_artifacts_test.sh already checks the allowlist agrees with .gitignore and
that nothing extra ships — but a module missing from BOTH lists passes both of those, because
the two lists agree by omission. Nothing checked the allowlist against what the handler actually
imports. This does.

Static: reads the files, imports nothing (the handler needs env + boto3 at load).
"""

import ast
import pathlib
import re

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_LAMBDA_API = _REPO_ROOT / "lambda_api"
_HANDLER = _LAMBDA_API / "handler.py"
_BUILD_SCRIPT = _REPO_ROOT / "scripts" / "build_terraform_artifacts.sh"

# The allowlist is deliberately kept on ONE line (build_artifacts_test.sh parses it literally).
_ALLOWLIST = re.compile(r"^LAMBDA_API_SOURCES=\(([^)]*)\)", re.MULTILINE)


def _allowlisted_sources() -> set[str]:
    match = _ALLOWLIST.search(_BUILD_SCRIPT.read_text())
    assert match, "LAMBDA_API_SOURCES is no longer a single-line bash array in the build script"
    return set(match.group(1).split())


def _handler_local_module_imports() -> set[str]:
    """Bare module names the handler imports that resolve to a lambda_api/<name>.py sibling.

    Everything else it imports comes from the shared layer (staged separately) or the stdlib.
    """
    tree = ast.parse(_HANDLER.read_text())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imported.add(node.module.split(".")[0])
    return {name for name in imported if (_LAMBDA_API / f"{name}.py").exists()}


def test_the_scan_finds_real_modules_on_both_sides():
    # Guards a vacuous pass: if either parser stops matching, the comparison below is empty
    # and would "pass" while checking nothing.
    local_imports = _handler_local_module_imports()
    allowlist = _allowlisted_sources()
    assert "constants" in local_imports and "banksync_enrichments" in local_imports
    assert "handler.py" in allowlist and len(allowlist) > 3


def test_every_lambda_api_module_the_handler_imports_is_in_the_deploy_allowlist():
    missing = sorted(
        f"{name}.py" for name in _handler_local_module_imports()
        if f"{name}.py" not in _allowlisted_sources()
    )
    assert missing == [], (
        "lambda_api/handler.py imports these sibling modules, but "
        "scripts/build_terraform_artifacts.sh does not stage them — the deployed Lambda would "
        f"ImportError at cold start and EVERY route would 500: {missing}"
    )
