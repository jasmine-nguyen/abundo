"""Load one suite's conftest first in a fresh Python process and report what it left behind."""

import pathlib
import subprocess
import sys
import textwrap

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TESTS_DIR = _REPO_ROOT / "tests"

_PROBE = """
import importlib.util, sys, types
sys.path.insert(0, {shared!r})
{preamble}
spec = importlib.util.spec_from_file_location("conftest_probe", {conftest!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print({report})
"""


def run_conftest_in_fresh_process(suite, report, preamble=""):
    probe = _PROBE.format(
        shared=str(_TESTS_DIR / "shared"),
        conftest=str(_TESTS_DIR / suite / "conftest.py"),
        preamble=textwrap.dedent(preamble),
        report=report,
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=_REPO_ROOT, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()
