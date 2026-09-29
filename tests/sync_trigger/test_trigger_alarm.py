"""WHIT-644: the transaction-trigger failure alarm is wired to the trigger's failures.

An expired BankSync key makes every hourly sync fail (the handler raises -> AWS/Lambda
Errors). This alarm must watch that metric on that function, page the alerts topic after
3 failed hours in a row, and email again on recovery. Removing or retargeting the wiring
breaks these tests.
"""

import pathlib
import re

_TERRAFORM = pathlib.Path(__file__).resolve().parents[2] / "terraform"


def _tf_block(text, kind, name):
    match = re.search(rf'resource "{kind}" "{name}" \{{(.*?)\n\}}', text, re.S)
    assert match, f'resource "{kind}" "{name}" not found'
    return match.group(1)


def _tf_attr(block, key):
    match = re.search(rf'^\s*{key}\s*=\s*(.+?)\s*$', block, re.M)
    assert match, f"attribute {key} not found"
    return match.group(1)


def test_alarm_pages_alerts_after_three_failed_hourly_trigger_runs():
    alarm = _tf_block((_TERRAFORM / "monitoring.tf").read_text(),
                      "aws_cloudwatch_metric_alarm", "transaction_trigger_errors")

    assert _tf_attr(alarm, "namespace") == '"AWS/Lambda"'
    assert _tf_attr(alarm, "metric_name") == '"Errors"'
    assert _tf_attr(alarm, "dimensions") == \
        "{ FunctionName = aws_lambda_function.transaction_trigger.function_name }"
    assert _tf_attr(alarm, "statistic") == '"Sum"'
    assert _tf_attr(alarm, "period") == "3600"
    assert _tf_attr(alarm, "evaluation_periods") == "3"
    assert _tf_attr(alarm, "datapoints_to_alarm") == "3"
    assert _tf_attr(alarm, "threshold") == "1"
    assert _tf_attr(alarm, "comparison_operator") == '"GreaterThanOrEqualToThreshold"'
    assert _tf_attr(alarm, "alarm_actions") == "[aws_sns_topic.alerts.arn]"
    assert _tf_attr(alarm, "ok_actions") == "[aws_sns_topic.alerts.arn]"
    assert "/abundo/banksync-api-key" in _tf_attr(alarm, "alarm_description")

    # The 3600s period counts failed HOURS only because the trigger runs hourly.
    # A changed cadence must force this alarm to be reviewed.
    variables = (_TERRAFORM / "variables.tf").read_text()
    match = re.search(r'variable "sync_schedule_expression" \{(.*?)\n\}', variables, re.S)
    assert match
    assert _tf_attr(match.group(1), "default") == '"rate(1 hour)"'
