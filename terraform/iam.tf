data "aws_caller_identity" "current" {

}

resource "aws_iam_role" "transaction_exec" {
  name = "${var.project_name}-transaction-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role" "app_api_exec" {
  name = "${var.project_name}-app-api-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Execution role for the transaction-trigger lambda. Kept minimal on purpose: it
# only reads the BankSync API key from SSM and writes its own logs — no DynamoDB.
resource "aws_iam_role" "transaction_trigger_exec" {
  name = "${var.project_name}-transaction-trigger-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Execution role for the homeloan-request lambda. Reads the BankSync API key from
# SSM, writes the single home-loan balance row to DynamoDB (PutItem only — it
# never reads or mutates transactions), and writes its own logs.
resource "aws_iam_role" "homeloan_request_exec" {
  name = "${var.project_name}-homeloan-request-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Execution role for the push-receipts sweep lambda (WHIT-139). Reads the Expo access
# token from SSM, Queries the pending-receipts partition and Deletes resolved rows,
# UpdateItem-prunes dead device tokens, and writes its own logs.
resource "aws_iam_role" "push_receipts_exec" {
  name = "${var.project_name}-push-receipts-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "transaction_dynamodb" {
  name = "${var.project_name}-transaction-dynamodb"
  role = aws_iam_role.transaction_exec.id

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

resource "aws_iam_role_policy" "app_api_dynamodb" {
  name = "${var.project_name}-app-api-dynamodb"
  role = aws_iam_role.app_api_exec.id

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

resource "aws_iam_role_policy" "transaction_logs" {
  name = "${var.project_name}-transaction-logs"
  role = aws_iam_role.transaction_exec.id

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
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-transaction-ingest:*",
        # reprocess (WHIT-55), dedupe (WHIT-80) and age-out (WHIT-79) all reuse this
        # same transaction_exec role, so each needs its own log group granted
        # explicitly — an IAM log-group ARN is a literal, not a prefix match. Do NOT
        # collapse these to a wildcard "-transaction-*:*": that would also match the
        # transaction-trigger group (served by a different role), an over-grant.
        # Without its own entry a lambda is silently denied PutLogEvents and emits
        # nothing — which for the age-out sweep (whose entire product is its
        # dry-run/live log output) would hide whether it ran.
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-transaction-reprocess:*",
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-transaction-dedupe:*",
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-transaction-age-out:*",
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-transaction-date-backfill:*"
      ]
    }]
  })
}

resource "aws_iam_role_policy" "app_api_logs" {
  name = "${var.project_name}-app-api-logs"
  role = aws_iam_role.app_api_exec.id

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
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-app-api:*"]
    }]
  })
}

# app_api: read the BankSync API key to call the Enrichments API (WHIT-52).
# ssm:GetParameter alone decrypts the SecureString via the AWS-managed key (same
# pattern as transaction_trigger_ssm).
resource "aws_iam_role_policy" "app_api_ssm" {
  name = "${var.project_name}-app-api-ssm"
  role = aws_iam_role.app_api_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter"
      ]
      Resource = [
        aws_ssm_parameter.banksync_api_key.arn,
        # Anthropic key for AI spending insights (WHIT-104).
        aws_ssm_parameter.anthropic_api_key.arn,
      ]
    }]
  })
}
# Webhook (transaction-ingest) lambda SSM reads: its own BankSync webhook secret,
# plus the Expo access token that the shared push sender (shared/push.py) uses. The
# webhook is the push sender's runtime — it fires budget/milestone alerts (the
# notification cards that build on this foundation).
resource "aws_iam_role_policy" "transaction_ssm" {
  name = "${var.project_name}-transaction-ssm"
  role = aws_iam_role.transaction_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter"
      ]
      Resource = [
        aws_ssm_parameter.banksync_webhook_secret.arn,
        aws_ssm_parameter.expo_access_token.arn,
      ]
    }]
  })
}

# Transaction-trigger lambda: read the BankSync API key. ssm:GetParameter alone is
# enough to decrypt the SecureString because it uses the AWS-managed aws/ssm key,
# which grants decrypt via IAM (same pattern as transaction_ssm above).
resource "aws_iam_role_policy" "transaction_trigger_ssm" {
  name = "${var.project_name}-transaction-trigger-ssm"
  role = aws_iam_role.transaction_trigger_exec.id

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

# Transaction-trigger lambda: write to its own CloudWatch log group.
resource "aws_iam_role_policy" "transaction_trigger_logs" {
  name = "${var.project_name}-transaction-trigger-logs"
  role = aws_iam_role.transaction_trigger_exec.id

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
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-transaction-trigger:*"
      ]
    }]
  })
}

# Homeloan-request lambda: write ONLY the home-loan balance row. Scoped to PutItem
# on the base table (the balance item is a single pk/sk row, never a GSI query),
# deliberately narrower than the webhook lambda's full CRUD.
resource "aws_iam_role_policy" "homeloan_request_dynamodb" {
  name = "${var.project_name}-homeloan-request-dynamodb"
  role = aws_iam_role.homeloan_request_exec.id

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

# Homeloan-request lambda: read the BankSync API key. ssm:GetParameter alone
# decrypts the SecureString via the AWS-managed key (same pattern as
# transaction_trigger_ssm).
resource "aws_iam_role_policy" "homeloan_request_ssm" {
  name = "${var.project_name}-homeloan-request-ssm"
  role = aws_iam_role.homeloan_request_exec.id

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

# Homeloan-request lambda: write to its own CloudWatch log group.
resource "aws_iam_role_policy" "homeloan_request_logs" {
  name = "${var.project_name}-homeloan-request-logs"
  role = aws_iam_role.homeloan_request_exec.id

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
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-homeloan-request:*"
      ]
    }]
  })
}

# Push-receipts sweep lambda: Query the pending-receipts partition (list_pending),
# DeleteItem resolved rows (delete), and UpdateItem to prune a dead device token
# (DeviceRepository.remove uses a DELETE-expression UpdateItem). All hit base-table
# items — no GSI is touched — so this is scoped to the base table ARN only, matching
# homeloan_request_dynamodb's tight scoping. No Scan.
resource "aws_iam_role_policy" "push_receipts_dynamodb" {
  name = "${var.project_name}-push-receipts-dynamodb"
  role = aws_iam_role.push_receipts_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:Query",
        "dynamodb:DeleteItem",
        "dynamodb:UpdateItem"
      ]
      Resource = [
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table",
      ]
    }]
  })
}

# Push-receipts sweep lambda: read the Expo access token (the getReceipts calls carry
# Authorization: Bearer). ssm:GetParameter alone decrypts the SecureString via the
# AWS-managed key (same pattern as transaction_ssm).
resource "aws_iam_role_policy" "push_receipts_ssm" {
  name = "${var.project_name}-push-receipts-ssm"
  role = aws_iam_role.push_receipts_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter"
      ]
      Resource = [
        aws_ssm_parameter.expo_access_token.arn,
      ]
    }]
  })
}

# Push-receipts sweep lambda: write to its own CloudWatch log group.
resource "aws_iam_role_policy" "push_receipts_logs" {
  name = "${var.project_name}-push-receipts-logs"
  role = aws_iam_role.push_receipts_exec.id

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
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-push-receipts:*"
      ]
    }]
  })
}

# Goal-nudge sweep lambda execution role (WHIT-236).
resource "aws_iam_role" "goal_nudge_exec" {
  name = "${var.project_name}-goal-nudge-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Goal-nudge lambda: read goals/paycycle/device/account-balance rows (GetItem), write the
# per-(goal, cycle) notify marker + prune a dead device token (UpdateItem), and stash push
# receipts (PutItem — PushReceiptRepository.put). All base-table items, no GSI, no Scan —
# scoped to the base table ARN only, matching push_receipts_dynamodb's tight scoping.
resource "aws_iam_role_policy" "goal_nudge_dynamodb" {
  name = "${var.project_name}-goal-nudge-dynamodb"
  role = aws_iam_role.goal_nudge_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem"
      ]
      Resource = [
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table",
      ]
    }]
  })
}

# Goal-nudge lambda: read the Expo access token (send_push carries Authorization: Bearer).
# ssm:GetParameter alone decrypts the SecureString via the AWS-managed key.
resource "aws_iam_role_policy" "goal_nudge_ssm" {
  name = "${var.project_name}-goal-nudge-ssm"
  role = aws_iam_role.goal_nudge_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter"
      ]
      Resource = [
        aws_ssm_parameter.expo_access_token.arn,
      ]
    }]
  })
}

# Goal-nudge lambda: write to its own CloudWatch log group.
resource "aws_iam_role_policy" "goal_nudge_logs" {
  name = "${var.project_name}-goal-nudge-logs"
  role = aws_iam_role.goal_nudge_exec.id

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
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-goal-nudge:*"
      ]
    }]
  })
}
