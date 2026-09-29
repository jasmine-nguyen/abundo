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
