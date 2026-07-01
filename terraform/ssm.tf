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
