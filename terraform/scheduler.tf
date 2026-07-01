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
  # the cadence is later switched to cron() it runs in local (Sydney) time.
  schedule_expression_timezone = "Australia/Sydney"

  target {
    arn      = aws_lambda_function.sync_trigger.arn
    role_arn = aws_iam_role.sync_scheduler.arn
  }
}
