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

# Expo access token (a PAT) used by the push sender (shared/push.py). The Expo
# project has "Enhanced Security for Push Notifications" enabled, so every push
# send must carry Authorization: Bearer <this token>. Terraform seeds a
# placeholder; set the real PAT out-of-band (console/CLI) and ignore_changes
# keeps applies from overwriting it. Read by the webhook lambda (the push sender's
# runtime — see the lambda_ssm grant in iam.tf).
resource "aws_ssm_parameter" "expo_access_token" {
  name  = "/${var.project_name}/expo-access-token"
  type  = "SecureString"
  value = "placeholder"
  lifecycle {
    ignore_changes = [value]
  }
}
