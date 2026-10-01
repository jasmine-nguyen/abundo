"""WHIT-646: the terraform readers live once, in tests/shared/_terraform.py.

The alarm-wiring suites prove the shared readers behave like the old copies. These pin
the two things the card is about: the shared module reads the real terraform, and no
test file grows its own copy again.
"""

import pathlib
import re

from _terraform import MONITORING_TF, TERRAFORM_DIR, filter_pattern, tf_attr, tf_block

_TESTS_DIR = pathlib.Path(__file__).resolve().parents[1]


def test_shared_readers_read_monitoring_tf():
    assert TERRAFORM_DIR.name == "terraform"
    assert MONITORING_TF == TERRAFORM_DIR / "monitoring.tf"

    block = tf_block(MONITORING_TF.read_text(), "aws_cloudwatch_log_metric_filter", "up_webhook_failures")
    assert tf_attr(block, "name") == '"${var.project_name}-up-webhook-failures"'

    # An HCL-escaped quoted pattern is read whole and un-escaped, not cut at its first \".
    assert filter_pattern("up_webhook_failures") == (
        '?"up webhook: processing failed" ?UP_WEBHOOK_TOKEN_REJECTED ?UP_WEBHOOK_NO_DEVICE_TOKENS')
    assert filter_pattern("milestone_row_malformed") == "?MILESTONE_ROW_MALFORMED ?MILESTONE_PLAN_MALFORMED"


def test_no_test_file_keeps_its_own_terraform_reader():
    # WHIT-649: a hand-built <repo>/terraform path is a local copy of TERRAFORM_DIR too.
    # WHIT-680: so is a policy-statement splitter or a LeadingKeys regex.
    local_copy = re.compile(
        r"^\s*def _(tf_block|tf_attr|filter_pattern|statements|leading_keys|allows|policy_statements)\(|"
        r'"dynamodb:LeadingKeys"\\s\*=|'
        r'resource "aws_cloudwatch_log_metric_filter" "[^"{]+"\.\*\?|'
        r'(parents\[\d+\]|_ROOT|_REPO_ROOT)\)?\s*/\s*"terraform"',
        re.M)
    this_file = pathlib.Path(__file__).resolve()
    offenders = sorted(
        str(path.relative_to(_TESTS_DIR))
        for path in _TESTS_DIR.rglob("*.py")
        if path.resolve() != this_file
        and path.name != "_terraform.py"
        and local_copy.search(path.read_text())
    )
    assert offenders == [], f"import TERRAFORM_DIR and the readers from _terraform instead: {offenders}"
