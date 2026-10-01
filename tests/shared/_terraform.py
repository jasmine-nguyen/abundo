"""WHIT-646: the single copy of the terraform readers used by the alarm-wiring tests."""

import pathlib
import re

TERRAFORM_DIR = pathlib.Path(__file__).resolve().parents[2] / "terraform"
MONITORING_TF = TERRAFORM_DIR / "monitoring.tf"


def tf_block(text, kind, name):
    match = re.search(rf'resource "{kind}" "{name}" \{{(.*?)\n\}}', text, re.S)
    assert match, f'resource "{kind}" "{name}" not found'
    return match.group(1)


def tf_attr(block, key):
    match = re.search(rf'^\s*{key}\s*=\s*(.+?)\s*$', block, re.M)
    assert match, f"attribute {key} not found"
    return match.group(1)


def filter_pattern(resource_name):
    """The metric filter's pattern READ OUT of monitoring.tf (not retyped), un-escaped. The regex allows
    HCL's \\" escapes so a quoted pattern isn't cut at its first inner quote."""
    match = re.search(
        rf'resource "aws_cloudwatch_log_metric_filter" "{resource_name}".*?'
        r'pattern\s*=\s*"((?:[^"\\]|\\.)*)"', MONITORING_TF.read_text(), re.S)
    assert match, f"metric filter {resource_name} not found in monitoring.tf"
    return match.group(1).replace('\\"', '"')


def alarm_names(text):
    """WHIT-655: every aws_cloudwatch_metric_alarm resource name in the terraform text, in order."""
    return re.findall(r'^resource "aws_cloudwatch_metric_alarm" "([^"]+)"', text, re.M)


# boto3 Table method -> the IAM action it needs (WHIT-678: shared by the per-role DynamoDB guards).
DYNAMODB_VERB_TO_ACTION = {
    "get_item": "GetItem",
    "put_item": "PutItem",
    "query": "Query",
    "update_item": "UpdateItem",
    "delete_item": "DeleteItem",
    "batch_writer": "BatchWriteItem",
}


def granted_dynamodb_actions(policy_block):
    """The DynamoDB actions a policy block grants. `"dynamodb:LeadingKeys"` matches the same
    pattern but is a condition key, not an action, so it's dropped."""
    return set(re.findall(r'"dynamodb:(\w+)"', policy_block)) - {"LeadingKeys"}
