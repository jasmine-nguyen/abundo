resource "aws_ssm_parameter" "banksync_webhook_secret" {
  name  = "/${var.project_name}/banksync-webhook-secret"
  type  = "SecureString"
  value = "placeholder"
  lifecycle {
    ignore_changes = [value]
  }
}

# BankSync REST API key, read by the sync-trigger lambda to call POST /v1/feeds/{id}/sync.
# Terraform only seeds a placeholder; set the real value out-of-band (console/CLI) and
# ignore_changes keeps Terraform from overwriting it on subsequent applies.
resource "aws_ssm_parameter" "banksync_api_key" {
  name  = "/${var.project_name}/banksync-api-key"
  type  = "SecureString"
  value = "placeholder"
  lifecycle {
    ignore_changes = [value]
  }
}

# Anthropic API key, read by lambda_api (insights_ai.py) to call the Messages API
# for AI spending insights (WHIT-104). Terraform seeds a placeholder; paste the
# real key out-of-band (console/CLI). ignore_changes keeps applies from clobbering it.
resource "aws_ssm_parameter" "anthropic_api_key" {
  name  = "/${var.project_name}/anthropic-api-key"
  type  = "SecureString"
  value = "placeholder"
  lifecycle {
    ignore_changes = [value]
  }
}

# Shared-secret token the API Gateway authorizer checks on the /enrichments
# routes (WHIT-52). Terraform seeds a placeholder; set the real random value
# out-of-band (console/CLI) and inject the same value into the app config.
# ignore_changes keeps Terraform from overwriting it on subsequent applies.
resource "aws_ssm_parameter" "api_auth_token" {
  name  = "/${var.project_name}/api-auth-token"
  type  = "SecureString"
  value = "placeholder"
  lifecycle {
    ignore_changes = [value]
  }
}
