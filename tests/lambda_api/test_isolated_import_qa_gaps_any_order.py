"""WHIT-770: the A13 leftover-stub pair must pass alone and after any other suite's conftest.

Each suite's conftest installs the shared fake `ssm` with its own default key, and the first one
loaded wins. Run the pair in a fresh pytest after each of those suites has loaded first.
"""

import pathlib
import subprocess
import sys

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_PAIR_FILE = "tests/lambda_api/test_isolated_import_qa_gaps.py"


@pytest.mark.parametrize("suite_loaded_first", [None, "tests/shared"])
def test_the_leftover_stub_pair_passes_whichever_suite_loads_first(suite_loaded_first):
    paths = [_PAIR_FILE]
    if suite_loaded_first:
        paths.insert(0, suite_loaded_first)

    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *paths, "-k", "isolated_import_qa_gaps"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout[-3000:]
