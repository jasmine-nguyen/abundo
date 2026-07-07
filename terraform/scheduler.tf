# Self-hosted BankSync sync scheduler.
#
# BankSync's built-in UI scheduler is capped at daily on our tier. This EventBridge
# Scheduler bypasses that by invoking the sync-trigger lambda on our own cadence
# (var.sync_schedule_expression), which in turn calls BankSync's REST sync endpoint
# for each feed.

# Role assumed by EventBridge Scheduler to invoke the sync-trigger lambda.
# (EventBridge Scheduler authorizes invocation through this role, so no
# aws_lambda_permission resource is required — unlike EventBridge Rules.)
resource "aws_iam_role" "sync_scheduler" {
  name = "${var.project_name}-sync-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "sync_scheduler_invoke" {
  name = "${var.project_name}-sync-scheduler-invoke"
  role = aws_iam_role.sync_scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.sync_trigger.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "banksync_sync" {
  name = "${var.project_name}-banksync-sync"

  # No jitter — run exactly on the cadence.
  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = var.sync_schedule_expression
  # Timezone only affects cron() expressions; ignored for rate(). Set so that if
  # the cadence is later switched to cron() it runs in local (Melbourne) time.
  schedule_expression_timezone = "Australia/Melbourne"

  target {
    arn      = aws_lambda_function.sync_trigger.arn
    role_arn = aws_iam_role.sync_scheduler.arn
  }
}

# Home-loan balance poller schedule (WHIT-8). A dedicated schedule (not folded
# into banksync_sync) so the balance can run daily — it moves ~daily, so there's
# no value polling it hourly like the transaction sync.

# Role assumed by EventBridge Scheduler to invoke the balance-poller lambda.
resource "aws_iam_role" "balance_scheduler" {
  name = "${var.project_name}-balance-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "balance_scheduler_invoke" {
  name = "${var.project_name}-balance-scheduler-invoke"
  role = aws_iam_role.balance_scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.balance_poller.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "homeloan_balance" {
  name = "${var.project_name}-homeloan-balance"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.balance_poll_schedule_expression
  schedule_expression_timezone = "Australia/Melbourne"

  target {
    arn      = aws_lambda_function.balance_poller.arn
    role_arn = aws_iam_role.balance_scheduler.arn
  }
}

# Stale-pending age-out schedule (WHIT-79). A dedicated daily schedule that invokes the
# age-out lambda LIVE — the target `input` passes {"dry_run": false}, since the lambda is
# dry-run-by-default (safe for a manual/empty invoke) and only mutates on that explicit
# input. If this input is ever lost the sweep reverts to dry-run and reaps nothing; the
# lambda's LIVE summary log line is what makes that silent reversion detectable.

# Role assumed by EventBridge Scheduler to invoke the age-out lambda.
resource "aws_iam_role" "age_out_scheduler" {
  name = "${var.project_name}-age-out-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "age_out_scheduler_invoke" {
  name = "${var.project_name}-age-out-scheduler-invoke"
  role = aws_iam_role.age_out_scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.age_out.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "pending_age_out" {
  name = "${var.project_name}-pending-age-out"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.age_out_schedule_expression
  schedule_expression_timezone = "Australia/Melbourne"

  target {
    arn      = aws_lambda_function.age_out.arn
    role_arn = aws_iam_role.age_out_scheduler.arn
    # Run LIVE (the lambda is dry-run unless told otherwise).
    input = jsonencode({ dry_run = false })
  }
}
