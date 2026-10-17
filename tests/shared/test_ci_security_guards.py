"""ABU-93: the PR preview login can't read secrets, rows or logs; secrets stay out of Terraform
state; the test workflows get a read-only token; the public API is throttled."""

import re

import pytest

from _terraform import BOOTSTRAP_MAIN_TF, TERRAFORM_DIR, policy_statements, tf_attr, tf_block

WORKFLOWS_DIR = TERRAFORM_DIR.parent / ".github" / "workflows"

SSM_PARAMETERS = {
    "banksync_webhook_secret": "banksync-webhook-secret",
    "banksync_api_key": "banksync-api-key",
    "anthropic_api_key": "anthropic-api-key",
    "expo_access_token": "expo-access-token",
    "up_personal_access_token": "up-personal-access-token",
    "up_webhook_signing_secret": "up-webhook-signing-secret",
}


def _plan_deny_block():
    return tf_block(BOOTSTRAP_MAIN_TF.read_text(), "aws_iam_role_policy", "plan_deny_data_reads")


def test_plan_role_has_inline_deny_on_data_reads():
    # [A1] every statement is a Deny, so no data-read action can slip in as an Allow.
    block = _plan_deny_block()
    assert "aws_iam_role.github_plan" in block
    statements = policy_statements("plan_deny_data_reads", path=BOOTSTRAP_MAIN_TF)
    assert statements
    for statement in statements:
        assert re.search(r'Effect\s*=\s*"Deny"', statement), f"not a Deny: {statement}"
    for action in ("ssm:GetParameter", "dynamodb:Query", "dynamodb:Scan", "dynamodb:GetItem",
                   "logs:GetLogEvents", "logs:FilterLogEvents", "s3:GetObjectVersion",
                   "cognito-idp:ListUsers"):
        assert f'"{action}"' in block, f"{action} is not denied to the PR plan role"


def test_plan_role_table_deny_spares_the_state_lock():
    statements = policy_statements("plan_deny_data_reads", path=BOOTSTRAP_MAIN_TF)
    table_deny = next(statement for statement in statements if '"dynamodb:Query"' in statement)
    assert re.search(r"NotResource\s*=\s*\[?\s*aws_dynamodb_table\.tflock\.arn", table_deny), \
        "the table deny must use NotResource on the tflock table so terraform can still lock state"


def test_ssm_secrets_are_not_managed_in_terraform_state():
    text = (TERRAFORM_DIR / "ssm.tf").read_text()
    assert 'resource "aws_ssm_parameter"' not in text, "SSM secret values still land in Terraform state"
    for name in SSM_PARAMETERS:
        match = re.search(rf"removed\s*\{{\s*from\s*=\s*aws_ssm_parameter\.{name}\b(.*?)\n\}}", text, re.S)
        assert match, f"no removed block for aws_ssm_parameter.{name}"
        assert re.search(r"destroy\s*=\s*false", match.group(1)), f"{name} removed block must keep the parameter"


def test_iam_references_ssm_by_arn_locals_with_the_old_names():
    assert "aws_ssm_parameter." not in (TERRAFORM_DIR / "iam.tf").read_text()
    # [A2] the hand-built ARN must be exactly the old parameter's ARN, or every lambda loses its secret.
    text = (TERRAFORM_DIR / "ssm.tf").read_text()
    assert tf_attr(text, "ssm_parameter_arn_prefix") == (
        '"arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}'
        ':parameter/${var.project_name}"')
    for name, kebab in SSM_PARAMETERS.items():
        assert tf_attr(text, f"{name}_arn") == f'"${{local.ssm_parameter_arn_prefix}}/{kebab}"'


# Which secrets each lambda role could read before the switch to ARN locals.
SSM_GRANTS = {
    "app_api_ssm": {"banksync_api_key", "anthropic_api_key"},
    "transaction_ssm": {"banksync_webhook_secret", "expo_access_token",
                        "up_personal_access_token", "up_webhook_signing_secret"},
    "transaction_trigger_ssm": {"banksync_api_key"},
    "balance_poller_ssm": {"banksync_api_key"},
    "push_receipts_ssm": {"expo_access_token"},
    "goal_nudge_ssm": {"expo_access_token"},
    "ai_chat_worker_ssm": {"anthropic_api_key"},
}


@pytest.mark.parametrize("policy, secrets", SSM_GRANTS.items())
def test_each_lambda_role_keeps_its_secret_grants(policy, secrets):
    # [A3] swapping aws_ssm_parameter.X.arn for local.X_arn must not move a grant between roles.
    block = tf_block((TERRAFORM_DIR / "iam.tf").read_text(), "aws_iam_role_policy", policy)
    assert set(re.findall(r"local\.(\w+)_arn\b", block)) == secrets


def test_api_stage_is_throttled():
    block = tf_block((TERRAFORM_DIR / "apigateway.tf").read_text(), "aws_apigatewayv2_stage", "default")
    assert "default_route_settings" in block, "the API stage has no rate limit"
    assert tf_attr(block, "throttling_rate_limit") == "20"
    assert tf_attr(block, "throttling_burst_limit") == "40"


TEST_WORKFLOWS = sorted(path.name for path in WORKFLOWS_DIR.glob("*.yml") if path.name != "deploy.yml")


@pytest.mark.parametrize("workflow", TEST_WORKFLOWS)
def test_workflow_token_is_read_only(workflow):
    text = (WORKFLOWS_DIR / workflow).read_text()
    match = re.search(r"^permissions:\s*\n((?:[ \t]+.*\n?)+)", text, re.M)
    assert match, f"{workflow} has no top-level permissions: block"
    assert re.search(r"^\s+contents:\s*read\b", match.group(1), re.M), f"{workflow} lacks contents: read"
    assert "write" not in re.sub(r"#.*", "", match.group(1)), f"{workflow} grants a write permission"
