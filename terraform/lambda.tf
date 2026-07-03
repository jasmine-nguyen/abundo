# Install the webhook lambda's third-party deps into lambda/ before zipping.
# These are gitignored build artifacts (not source); without this step a fresh
# clone would zip the function without them (which is exactly how the deployed
# webhook lost `standardwebhooks` and started 500ing). Installed --no-deps on
# purpose: the signature-verify path we use is pure-stdlib, and standardwebhooks'
# declared deps (httpx, wrapt with a compiled .so, ...) are unused and would ship
# an architecture-incompatible wheel into the Linux runtime.
resource "null_resource" "prepare_lambda_deps" {
  triggers = {
    requirements = filesha256("${path.module}/../lambda/requirements.txt")
  }

  provisioner "local-exec" {
    command = "python3 -m pip install --no-deps --quiet --target ${path.module}/../lambda -r ${path.module}/../lambda/requirements.txt"
  }
}

# Webhook lambda source: only its webhook-specific modules (handler.py,
# repository.py with the reconciliation path, banksync.py). constants.py,
# models.py, encoders.py, and ssm.py come from the shared layer attached below —
# same single-source pattern as the api/sync/authorizer lambdas (WHIT-88).
data "archive_file" "lambda_zip" {
  depends_on  = [null_resource.prepare_lambda_deps]
  type        = "zip"
  source_dir  = "${path.module}/../lambda"
  output_path = "${path.module}/artifacts/lambda.zip"
}

# Stage the lambda_api package from ONLY its true source (handler.py + its own
# constants.py, which intentionally shadows the layer's constants with
# category-aware values). repository.py, models.py, and encoders.py come from the
# shared layer. Previously this zipped the raw lambda_api/ dir, which is a
# gitignored build dir ("allowlist only true source" per .gitignore) — so it
# shipped whatever stale copies happened to be on disk. A leftover repository.py
# predating CategoryNotFoundError landed in /var/task, shadowed the layer's fresh
# copy, and 500'd every route on import. Staging a clean dir makes the package
# deterministic regardless of local cruft.
resource "null_resource" "prepare_lambda_api" {
  triggers = {
    handler     = filesha256("${path.module}/../lambda_api/handler.py")
    constants   = filesha256("${path.module}/../lambda_api/constants.py")
    enrichments = filesha256("${path.module}/../lambda_api/banksync_enrichments.py")
  }

  provisioner "local-exec" {
    command = "rm -rf ${path.module}/build/lambda_api && mkdir -p ${path.module}/build/lambda_api && cp ${path.module}/../lambda_api/handler.py ${path.module}/../lambda_api/constants.py ${path.module}/../lambda_api/banksync_enrichments.py ${path.module}/build/lambda_api/"
  }
}

data "archive_file" "lambda_api_zip" {
  depends_on  = [null_resource.prepare_lambda_api]
  type        = "zip"
  source_dir  = "${path.module}/build/lambda_api"
  output_path = "${path.module}/artifacts/lambda_api.zip"
}

# Sync-trigger lambda source. Contains only handler.py; constants.py and ssm.py
# come from the shared layer.
data "archive_file" "sync_trigger_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_sync_trigger"
  output_path = "${path.module}/artifacts/sync_trigger.zip"
}

# Authorizer lambda source. Contains only handler.py; constants.py and ssm.py
# come from the shared layer.
data "archive_file" "authorizer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_authorizer"
  output_path = "${path.module}/artifacts/authorizer.zip"
}

resource "aws_lambda_function" "lambda" {
  function_name    = "${var.project_name}-lambda"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 128
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.dynamodb_table.name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }
}

resource "aws_lambda_function" "lambda_api" {
  function_name    = "${var.project_name}-lambda-api"
  role             = aws_iam_role.lambda_api_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 128
  filename         = data.archive_file.lambda_api_zip.output_path
  source_code_hash = data.archive_file.lambda_api_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.dynamodb_table.name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda_api.name
  }
}

# Triggered on a schedule by EventBridge Scheduler (see scheduler.tf) to kick off
# BankSync incremental syncs. Only needs the shared layer for constants.py/ssm.py;
# no DynamoDB access (BankSync pushes results to the webhook lambda instead).
resource "aws_lambda_function" "sync_trigger" {
  function_name    = "${var.project_name}-sync-trigger"
  role             = aws_iam_role.sync_trigger_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 128
  filename         = data.archive_file.sync_trigger_zip.output_path
  source_code_hash = data.archive_file.sync_trigger_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.sync_trigger.name
  }
}

# API Gateway authorizer: checks the shared-secret token on the /enrichments
# routes (WHIT-52). Only needs the shared layer for constants.py/ssm.py; no
# DynamoDB. TABLE_NAME is not set — it never touches the table.
resource "aws_lambda_function" "authorizer" {
  function_name    = "${var.project_name}-authorizer"
  role             = aws_iam_role.authorizer_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 10
  memory_size      = 128
  filename         = data.archive_file.authorizer_zip.output_path
  source_code_hash = data.archive_file.authorizer_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.authorizer.name
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.project_name}-lambda"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "lambda_api" {
  name              = "/aws/lambda/${var.project_name}-lambda-api"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "sync_trigger" {
  name              = "/aws/lambda/${var.project_name}-sync-trigger"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "authorizer" {
  name              = "/aws/lambda/${var.project_name}-authorizer"
  retention_in_days = 30
}
