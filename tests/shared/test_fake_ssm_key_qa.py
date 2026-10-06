"""WHIT-775 QA — no suite overwrites the shared fake ssm."""

from _conftest_probe import run_conftest_in_fresh_process


def test_sync_trigger_conftest_keeps_an_ssm_installed_before_it():
    # sync_trigger used to overwrite sys.modules["ssm"] unconditionally, so loading it second
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
