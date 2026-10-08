"""WHIT-831 slice 1: every server function imports its stores from their own files.

The shared layer no longer ships a pass-along module that re-exports the store classes.
Each function's modules must import cleanly with that module unavailable. Run in a fresh
interpreter per function, so no other suite's cached modules can satisfy an import.
"""

import pathlib
import subprocess
import sys

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_PASS_ALONG = "repo" + "sitory"  # built from pieces so a text search can't trip on this file

_PROBE = """
import importlib, importlib.abc, pathlib, sys
function_dir, shared_dir, helpers_dir, blocked = sys.argv[1:5]
sys.path[:0] = [function_dir, shared_dir, helpers_dir]

class _Gone(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        if name == blocked:
            raise ModuleNotFoundError(f"No module named {name!r}", name=name)
        return None

sys.meta_path.insert(0, _Gone())
from _boto_stubs import install_import_satisfiers
install_import_satisfiers()
for module in sorted(pathlib.Path(function_dir).glob("*.py")):
    importlib.import_module(module.stem)
"""


@pytest.mark.parametrize("function_dir", ["lambda_api", "lambda_balance_poller", "lambda_goal_nudge"])
def test_every_function_module_imports_without_the_pass_along_store_module(function_dir):
    result = subprocess.run(
        [
            sys.executable, "-c", _PROBE,
            str(_REPO_ROOT / function_dir), str(_REPO_ROOT / "shared"),
            str(_REPO_ROOT / "tests" / "shared"), _PASS_ALONG,
        ],
        capture_output=True, text=True, cwd=_REPO_ROOT,
    )
    assert result.returncode == 0, result.stderr
    assert not (_REPO_ROOT / "shared" / f"{_PASS_ALONG}.py").exists()
