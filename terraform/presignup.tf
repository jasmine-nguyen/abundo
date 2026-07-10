# Pre-Sign-Up allowlist Lambda (WHIT-162). Rejects any Cognito sign-up whose email
# isn't in var.allowed_login_emails, so federated login (Google/Apple) can't
# provision arbitrary users once the JWT authorizer guards the API routes.
# Dependency-free: no shared layer, no SSM — just the ALLOWED_EMAILS env var.
data "archive_file" "presignup_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_presignup"
  output_path = "${path.module}/artifacts/presignup.zip"
}

resource "aws_lambda_function" "auth_presignup" {
  function_name    = "${var.project_name}-auth-presignup"
  role             = aws_iam_role.auth_presignup_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 10
  memory_size      = 128
  filename         = data.archive_file.presignup_zip.output_path
  source_code_hash = data.archive_file.presignup_zip.output_base64sha256

  environment {
    variables = {
      ALLOWED_EMAILS = join(",", var.allowed_login_emails)
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.auth_presignup.name
  }
}

# WHIT-224: label rename only (deployed function_name is unchanged from WHIT-219),
# so this is a pure state move — no destroy/recreate. Garbage-collect once applied.
moved {
  from = aws_lambda_function.presignup
  to   = aws_lambda_function.auth_presignup
}

resource "aws_cloudwatch_log_group" "auth_presignup" {
  name              = "/aws/lambda/${var.project_name}-auth-presignup"
  retention_in_days = 30
}

# Minimal exec role: only writes its own logs. No SSM, no DynamoDB, no shared layer.
resource "aws_iam_role" "auth_presignup_exec" {
  name = "${var.project_name}-auth-presignup-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "auth_presignup_logs" {
  name = "${var.project_name}-auth-presignup-logs"
  role = aws_iam_role.auth_presignup_exec.id

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
        "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.project_name}-auth-presignup:*"
      ]
    }]
  })
}

# Let Cognito invoke the trigger.
resource "aws_lambda_permission" "auth_presignup_cognito_invoke" {
  statement_id  = "AllowCognitoInvokePreSignUp"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.auth_presignup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.pool.arn
}

# WHIT-224: label rename only (statement_id + attributes unchanged) — pure state move.
moved {
  from = aws_lambda_permission.presignup_cognito_invoke
  to   = aws_lambda_permission.auth_presignup_cognito_invoke
}
