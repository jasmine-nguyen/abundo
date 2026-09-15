# Install the webhook lambda's third-party deps into lambda/ before zipping.
# These are gitignored build artifacts (not source); without this step a fresh
# clone would zip the function without them (which is exactly how the deployed
# webhook lost `standardwebhooks` and started 500ing). The build command lives in
# scripts/build_terraform_artifacts.sh so CI and the local apply share one recipe
# (CI can't rely on this provisioner re-running — see that script's header).
resource "null_resource" "prepare_lambda_deps" {
  triggers = {
    requirements = filesha256("${path.module}/../lambda/requirements.txt")
    build_script = filesha256("${path.module}/../scripts/build_terraform_artifacts.sh")
  }

  provisioner "local-exec" {
    command = "bash ${path.module}/../scripts/build_terraform_artifacts.sh webhook"
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
# shared layer. Previously this zipped the raw lambda_api/ dir — a leftover stale
# repository.py once landed in /var/task, shadowed the layer's fresh copy, and
# 500'd every route on import. Staging a clean dir keeps the package deterministic
# regardless of local cruft.
#
# The explicit true-source allowlist and the copy live in
# scripts/build_terraform_artifacts.sh (the single recipe CI and local apply
# share). The trigger below hashes lambda_api/*.py with a glob: that only affects
# WHEN we rebuild — the copy still uses the script's explicit allowlist, so on-disk
# cruft never ships.
resource "null_resource" "prepare_lambda_api" {
  triggers = {
    sources      = sha256(join("", [for f in fileset("${path.module}/../lambda_api", "*.py") : filesha256("${path.module}/../lambda_api/${f}")]))
    build_script = filesha256("${path.module}/../scripts/build_terraform_artifacts.sh")
  }

  provisioner "local-exec" {
    command = "bash ${path.module}/../scripts/build_terraform_artifacts.sh lambda_api"
  }
}

data "archive_file" "lambda_api_zip" {
  depends_on  = [null_resource.prepare_lambda_api]
  type        = "zip"
  source_dir  = "${path.module}/build/lambda_api"
  output_path = "${path.module}/artifacts/lambda_api.zip"
}

# Transaction-trigger lambda source. Contains only handler.py; constants.py and
# ssm.py come from the shared layer.
data "archive_file" "sync_trigger_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_sync_trigger"
  output_path = "${path.module}/artifacts/sync_trigger.zip"
}

# Balance-poller lambda source. Contains only handler.py; constants.py, ssm.py,
# and repository.py come from the shared layer.
data "archive_file" "balance_poller_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_balance_poller"
  output_path = "${path.module}/artifacts/balance_poller.zip"
}

# Push-receipts sweep lambda source (WHIT-139). Contains only handler.py; push.py,
# repository_push_receipt.py, repository_device.py, ssm.py come from the shared layer.
data "archive_file" "push_receipts_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_push_receipts"
  output_path = "${path.module}/artifacts/push_receipts.zip"
}

# Goal-nudge sweep lambda source (WHIT-236). Contains only handler.py; goal_nudge.py,
# goal_pace.py, push.py, repository.py, repository_notify.py, spend.py come from the shared layer.
data "archive_file" "goal_nudge_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_goal_nudge"
  output_path = "${path.module}/artifacts/goal_nudge.zip"
}

resource "aws_lambda_function" "transaction_ingest" {
  function_name    = "${var.project_name}-transaction-ingest"
  role             = aws_iam_role.transaction_exec.arn
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
    log_group  = aws_cloudwatch_log_group.transaction_ingest.name
  }
}

# Direct Up-bank webhook (WHIT-313): notify-only. Receives Up's own webhook for the
# home-loan account and sends the instant repayment push. Reuses the webhook zip
# (../lambda already contains up_webhook.py) and the transaction_exec role — which
# already grants the DynamoDB access the notify markers/device tokens need, plus (with
# the SSM additions in iam.tf) the two Up secrets. Public, API-Gateway-triggered
# (apigateway.tf); no schedule, no event source, writes no transactions.
resource "aws_lambda_function" "up_webhook" {
  function_name    = "${var.project_name}-up-webhook"
  role             = aws_iam_role.transaction_exec.arn
  handler          = "up_webhook.lambda_handler"
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
    log_group  = aws_cloudwatch_log_group.up_webhook.name
  }
}

# Manual recovery lambda (WHIT-55): re-drives dead-lettered FAILED# rows through
# normalise + insert. Reuses the webhook zip (source_dir ../lambda already contains
# reprocess.py) and the transaction_exec role — which already has Query / DeleteItem /
# BatchWriteItem / GetItem, so NO DynamoDB IAM change is needed. Invoked manually
# (AWS console Test button / `aws lambda invoke`); it has no event source, schedule,
# or API integration, so nothing triggers it unintentionally. Longer timeout than
# the webhook since a backlog is processed one row at a time.
resource "aws_lambda_function" "transaction_reprocess" {
  function_name    = "${var.project_name}-transaction-reprocess"
  role             = aws_iam_role.transaction_exec.arn
  handler          = "reprocess.lambda_handler"
  runtime          = "python3.12"
  timeout          = 300
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
    log_group  = aws_cloudwatch_log_group.transaction_reprocess.name
  }
}

# Stale-pending age-out sweep (WHIT-79): a daily scheduled reaper that deletes pending
# rows older than PENDING_AGE_OUT_DAYS that never got a matching posted (reversed
# pre-auth / unbalanced count). Like reprocess it reuses the webhook zip
# (../lambda already contains age_out.py) and the transaction_exec role (Query / DeleteItem
# already granted). UNLIKE reprocess it IS scheduled (see scheduler.tf), and the schedule
# passes {"dry_run": false} so it runs live; a manual/empty invoke stays dry-run-safe.
resource "aws_lambda_function" "transaction_age_out" {
  function_name    = "${var.project_name}-transaction-age-out"
  role             = aws_iam_role.transaction_exec.arn
  handler          = "age_out.lambda_handler"
  runtime          = "python3.12"
  timeout          = 300
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
    log_group  = aws_cloudwatch_log_group.transaction_age_out.name
  }
}

# WHIT-186: 512 MB (was 128, the smallest tier). Lambda scales CPU with memory, so 128 MB
# gives the least CPU -> slow cold starts; under the app's ~9-read launch burst that tipped a
# transient 503 on the heaviest read. 512 MB ~= 4x the CPU for a few cents/month at single-user
# volume, cutting cold-start + on-read compute (the /breakdown and /budgets windowed-transaction
# rollups). No provisioned concurrency — overkill for one user; revisit only if 503s persist.
resource "aws_lambda_function" "app_api" {
  function_name    = "${var.project_name}-app-api"
  role             = aws_iam_role.app_api_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 512
  filename         = data.archive_file.lambda_api_zip.output_path
  source_code_hash = data.archive_file.lambda_api_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.dynamodb_table.name
      # WHIT-537: the async apply-rules POST invokes this worker (InvocationType=Event). The name
      # is passed in (not hard-coded) so the handler asks the environment which function to invoke.
      APPLY_RULES_WORKER_FUNCTION = aws_lambda_function.apply_rules_worker.function_name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.app_api.name
  }
}

# WHIT-537: runs the uncapped "Apply my rules over all history" sweep as a background job. Reuses
# the app_api zip (the sweep IS lambda_api code — apply_rules_worker.py + the shared write phase in
# handler.py) rather than the webhook zip, so no apply-rules logic has to move into shared/ (which
# would drag APPLY_RULES_* into shared/constants.py, the WHIT-136 landmine). Async-invoked by
# app_api (no API integration, no event source, like transaction_reprocess); 300s so a large sweep
# finishes; 512 MB to match app_api (same whole-history windowed read + in-memory plan).
resource "aws_lambda_function" "apply_rules_worker" {
  function_name    = "${var.project_name}-apply-rules-worker"
  role             = aws_iam_role.apply_rules_worker_exec.arn
  handler          = "apply_rules_worker.lambda_handler"
  runtime          = "python3.12"
  timeout          = 300
  memory_size      = 512
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
    log_group  = aws_cloudwatch_log_group.apply_rules_worker.name
  }
}

# Triggered on a schedule by EventBridge Scheduler (see scheduler.tf) to kick off
# BankSync incremental syncs. Only needs the shared layer for constants.py/ssm.py;
# no DynamoDB access (BankSync pushes results to the webhook lambda instead).
# The timeout scales with the feed count: SYNC_FEED_IDS is POSTed serially at up to
# SYNC_TIMEOUT_SECONDS (30) each, so at 60s a third feed could be killed mid-loop
# before its sync fired, and before the per-feed error line ran.
resource "aws_lambda_function" "transaction_trigger" {
  function_name    = "${var.project_name}-transaction-trigger"
  role             = aws_iam_role.transaction_trigger_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 300
  memory_size      = 128
  filename         = data.archive_file.sync_trigger_zip.output_path
  source_code_hash = data.archive_file.sync_trigger_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.transaction_trigger.name
  }
}

# Triggered daily by EventBridge Scheduler (see scheduler.tf) to poll the live Up
# home-loan balance from BankSync (getBalance) and store it (WHIT-8). Needs the
# shared layer (constants.py/ssm.py/repository.py) AND DynamoDB PutItem +
# TABLE_NAME (unlike the transaction trigger, which writes nothing itself).
# The timeout scales with the account count: BALANCE_SOURCES is fetched serially at up
# to HOMELOAN_BALANCE_TIMEOUT_SECONDS (30) each, so at 60s two slow bank calls exhausted
# the budget and the remaining accounts were dropped for the day with no per-account log
# line. 300 matches the other sweeps.
resource "aws_lambda_function" "balance_poller" {
  function_name    = "${var.project_name}-balance-poller"
  role             = aws_iam_role.balance_poller_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 300
  memory_size      = 128
  filename         = data.archive_file.balance_poller_zip.output_path
  source_code_hash = data.archive_file.balance_poller_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.dynamodb_table.name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.balance_poller.name
  }
}

# Triggered every 30 min by EventBridge Scheduler (see scheduler.tf) to poll Expo's
# getReceipts for the true delivery outcome of each accepted push, prune dead tokens,
# and log a PUSH_DELIVERY_FAILED line (drives the delivery-failure alarm) on a hard
# failure (WHIT-139). Needs the shared layer (push.py/repository_push_receipt.py/
# repository_device.py/ssm.py) AND DynamoDB Query/Delete/Update + TABLE_NAME.
resource "aws_lambda_function" "push_receipts" {
  function_name    = "${var.project_name}-push-receipts"
  role             = aws_iam_role.push_receipts_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 128
  filename         = data.archive_file.push_receipts_zip.output_path
  source_code_hash = data.archive_file.push_receipts_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.dynamodb_table.name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.push_receipts.name
  }
}

# Goal-nudge sweep lambda (WHIT-236). Scheduled daily; sends the behind-pace push. Its own
# tightly-scoped role (goal_nudge_exec) — reads goals/paycycle/device/balances, writes notify
# markers + push-receipt rows — mirroring push_receipts / balance_poller.
resource "aws_lambda_function" "goal_nudge" {
  function_name    = "${var.project_name}-goal-nudge"
  role             = aws_iam_role.goal_nudge_exec.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 128
  filename         = data.archive_file.goal_nudge_zip.output_path
  source_code_hash = data.archive_file.goal_nudge_zip.output_base64sha256
  layers           = [aws_lambda_layer_version.shared.arn]

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.dynamodb_table.name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.goal_nudge.name
  }
}

# WHIT-224: label renames only (deployed function_name values are unchanged from
# WHIT-219), so these are pure state moves — no destroy/recreate. Same pattern as
# the WHIT-153 route moves in apigateway.tf; garbage-collect once applied.
moved {
  from = aws_lambda_function.lambda
  to   = aws_lambda_function.transaction_ingest
}
moved {
  from = aws_lambda_function.reprocess
  to   = aws_lambda_function.transaction_reprocess
}
moved {
  from = aws_lambda_function.age_out
  to   = aws_lambda_function.transaction_age_out
}
moved {
  from = aws_lambda_function.lambda_api
  to   = aws_lambda_function.app_api
}
moved {
  from = aws_lambda_function.sync_trigger
  to   = aws_lambda_function.transaction_trigger
}
# WHIT-493: the "homeloan_request" lambda actually polls every account's balance, so
# rename its address and deployed names to balance_poller (matching lambda_balance_poller/
# and the rest of the repo). The deployed function_name / log-group name change, so the
# function and log group are REPLACED, not moved in place; these blocks migrate the state
# address so terraform doesn't see the old address as a separate resource to destroy.
# Garbage-collect once applied.
moved {
  from = aws_lambda_function.homeloan_request
  to   = aws_lambda_function.balance_poller
}
moved {
  from = aws_cloudwatch_log_group.homeloan_request
  to   = aws_cloudwatch_log_group.balance_poller
}

resource "aws_cloudwatch_log_group" "transaction_ingest" {
  name              = "/aws/lambda/${var.project_name}-transaction-ingest"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "up_webhook" {
  name              = "/aws/lambda/${var.project_name}-up-webhook"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "app_api" {
  name              = "/aws/lambda/${var.project_name}-app-api"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "apply_rules_worker" {
  name              = "/aws/lambda/${var.project_name}-apply-rules-worker"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "transaction_reprocess" {
  name              = "/aws/lambda/${var.project_name}-transaction-reprocess"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "transaction_age_out" {
  name              = "/aws/lambda/${var.project_name}-transaction-age-out"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "transaction_trigger" {
  name              = "/aws/lambda/${var.project_name}-transaction-trigger"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "balance_poller" {
  name              = "/aws/lambda/${var.project_name}-balance-poller"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "push_receipts" {
  name              = "/aws/lambda/${var.project_name}-push-receipts"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "goal_nudge" {
  name              = "/aws/lambda/${var.project_name}-goal-nudge"
  retention_in_days = 30
}
