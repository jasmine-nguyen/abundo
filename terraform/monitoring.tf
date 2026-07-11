# Shared CloudWatch alerting (introduced by WHIT-79).
#
# The app's first alerting path: a shared SNS "alerts" topic that CloudWatch alarms
# notify. Built here for the age-out sweep (an unattended, destructive daily job that
# must not fail silently), but deliberately GENERIC — WHIT-108 (balance-poller failures)
# and WHIT-135 (dead-letter alarm) can attach their own alarms to this same topic instead
# of each standing up a separate notification path.

resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"
}

# Email subscription is created only when an alert_email is configured (count-gated like
# the Google IdP in cognito.tf). AWS sends a one-time confirmation email to this address
# that must be accepted before any alert is delivered.
resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# --- Age-out sweep alarms (WHIT-79) -----------------------------------------

# One datapoint each time the sweep logs a LIVE summary (i.e. actually ran live). A
# default_value of 0 means a run that logs only a DRY-RUN summary publishes 0, so a
# schedule that silently reverted to dry-run reads as 0 live runs (not merely no-data).
resource "aws_cloudwatch_log_metric_filter" "age_out_live_runs" {
  name           = "${var.project_name}-age-out-live-runs"
  log_group_name = aws_cloudwatch_log_group.transaction_age_out.name
  pattern        = "LIVE summary"

  metric_transformation {
    name          = "AgeOutLiveRuns"
    namespace     = "${var.project_name}/AgeOut"
    value         = "1"
    default_value = "0"
  }
}

# Breaches if the sweep has not logged a live run across two consecutive days — catches a
# broken schedule, a lost {"dry_run": false} input (silent revert to dry-run), or a lambda
# that stopped running (no-data is treated as breaching, so total silence still pages).
resource "aws_cloudwatch_metric_alarm" "age_out_not_running" {
  alarm_name          = "${var.project_name}-age-out-not-running"
  namespace           = "${var.project_name}/AgeOut"
  metric_name         = "AgeOutLiveRuns"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_description   = "The daily stale-pending age-out sweep has not run live for 2 days (schedule broken or silently reverted to dry-run)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# One datapoint per per-row delete failure (the sweep logs "age_out delete FAILED ..." and
# carries on best-effort). Sustained failures mean ghosts aren't being reaped.
resource "aws_cloudwatch_log_metric_filter" "age_out_delete_failures" {
  name           = "${var.project_name}-age-out-delete-failures"
  log_group_name = aws_cloudwatch_log_group.transaction_age_out.name
  pattern        = "delete FAILED"

  metric_transformation {
    name          = "AgeOutDeleteFailures"
    namespace     = "${var.project_name}/AgeOut"
    value         = "1"
    default_value = "0"
  }
}

# Breaches when one or more deletes failed in a day (DynamoDB throttling / IAM / a transient
# 5xx). Best-effort means the run still returns 200, so this is the signal that it didn't
# fully do its job.
resource "aws_cloudwatch_metric_alarm" "age_out_delete_failures" {
  alarm_name          = "${var.project_name}-age-out-delete-failures"
  namespace           = "${var.project_name}/AgeOut"
  metric_name         = "AgeOutDeleteFailures"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "The age-out sweep failed to delete one or more stale pendings in the last day (DynamoDB throttling / IAM)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# --- Push-receipts delivery-failure alarm (WHIT-139) ------------------------

# One datapoint per push Expo ACCEPTED but then failed to DELIVER — the receipts sweep
# logs a distinct "PUSH_DELIVERY_FAILED ..." line for each (MessageTooBig, RateExceeded,
# an expired credential, ...) and carries on best-effort. This is the "sent ≠ delivered"
# silent-failure signal: without it a budget/milestone alert can vanish unnoticed.
resource "aws_cloudwatch_log_metric_filter" "push_delivery_failures" {
  name           = "${var.project_name}-push-delivery-failures"
  log_group_name = aws_cloudwatch_log_group.push_receipts.name
  pattern        = "PUSH_DELIVERY_FAILED"

  metric_transformation {
    name          = "PushDeliveryFailures"
    namespace     = "${var.project_name}/PushReceipts"
    value         = "1"
    default_value = "0"
  }
}

# Breaches when one or more pushes failed to deliver in the last hour. A 30-min sweep
# means a failure surfaces within the hour; the SNS topic de-dupes the email. Best-effort
# means the sweep still returns cleanly, so this alarm is the only way the failure is seen.
resource "aws_cloudwatch_metric_alarm" "push_delivery_failures" {
  alarm_name          = "${var.project_name}-push-delivery-failures"
  namespace           = "${var.project_name}/PushReceipts"
  metric_name         = "PushDeliveryFailures"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "One or more Expo pushes were accepted but failed to deliver in the last hour (a budget/milestone alert may have silently not arrived)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# --- Goal-nudge sweep-failure alarm (WHIT-258) ------------------------------

# One datapoint each time the behind-pace nudge sweep logs a swallowed failure (the handler
# catches every exception, logs "goal-nudge sweep failed ...", and returns {"nudged": 0}).
# Because it swallows, AWS's built-in Lambda Errors metric never fires — this log-line metric
# is the only signal that a broken sweep isn't merely "nothing was behind". default_value 0
# so a healthy run publishes 0 rather than no-data.
resource "aws_cloudwatch_log_metric_filter" "goal_nudge_sweep_failures" {
  name           = "${var.project_name}-goal-nudge-sweep-failures"
  log_group_name = aws_cloudwatch_log_group.goal_nudge.name
  # Quoted → exact-substring match. The "goal-nudge" hyphen is a special char in the unquoted
  # filter grammar (leading "-" negates); quoting sidesteps any tokenization ambiguity so this
  # monitor for a silent failure can't itself silently never match. AWS-recommended for terms
  # with non-alphanumerics.
  pattern = "\"goal-nudge sweep failed\""

  metric_transformation {
    name          = "GoalNudgeSweepFailures"
    namespace     = "${var.project_name}/GoalNudge"
    value         = "1"
    default_value = "0"
  }
}

# Breaches when the sweep swallowed one or more failures in a day (a repo/IAM/paycycle error).
# The invocation still returns 200, so this log-line metric is the signal it didn't run cleanly.
resource "aws_cloudwatch_metric_alarm" "goal_nudge_sweep_failures" {
  alarm_name          = "${var.project_name}-goal-nudge-sweep-failures"
  namespace           = "${var.project_name}/GoalNudge"
  metric_name         = "GoalNudgeSweepFailures"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "The daily behind-pace goal-nudge sweep swallowed one or more failures in the last day (a broken sweep, invisible via the built-in Errors metric)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
