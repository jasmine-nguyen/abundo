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

# Execution role for the balance-poller lambda. Reads the BankSync API key from
# SSM; reads + writes DynamoDB (the balance row it upserts, plus the milestone /
# repayment notify markers, device tokens, loan facts, and push receipts the milestone
# push and the WHIT-316 alarm check need — GetItem/PutItem/UpdateItem on the base table
# only, no transactions/GSI); and writes its own logs.
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
    Statement = [
      {
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
      },
      # DeleteItem is scoped to rule rows ONLY: the LeadingKeys condition restricts it to items
      # whose partition key is "RULE" (WHIT-528, the RuleRepository store). Kept a SEPARATE
      # statement — folding DeleteItem into the block above would grant table-wide delete, and
      # ForAllValues on a statement whose other actions don't populate LeadingKeys can bypass.
      # Base-table ARN only (you cannot delete through an index).
      {
        Effect = "Allow"
        Action = ["dynamodb:DeleteItem"]
        Resource = [
          "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table"
        ]
        Condition = {
          "ForAllValues:StringEquals" = {
            "dynamodb:LeadingKeys" = ["RULE"]
          }
        }
      }
    ]
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
        # reprocess (WHIT-55) and age-out (WHIT-79) reuse this same transaction_exec
        # role, so each needs its own log group granted explicitly — an IAM log-group
        # ARN is a literal, not a prefix match. Do NOT collapse these to a wildcard
        # "-transaction-*:*": that would also match the transaction-trigger group
        # (served by a different role), an over-grant. Without its own entry a lambda is
        # silently denied PutLogEvents and emits nothing — which for the age-out sweep
        # (whose entire product is its dry-run/live log output) would hide whether it ran.
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-transaction-reprocess:*",
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-transaction-age-out:*",
        # up-webhook (WHIT-313) reuses this role too, so it needs its own log group.
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-up-webhook:*"
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

# app_api: read the BankSync API key for the live balance refresh (WHIT-535).
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

# WHIT-537: app_api async-invokes the apply-rules worker for the background sweep. Scoped to that
# one function ARN — this is the only lambda the API is allowed to invoke.
resource "aws_iam_role_policy" "app_api_invoke_worker" {
  name = "${var.project_name}-app-api-invoke-worker"
  role = aws_iam_role.app_api_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.apply_rules_worker.arn]
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
        # Direct Up webhook (WHIT-313): the up-webhook lambda runs on this same role,
        # so it reads its signing secret + Up token from here.
        aws_ssm_parameter.up_personal_access_token.arn,
        aws_ssm_parameter.up_webhook_signing_secret.arn,
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

# Homeloan-request lambda: read + write the home-loan balance row AND the notification
# bookkeeping the daily poll performs — the prior balance (GetItem before upsert), the
# milestone + repayment notify markers (WHIT-301 / WHIT-316), device tokens, loan facts,
# and push-receipt stashes. GetItem/PutItem/UpdateItem on the base table, plus Query on the
# date-index GSI for the precise repayment-miss detector (WHIT-317), which lists the last
# week's home-loan repayments via get_transactions_by_date_range. Still narrower than the
# webhook lambda's full CRUD (no DeleteItem/BatchWrite).
#
# Before the first grant the role had PutItem only, so every GetItem/UpdateItem was denied at
# runtime and swallowed best-effort — silently disabling the WHIT-301 milestone push and
# leaving the WHIT-316 repayment-miss alarm dead-on-arrival (WHIT-318). WHIT-317 then added
# Query + index/* so the transaction-based detector can read the date-index (without it the
# detector throws on every Query, gets swallowed, and silently never alarms — the same trap).
resource "aws_iam_role_policy" "balance_poller_dynamodb" {
  name = "${var.project_name}-balance-poller-dynamodb"
  role = aws_iam_role.balance_poller_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ]
      Resource = [
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table",
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table/index/*"
      ]
    }]
  })
}

# Balance-poller lambda: read the BankSync API key. ssm:GetParameter alone
# decrypts the SecureString via the AWS-managed key (same pattern as
# transaction_trigger_ssm).
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

# WHIT-493: renamed the balance-poller's execution role and inline policies from
# homeloan_request_* to balance_poller_*. The deployed role/policy names change, so these
# are replacements, not in-place moves; the blocks migrate the state address. Garbage-collect
# once applied.
moved {
  from = aws_iam_role.homeloan_request_exec
  to   = aws_iam_role.balance_poller_exec
}
moved {
  from = aws_iam_role_policy.homeloan_request_dynamodb
  to   = aws_iam_role_policy.balance_poller_dynamodb
}
moved {
  from = aws_iam_role_policy.homeloan_request_ssm
  to   = aws_iam_role_policy.balance_poller_ssm
}
moved {
  from = aws_iam_role_policy.homeloan_request_logs
  to   = aws_iam_role_policy.balance_poller_logs
}

# Push-receipts sweep lambda: Query the pending-receipts partition (list_pending),
# DeleteItem resolved rows (delete), and UpdateItem to prune a dead device token
# (DeviceRepository.remove uses a DELETE-expression UpdateItem). All hit base-table
# items — no GSI is touched — so this is scoped to the base table ARN only, matching
# balance_poller_dynamodb's tight scoping. No Scan.
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

# Apply-rules worker execution role (WHIT-537). Its own tightly-scoped role — mirrors the
# one-role-per-lambda convention (balance_poller / goal_nudge) so its grants are auditable.
resource "aws_iam_role" "apply_rules_worker_exec" {
  name = "${var.project_name}-apply-rules-worker-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Apply-rules worker: it runs the SAME sweep the app_api handler runs, minus the cap — reads all
# history (Query on the date-index GSI), files each matched charge (UpdateItem), mints the inline
# "file this shop" rule (PutItem) and reads the rule store (GetItem/Query), and reads + updates its
# own job row (GetItem/PutItem/UpdateItem). No DeleteItem (it never deletes a rule; finished jobs
# self-expire via TTL). GetItem/PutItem/UpdateItem/Query on the base table + index/*, matching the
# read half of app_api_dynamodb.
resource "aws_iam_role_policy" "apply_rules_worker_dynamodb" {
  name = "${var.project_name}-apply-rules-worker-dynamodb"
  role = aws_iam_role.apply_rules_worker_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ]
      Resource = [
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table",
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.project_name}-dynamodb-table/index/*"
      ]
    }]
  })
}

# Apply-rules worker: write to its own CloudWatch log group.
resource "aws_iam_role_policy" "apply_rules_worker_logs" {
  name = "${var.project_name}-apply-rules-worker-logs"
  role = aws_iam_role.apply_rules_worker_exec.id

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
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-apply-rules-worker:*"
      ]
    }]
  })
}
