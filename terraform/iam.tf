data "aws_caller_identity" "current" {

}

resource "aws_iam_role" "lambda_exec" {
  name = "${var.project_name}-lambda-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "lambda_api_exec" {
  name = "${var.project_name}-lambda-api-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Execution role for the sync-trigger lambda. Kept minimal on purpose: it only
# reads the BankSync API key from SSM and writes its own logs — no DynamoDB.
resource "aws_iam_role" "sync_trigger_exec" {
  name = "${var.project_name}-sync-trigger-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Execution role for the balance-poller lambda. Reads the BankSync API key from
# SSM, writes the single home-loan balance row to DynamoDB (PutItem only — it
# never reads or mutates transactions), and writes its own logs.
resource "aws_iam_role" "balance_poller_exec" {
  name = "${var.project_name}-balance-poller-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Execution role for the API Gateway authorizer lambda. Minimal: it only reads
# the shared-secret token from SSM and writes its own logs — no DynamoDB.
resource "aws_iam_role" "authorizer_exec" {
  name = "${var.project_name}-authorizer-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}


resource "aws_iam_role_policy" "lambda_dynamodb" {
  name = "${var.project_name}-lambda-dynamodb"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:Query"
      ]
      Resource = [
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table",
      "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_api_dynamodb" {
  name = "${var.project_name}-lambda-api-dynamodb"
  role = aws_iam_role.lambda_api_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem"
      ]
      Resource = [
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table",
      "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table/index/*"]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_logs" {
  name = "${var.project_name}-lambda-logs"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ]
      Resource = [
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-lambda:*",
        # The reprocess lambda (WHIT-55) reuses this same lambda_exec role, so its
        # own log group is granted here. The "-lambda:*" pattern above does NOT
        # match "-lambda-reprocess" (the '-reprocess' breaks before the required ':').
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-lambda-reprocess:*"
      ]
    }]
  })
}

resource "aws_iam_role_policy" "lambda_api_logs" {
  name = "${var.project_name}-lambda-api-logs"
  role = aws_iam_role.lambda_api_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ]
      Resource = [
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-lambda-api:*"]
    }]
  })
}

# lambda_api: read the BankSync API key to call the Enrichments API (WHIT-52).
# ssm:GetParameter alone decrypts the SecureString via the AWS-managed key (same
# pattern as sync_trigger_ssm).
resource "aws_iam_role_policy" "lambda_api_ssm" {
  name = "${var.project_name}-lambda-api-ssm"
  role = aws_iam_role.lambda_api_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter"
      ]
      Resource = [
        aws_ssm_parameter.banksync_api_key.arn,
      ]
    }]
  })
}
resource "aws_iam_role_policy" "lambda_ssm" {
  name = "${var.project_name}-lambda-ssm"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter"
      ]
      Resource = [
        aws_ssm_parameter.banksync_webhook_secret.arn,
      ]
    }]
  })
}

# Sync-trigger lambda: read the BankSync API key. ssm:GetParameter alone is enough
# to decrypt the SecureString because it uses the AWS-managed aws/ssm key, which
# grants decrypt via IAM (same pattern as lambda_ssm above).
resource "aws_iam_role_policy" "sync_trigger_ssm" {
  name = "${var.project_name}-sync-trigger-ssm"
  role = aws_iam_role.sync_trigger_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter"
      ]
      Resource = [
        aws_ssm_parameter.banksync_api_key.arn,
      ]
    }]
  })
}

# Sync-trigger lambda: write to its own CloudWatch log group.
resource "aws_iam_role_policy" "sync_trigger_logs" {
  name = "${var.project_name}-sync-trigger-logs"
  role = aws_iam_role.sync_trigger_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ]
      Resource = [
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-sync-trigger:*"
      ]
    }]
  })
}

# Balance-poller lambda: write ONLY the home-loan balance row. Scoped to PutItem
# on the base table (the balance item is a single pk/sk row, never a GSI query),
# deliberately narrower than the webhook lambda's full CRUD.
resource "aws_iam_role_policy" "balance_poller_dynamodb" {
  name = "${var.project_name}-balance-poller-dynamodb"
  role = aws_iam_role.balance_poller_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:PutItem"
      ]
      Resource = [
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table",
      ]
    }]
  })
}

# Balance-poller lambda: read the BankSync API key. ssm:GetParameter alone
# decrypts the SecureString via the AWS-managed key (same pattern as
# sync_trigger_ssm).
resource "aws_iam_role_policy" "balance_poller_ssm" {
  name = "${var.project_name}-balance-poller-ssm"
  role = aws_iam_role.balance_poller_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter"
      ]
      Resource = [
        aws_ssm_parameter.banksync_api_key.arn,
      ]
    }]
  })
}

# Balance-poller lambda: write to its own CloudWatch log group.
resource "aws_iam_role_policy" "balance_poller_logs" {
  name = "${var.project_name}-balance-poller-logs"
  role = aws_iam_role.balance_poller_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ]
      Resource = [
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-balance-poller:*"
      ]
    }]
  })
}

# Authorizer lambda: read the shared-secret API auth token from SSM.
resource "aws_iam_role_policy" "authorizer_ssm" {
  name = "${var.project_name}-authorizer-ssm"
  role = aws_iam_role.authorizer_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter"
      ]
      Resource = [
        aws_ssm_parameter.api_auth_token.arn,
      ]
    }]
  })
}

# Authorizer lambda: write to its own CloudWatch log group.
resource "aws_iam_role_policy" "authorizer_logs" {
  name = "${var.project_name}-authorizer-logs"
  role = aws_iam_role.authorizer_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ]
      Resource = [
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-authorizer:*"
      ]
    }]
  })
}
