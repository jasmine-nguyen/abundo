"""ABU-93: the PR preview login can't read secrets, rows or logs; secrets stay out of Terraform
state; the test workflows get a read-only token; the public API is throttled.
ABU-42: every app route requires a Cognito login."""

import re

import pytest

from _terraform import APIGATEWAY_TF, BOOTSTRAP_MAIN_TF, TERRAFORM_DIR, policy_statements, tf_attr, tf_block

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


def test_api_stage_is_throttled():
    block = tf_block(APIGATEWAY_TF.read_text(), "aws_apigatewayv2_stage", "default")
    assert "default_route_settings" in block, "the API stage has no rate limit"
    assert tf_attr(block, "throttling_rate_limit") == "20"
    assert tf_attr(block, "throttling_burst_limit") == "40"


def test_every_app_route_requires_a_cognito_login():
    # The server code never checks the caller, so this gateway setting is the whole login wall.
    block = tf_block(APIGATEWAY_TF.read_text(), "aws_apigatewayv2_route", "app")
    assert tf_attr(block, "for_each") == "local.app_route_keys"
    assert tf_attr(block, "authorization_type") == '"JWT"'
    assert tf_attr(block, "authorizer_id") == "aws_apigatewayv2_authorizer.jwt.id"


def test_jwt_authorizer_only_trusts_the_apps_cognito_id_tokens():
    block = tf_block(APIGATEWAY_TF.read_text(), "aws_apigatewayv2_authorizer", "jwt")
    assert tf_attr(block, "authorizer_type") == '"JWT"'
    assert tf_attr(block, "identity_sources") == '["$request.header.Authorization"]'
    assert tf_attr(block, "audience") == "[aws_cognito_user_pool_client.app.id]"
    assert tf_attr(block, "issuer") == "local.cognito_issuer_url"
    assert tf_attr((TERRAFORM_DIR / "cognito.tf").read_text(), "cognito_issuer_url") == (
        '"https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.pool.id}"')


def test_only_the_bank_webhooks_skip_login():
    routes = {
        name
        for path in TERRAFORM_DIR.glob("*.tf")
        for name in re.findall(r'^resource "aws_apigatewayv2_route" "([^"]+)"', path.read_text(), re.M)
    }
    assert routes == {"app", "banksync_webhook_route", "up_webhook_route"}, \
        "add the new route to app_route_keys, or, if it's truly public, add it here with a reason"
    text = APIGATEWAY_TF.read_text()
    assert tf_attr(tf_block(text, "aws_apigatewayv2_route", "banksync_webhook_route"), "route_key") == \
        '"POST /webhook/banksync"'
    assert tf_attr(tf_block(text, "aws_apigatewayv2_route", "up_webhook_route"), "route_key") == '"POST /webhook/up"'
    api = tf_block(text, "aws_apigatewayv2_api", "api")
    assert not re.search(r"^\s*(target|route_key)\s*=", api, re.M), \
        "quick-create target/route_key on the API makes a public $default route with no authorizer"


TEST_WORKFLOWS = sorted(path.name for path in WORKFLOWS_DIR.glob("*.yml") if path.name != "deploy.yml")


@pytest.mark.parametrize("workflow", TEST_WORKFLOWS)
def test_workflow_token_is_read_only(workflow):
    text = (WORKFLOWS_DIR / workflow).read_text()
    match = re.search(r"^permissions:\s*\n((?:[ \t]+.*\n?)+)", text, re.M)
    assert match, f"{workflow} has no top-level permissions: block"
    assert re.search(r"^\s+contents:\s*read\b", match.group(1), re.M), f"{workflow} lacks contents: read"
    assert "write" not in re.sub(r"#.*", "", match.group(1)), f"{workflow} grants a write permission"


SUB_KEY = '"token.actions.githubusercontent.com:sub"'


def _trust_conditions(role):
    """ABU-96: {operator: body} for each condition block in the role's trust policy."""
    block = tf_block(BOOTSTRAP_MAIN_TF.read_text(), "aws_iam_role", role)
    return dict(re.findall(r"(String\w+)\s*=\s*\{(.*?)\n\s*\}", block, re.S))


def _sub_entries(condition_body):
    match = re.search(rf"{re.escape(SUB_KEY)}\s*=\s*\[(.*?)\]", condition_body, re.S)
    assert match, "no login-ID (sub) list in this condition block"
    return re.findall(r'"([^"]+)"', match.group(1))


def test_apply_role_trusts_only_main():
    # ABU-96: the release login must name the main branch, exactly, or any branch can deploy.
    conditions = _trust_conditions("github_apply")
    assert "StringLike" not in conditions, "the release login must not use wildcard matching"
    entries = _sub_entries(conditions["StringEquals"])
    assert len(entries) == 2
    for entry in entries:
        assert "*" not in entry
        assert entry.endswith(":environment:${var.environment_name}:ref:${local.deploy_ref}"), \
            f"release login trusts a login ID without the main branch: {entry}"
    assert tf_attr(BOOTSTRAP_MAIN_TF.read_text(), "deploy_ref") == '"refs/heads/main"'


def test_plan_role_trusts_only_pull_requests():
    conditions = _trust_conditions("github_plan")
    assert SUB_KEY not in conditions.get("StringEquals", ""), \
        "the preview login's sub must sit only under StringLike (both blocks would be ANDed)"
    entries = _sub_entries(conditions["StringLike"])
    assert len(entries) == 2
    for entry in entries:
        assert entry.endswith(":pull_request:ref:refs/pull/*"), f"preview login trusts a non-PR login ID: {entry}"


@pytest.mark.parametrize("role", ["github_apply", "github_plan"])
def test_trust_pins_the_audience(role):
    # [A3] moving sub into StringLike must not drag aud along or drop it.
    assert '"token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"' in _trust_conditions(role)["StringEquals"]
