"""WHIT-646: the single copy of the terraform readers used by the alarm-wiring tests."""

import fnmatch
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


def route_keys(source):
    """WHIT-805: the active "VERB /path" keys in the app_route_keys list; a key behind # or // is switched off."""
    block = source.split("app_route_keys = toset([", 1)[1].split("])", 1)[0]
    return set(re.findall(r'^\s*"([A-Z]+ /[^"]*)"', block, re.M))


def app_route_keys():
    """WHIT-791: every active route key in apigateway.tf's app_route_keys list."""
    return route_keys((TERRAFORM_DIR / "apigateway.tf").read_text())


def exact_route_keys(handler):
    """WHIT-791: the API handler's exact-path route table as "VERB /path" keys."""
    return {f"{method} {path}" for method, path in handler._EXACT_ROUTES}


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


def policy_statements(resource_name):
    """WHIT-680: each top-level `{ ... }` of an aws_iam_role_policy's Statement list, as text."""
    block = tf_block((TERRAFORM_DIR / "iam.tf").read_text(), "aws_iam_role_policy", resource_name)
    body = block[block.index("Statement"):]
    statements, depth, start = [], 0, None
    for position, char in enumerate(body):
        if char == "{":
            if depth == 0:
                start = position
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                statements.append(body[start:position + 1])
            if depth < 0:
                break
    return statements


def leading_keys(statement):
    """The statement's dynamodb:LeadingKeys patterns, or None when it isn't row-scoped."""
    match = re.search(r'"dynamodb:LeadingKeys"\s*=\s*\[([^\]]*)\]', statement)
    if match is None:
        return None
    return re.findall(r'"([^"]+)"', match.group(1))


def allows(statements, action, pk):
    """Whether any statement grants the action on a row with this partition key (None for a query)."""
    for statement in statements:
        if action not in granted_dynamodb_actions(statement):
            continue
        patterns = leading_keys(statement)
        if patterns is None:
            return True
        # ForAllValues:StringLike → the request's partition key must match one pattern.
        if pk is not None and any(fnmatch.fnmatchcase(pk, pattern) for pattern in patterns):
            return True
    return False
