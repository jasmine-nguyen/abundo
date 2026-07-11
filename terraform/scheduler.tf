# Self-hosted BankSync sync scheduler.
#
# BankSync's built-in UI scheduler is capped at daily on our tier. This EventBridge
# Scheduler bypasses that by invoking the transaction-trigger lambda on our own cadence
# (var.sync_schedule_expression), which in turn calls BankSync's REST sync endpoint
# for each feed.

# Role assumed by EventBridge Scheduler to invoke the transaction-trigger lambda.
# (EventBridge Scheduler authorizes invocation through this role, so no
# aws_lambda_permission resource is required — unlike EventBridge Rules.)
resource "aws_iam_role" "transaction_scheduler" {
  name = "${var.project_name}-transaction-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "transaction_scheduler_invoke" {
  name = "${var.project_name}-transaction-scheduler-invoke"
  role = aws_iam_role.transaction_scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.transaction_trigger.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "transaction_sync" {
  name = "${var.project_name}-transaction-sync"

  # No jitter — run exactly on the cadence.
  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = var.sync_schedule_expression
  # Timezone only affects cron() expressions; ignored for rate(). Set so that if
  # the cadence is later switched to cron() it runs in local (Melbourne) time.
  schedule_expression_timezone = "Australia/Melbourne"

  target {
    arn      = aws_lambda_function.transaction_trigger.arn
    role_arn = aws_iam_role.transaction_scheduler.arn
  }
}

# Home-loan balance poll schedule (WHIT-8). A dedicated schedule (not folded
# into transaction_sync) so the balance can run daily — it moves ~daily, so there's
# no value polling it hourly like the transaction sync.

# Role assumed by EventBridge Scheduler to invoke the homeloan-request lambda.
resource "aws_iam_role" "homeloan_scheduler" {
  name = "${var.project_name}-homeloan-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "homeloan_scheduler_invoke" {
  name = "${var.project_name}-homeloan-scheduler-invoke"
  role = aws_iam_role.homeloan_scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.homeloan_request.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "homeloan_poll" {
  name = "${var.project_name}-homeloan-poll"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.balance_poll_schedule_expression
  schedule_expression_timezone = "Australia/Melbourne"

  target {
    arn      = aws_lambda_function.homeloan_request.arn
    role_arn = aws_iam_role.homeloan_scheduler.arn
  }
}

# Push-receipts sweep schedule (WHIT-139). A dedicated schedule that invokes the
# push-receipts lambda every 30 min to resolve accepted pushes against Expo's receipts
# endpoint. Its own role + per-lambda invoke policy (EventBridge Scheduler authorizes
# via this role, so no aws_lambda_permission is needed).
resource "aws_iam_role" "push_receipts_scheduler" {
  name = "${var.project_name}-push-receipts-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "push_receipts_scheduler_invoke" {
  name = "${var.project_name}-push-receipts-scheduler-invoke"
  role = aws_iam_role.push_receipts_scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.push_receipts.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "push_receipts_sweep" {
  name = "${var.project_name}-push-receipts-sweep"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.push_receipts_schedule_expression
  schedule_expression_timezone = "Australia/Melbourne"

  target {
    arn      = aws_lambda_function.push_receipts.arn
    role_arn = aws_iam_role.push_receipts_scheduler.arn
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
      Resource = [aws_lambda_function.transaction_age_out.arn]
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
    arn      = aws_lambda_function.transaction_age_out.arn
    role_arn = aws_iam_role.age_out_scheduler.arn
    # Run LIVE (the lambda is dry-run unless told otherwise).
    input = jsonencode({ dry_run = false })
  }
}

# Behind-pace goal-nudge schedule (WHIT-236). A dedicated daily schedule — the per-(goal,
# cycle) dedupe makes a daily run fire at most once per goal per cycle, so daily is the right
# cadence to catch a goal as its deadline arrives. Its own role + per-lambda invoke policy
# (EventBridge Scheduler authorizes via this role, so no aws_lambda_permission is needed).
resource "aws_iam_role" "goal_nudge_scheduler" {
  name = "${var.project_name}-goal-nudge-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "goal_nudge_scheduler_invoke" {
  name = "${var.project_name}-goal-nudge-scheduler-invoke"
  role = aws_iam_role.goal_nudge_scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [aws_lambda_function.goal_nudge.arn]
    }]
  })
}

resource "aws_scheduler_schedule" "goal_nudge" {
  name = "${var.project_name}-goal-nudge"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.goal_nudge_schedule_expression
  schedule_expression_timezone = "Australia/Melbourne"

  target {
    arn      = aws_lambda_function.goal_nudge.arn
    role_arn = aws_iam_role.goal_nudge_scheduler.arn
  }
}
