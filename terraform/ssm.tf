resource "aws_ssm_parameter" "pocketsmith_developer_key" {
  name  = "/${var.project_name}/pocketsmith-developer-key"
  type  = "SecureString"
  value = "placeholder"
  lifecycle {
    ignore_changes = [value]
  }
}
