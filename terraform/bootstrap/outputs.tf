# Copy these into the GitHub repo Variables + the PR2 backend block (see DEPLOY.md).

output "state_bucket_name" {
  description = "S3 bucket holding the main module's remote state (backend `bucket`)"
  value       = aws_s3_bucket.tfstate.bucket
}

output "state_key" {
  description = "Object key the main module's state uses (backend `key`)"
  value       = local.state_key
}

output "lock_table_name" {
  description = "DynamoDB state-lock table (backend `dynamodb_table`)"
  value       = aws_dynamodb_table.tflock.name
}

output "plan_role_arn" {
  description = "Role the PR plan job assumes (GitHub variable AWS_PLAN_ROLE_ARN)"
  value       = aws_iam_role.github_plan.arn
}

output "apply_role_arn" {
  description = "Role the gated apply job assumes (GitHub variable AWS_APPLY_ROLE_ARN)"
  value       = aws_iam_role.github_apply.arn
}

output "oidc_provider_arn" {
  description = "The GitHub OIDC provider ARN"
  value       = aws_iam_openid_connect_provider.github.arn
}

output "aws_region" {
  description = "Region (backend `region`)"
  value       = var.aws_region
}

output "account_id" {
  description = "AWS account the bootstrap ran against"
  value       = data.aws_caller_identity.current.account_id
}
