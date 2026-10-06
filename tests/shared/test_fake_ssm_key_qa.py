"""WHIT-775 QA — the per-suite ssm default can't come back, and no suite overwrites the shared fake."""

import pathlib
import subprocess
import sys

import pytest

import _boto_stubs

_TESTS_DIR = pathlib.Path(__file__).resolve().parents[1]


def test_install_import_satisfiers_rejects_a_per_suite_default():
    # [A1] A per-suite default is what made the key depend on run order.
    with pytest.raises(TypeError):
        _boto_stubs.install_import_satisfiers(ssm_default="per-suite")


_PROBE = """
import importlib.util, sys, types
sys.path.insert(0, {shared!r})
first = types.ModuleType("ssm")
first.get_param = lambda parameter_name: "FIRST-WRITER"
sys.modules["ssm"] = first
spec = importlib.util.spec_from_file_location("conftest_probe", {conftest!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(sys.modules["ssm"] is first, sys.modules["ssm"].get_param("/any"))
"""


def test_sync_trigger_conftest_keeps_an_ssm_installed_before_it():
    # [A2] sync_trigger used to overwrite sys.modules["ssm"] unconditionally, so loading it second
    # replaced the first suite's (possibly monkeypatched) fake. It must now first-writer-win too.
    probe = _PROBE.format(
        shared=str(_TESTS_DIR / "shared"),
        conftest=str(_TESTS_DIR / "sync_trigger" / "conftest.py"),
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=_TESTS_DIR.parent, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "True FIRST-WRITER"
