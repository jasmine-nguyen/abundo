"""Every lambda_api module that is imported must actually be SHIPPED.

scripts/build_terraform_artifacts.sh stages the git-tracked lambda_api/*.py files (WHIT-626), so a
module ships exactly when it is committed. A sibling module that is imported but never committed
exists on the author's disk — tests green — yet vanishes on a clean checkout, and
`from merchant_groups import ...` then raises ImportError at cold start. That takes out EVERY route
on the API, not just the new one. This is exactly how WHIT-542 first landed: the old `.gitignore`
`lambda_api/*` rule silently kept `lambda_api/filing_habits.py` out of git.

Static: reads the files, imports nothing (the handler needs env + boto3 at load).
"""

import ast
import pathlib
import subprocess

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_LAMBDA_API = _REPO_ROOT / "lambda_api"


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=_REPO_ROOT, capture_output=True, text=True)


def _tracked_modules() -> set[str]:
    listed = _git("ls-files", "--", ":(glob)lambda_api/*.py")
    assert listed.returncode == 0, listed.stderr
    return {pathlib.Path(path).stem for path in listed.stdout.split()}


def _local_module_imports() -> set[str]:
    """Bare module names any tracked lambda_api module imports that resolve to a lambda_api/<name>.py
    sibling. ast.walk covers function-level imports too. Everything else comes from the shared
    layer (staged separately) or the stdlib.
    """
    imported = set()
    for module in _tracked_modules():
        tree = ast.parse((_LAMBDA_API / f"{module}.py").read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imported.add(node.module.split(".")[0])
    return {name for name in imported if (_LAMBDA_API / f"{name}.py").exists()}


def test_the_scan_reaches_every_tracked_lambda_api_module():
    # Guards a vacuous pass: if the scan stops matching, the check below is empty and would
    # "pass" while checking nothing. chat_tools is only imported by ai_chat.py, not handler.py.
    assert {"handler", "api_constants", "insights_ai"} <= _tracked_modules()
    assert {"api_constants", "insights_ai", "chat_tools"} <= _local_module_imports()


def test_every_imported_lambda_api_module_is_git_tracked_so_it_ships():
    untracked = sorted(f"lambda_api/{name}.py" for name in _local_module_imports() - _tracked_modules())
    assert untracked == [], (
        "these lambda_api modules are imported but NOT git-tracked, so the build never stages "
        f"them and the deployed Lambda would ImportError at cold start (EVERY route 500s): {untracked}"
    )
