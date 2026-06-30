resource "aws_ssm_parameter" "banksync_webhook_secret" {
  name  = "/${var.project_name}/banksync-webhook-secret"
  type  = "SecureString"
  value = "placeholder"
  lifecycle {
    ignore_changes = [value]
  }
}
