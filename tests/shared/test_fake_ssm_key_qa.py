"""WHIT-775 QA — no suite overwrites the shared fake ssm client."""

from _conftest_probe import run_conftest_in_fresh_process


def test_sync_trigger_conftest_keeps_a_boto3_installed_before_it():
    # sync_trigger used to overwrite its fake unconditionally, so loading it second replaced the
    # first suite's (possibly monkeypatched) fake. It must first-writer-win too.
    output = run_conftest_in_fresh_process(
        "sync_trigger",
        report='sys.modules["boto3"] is first, '
               'sys.modules["boto3"].client("ssm").get_parameter(Name="/any")["Parameter"]["Value"]',
        preamble="""
            class FirstClient:
                def get_parameter(self, **kwargs):
                    return {"Parameter": {"Value": "FIRST-WRITER"}}

            first = types.ModuleType("boto3")
            first.client = lambda *a, **k: FirstClient()
            sys.modules["boto3"] = first
        """,
    )
    assert output == "True FIRST-WRITER"
