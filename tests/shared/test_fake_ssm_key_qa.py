"""WHIT-775 QA — the per-suite ssm default can't come back, and no suite overwrites the shared fake."""

import pytest

import _boto_stubs
from _conftest_probe import run_conftest_in_fresh_process


def test_install_import_satisfiers_rejects_a_per_suite_default():
    # [A1] A per-suite default is what made the key depend on run order.
    with pytest.raises(TypeError):
        _boto_stubs.install_import_satisfiers(ssm_default="per-suite")


def test_sync_trigger_conftest_keeps_an_ssm_installed_before_it():
    # [A2] sync_trigger used to overwrite sys.modules["ssm"] unconditionally, so loading it second
    # replaced the first suite's (possibly monkeypatched) fake. It must now first-writer-win too.
    output = run_conftest_in_fresh_process(
        "sync_trigger",
        report='sys.modules["ssm"] is first, sys.modules["ssm"].get_param("/any")',
        preamble="""
            first = types.ModuleType("ssm")
            first.get_param = lambda parameter_name: "FIRST-WRITER"
            sys.modules["ssm"] = first
        """,
    )
    assert output == "True FIRST-WRITER"
