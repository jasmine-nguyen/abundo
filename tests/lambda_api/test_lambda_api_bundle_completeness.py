"""Every lambda_api (and webhook, lambda/) module that is imported must actually be SHIPPED.

scripts/build_terraform_artifacts.sh stages the git-tracked lambda_api/*.py files (WHIT-626), so a
module ships exactly when it is committed. A sibling module that is imported but never committed
exists on the author's disk — tests green — yet vanishes on a clean checkout, and
`from merchant_groups import ...` then raises ImportError at cold start. That takes out EVERY route
on the API, not just the new one. This is exactly how WHIT-542 first landed: the old `.gitignore`
`lambda_api/*` rule silently kept `lambda_api/filing_habits.py` out of git.

ABU-39: the webhook is staged the same way from git-tracked lambda/*.py, so the same guard covers
it (an untracked webhook module would fail every bank message at cold start).

Static: reads the files, imports nothing (the handler needs env + boto3 at load).
"""

import ast
import pathlib
import subprocess

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=_REPO_ROOT, capture_output=True, text=True)


def _tracked_modules(folder: str) -> set[str]:
    listed = _git("ls-files", "--", f":(glob){folder}/*.py")
    assert listed.returncode == 0, listed.stderr
    return {pathlib.Path(path).stem for path in listed.stdout.split()}


def _local_module_imports(folder: str) -> set[str]:
    """Bare module names any tracked <folder> module imports that resolve to a <folder>/<name>.py
    sibling. ast.walk covers function-level imports too. Everything else comes from the shared
    layer (staged separately), a pip-installed dep or the stdlib.
    """
    source_dir = _REPO_ROOT / folder
    imported = set()
    for module in _tracked_modules(folder):
        tree = ast.parse((source_dir / f"{module}.py").read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                imported.add(node.module.split(".")[0])
    return {name for name in imported if (source_dir / f"{name}.py").exists()}


@pytest.mark.parametrize(
    ("folder", "tracked", "imported"),
    [
        # chat_tools is only imported by ai_chat.py, not handler.py.
        ("lambda_api", {"handler", "api_constants", "insights_ai"}, {"api_constants", "insights_ai", "chat_tools"}),
        # budget_alerts is imported with a bare `import`, not `from ... import`.
        ("lambda", {"handler", "webhook_repository", "banksync"}, {"webhook_repository", "banksync", "budget_alerts"}),
    ],
)
def test_the_scan_reaches_every_tracked_module(folder, tracked, imported):
    # Guards a vacuous pass: if the scan stops matching, the check below is empty and would
    # "pass" while checking nothing.
    assert tracked <= _tracked_modules(folder)
    assert imported <= _local_module_imports(folder)


@pytest.mark.parametrize("folder", ["lambda_api", "lambda"])
def test_every_imported_module_is_git_tracked_so_it_ships(folder):
    untracked = sorted(f"{folder}/{name}.py" for name in _local_module_imports(folder) - _tracked_modules(folder))
    assert untracked == [], (
        f"these {folder} modules are imported but NOT git-tracked, so the build never stages "
        f"them and the deployed Lambda would ImportError at cold start: {untracked}"
    )
