# Shared CloudWatch alerting (introduced by WHIT-79).
#
# The app's first alerting path: a shared SNS "alerts" topic that CloudWatch alarms
# notify. Built here for the age-out sweep (an unattended, destructive daily job that
# must not fail silently), but deliberately GENERIC — the balance-poll stale alarm (WHIT-645)
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

  # Refuse to destroy the subscription if alert_email ever arrives empty (e.g. a
  # deploy without TF_VAR_alert_email): count would drop to 0 and Terraform would
  # tear it down (requiring the one-time email re-confirmation to restore). Turns a
  # silent teardown into a loud apply error. To intentionally remove it, delete this
  # line first. Inert while alert_email is unset (count 0 = nothing to protect).
  lifecycle {
    prevent_destroy = true
  }
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

# --- Goal-nudge liveness alarms (WHIT-260) ----------------------------------
# The WHIT-258 alarm above only fires when the sweep RUNS and logs a swallowed failure. It is
# blind to the sweep NEVER running (schedule disabled/misconfigured) or CRASHING ON IMPORT
# (before the try/except in handler.py) — both produce no "failed" line, so that metric stays 0
# and its notBreaching alarm sits green during a total outage. These two close that gap.

# One datapoint each time the sweep completes a healthy run (handler.py logs
# "goal-nudge sweep: N nudge(s) sent" ONLY on success — the swallowed-failure path returns
# before it). This is the heartbeat. Quoted → exact-substring match (parentheses are literal;
# mirrors the WHIT-258 quoting so this silent-failure monitor can't itself silently never
# match). Keep the pattern and handler.py:42 in lockstep. default_value 0 so a live run still
# publishes a datapoint.
resource "aws_cloudwatch_log_metric_filter" "goal_nudge_runs" {
  name           = "${var.project_name}-goal-nudge-runs"
  log_group_name = aws_cloudwatch_log_group.goal_nudge.name
  pattern        = "\"nudge(s) sent\""

  metric_transformation {
    name          = "GoalNudgeRuns"
    namespace     = "${var.project_name}/GoalNudge"
    value         = "1"
    default_value = "0"
  }
}

# Breaches if the sweep has not logged a healthy run across two consecutive days — catches a
# disabled schedule, an import crash, or a sweep that always fails. treat_missing_data
# "breaching" is load-bearing: total silence (no invocation → empty log group → no datapoints)
# MUST page; notBreaching here would reintroduce the exact blind spot this alarm exists to fix.
# Mirrors the age-out sibling (age_out_not_running).
resource "aws_cloudwatch_metric_alarm" "goal_nudge_not_running" {
  alarm_name          = "${var.project_name}-goal-nudge-not-running"
  namespace           = "${var.project_name}/GoalNudge"
  metric_name         = "GoalNudgeRuns"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_description   = "The daily behind-pace goal-nudge sweep has not logged a healthy run for 2 days (schedule disabled, crashing on import, or always failing)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Fast crash detection: the built-in Lambda Errors metric fires only on an infra failure the
# handler CAN'T swallow — an import crash (before the try), a timeout, or OOM. A short period so
# a crash pages within minutes rather than waiting on the 2-day heartbeat above. notBreaching:
# no invocation is not an error (the never-ran case belongs to the heartbeat alarm).
resource "aws_cloudwatch_metric_alarm" "goal_nudge_errors" {
  alarm_name          = "${var.project_name}-goal-nudge-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.goal_nudge.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "The goal-nudge lambda errored at the infra level (import crash / timeout / OOM) — a failure it cannot swallow, so it never reaches the sweep-failure log line."
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# --- Transaction-trigger failure alarm (WHIT-644) ---------------------------
# A rejected BankSync key means no sync ever starts, so BankSync's "Sync failed" email never
# fires, and the balance poller (same key) fails too, blinding the WHIT-606 stall alert. The
# trigger raises when any feed fails, so the built-in Errors metric counts each failed run.
# A 3600s period with 3 of 3 datapoints counts failed HOURS (matches the hourly schedule), so
# async retries (up to 3 errors in one hour) can't page early.
resource "aws_cloudwatch_metric_alarm" "transaction_trigger_errors" {
  alarm_name          = "${var.project_name}-transaction-trigger-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.transaction_trigger.function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "The hourly BankSync sync has failed 3 hours in a row, so no transactions are arriving. Check /aws/lambda/abundo-transaction-trigger. 'HTTP Error 401' means BankSync rejected our key: make a new key in the BankSync dashboard and save it to /abundo/banksync-api-key in SSM (the next hourly run picks it up). The daily balance poll also uses this key; if Accounts balances look stale the next day, re-run abundo-balance-poller. 'HTTP Error 404' means a feed was deleted: update SYNC_FEED_IDS in shared/constants.py."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# --- Balance-poller health alarm (WHIT-645) ---------------------------------
# The balance poller swallows every failure (key fetch, home-loan read, each account read), so
# its Errors metric never fires. Instead, only a fully clean run (home loan + every
# BALANCE_SOURCES account stored) logs BALANCE_POLL_ALL_STORED — the heartbeat. Keep the pattern
# and lambda_balance_poller/handler.py's log line in lockstep. default_value 0 so a failing run
# still publishes a datapoint.
resource "aws_cloudwatch_log_metric_filter" "balance_poll_all_stored" {
  name           = "${var.project_name}-balance-poll-all-stored"
  log_group_name = aws_cloudwatch_log_group.balance_poller.name
  pattern        = "BALANCE_POLL_ALL_STORED"

  metric_transformation {
    name          = "BalancePollAllStored"
    namespace     = "${var.project_name}/BalancePoller"
    value         = "1"
    default_value = "0"
  }
}

# Breaches when 2 daily runs in a row had no clean run (the period matches the daily schedule).
# treat_missing_data "breaching" is load-bearing: a disabled schedule, an import crash or a
# timeout leaves no log line at all, and that silence MUST page.
resource "aws_cloudwatch_metric_alarm" "balance_poll_stale" {
  alarm_name          = "${var.project_name}-balance-poll-stale"
  namespace           = "${var.project_name}/BalancePoller"
  metric_name         = "BalancePollAllStored"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_description   = "Account balances haven't all refreshed for 2 days. Check /aws/lambda/abundo-balance-poller for 'balance poll failed' lines, which name the account. If the transaction-trigger alarm is also firing, it's the BankSync key: fix that first. 404 = an account ID changed: update BALANCE_SOURCES / ACCOUNT_ID_MAP in shared/constants.py. No log lines = the schedule is off or the lambda is crashing. After fixing, re-run abundo-balance-poller."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# --- Up-webhook health alarm (WHIT-316, merged in WHIT-655) ------------------
# WHIT-313 made the direct Up webhook the SOLE home-loan repayment notifier (the slow
# BankSync-path push was removed), so a silent stop = a missed alert with no safety net.
# WHIT-655: AWS bills per alarmed metric (10 free a month), so the four Up webhook alarms
# (processing failed, token rejected, no device tokens, repayment missed) became ONE alarm
# on ONE metric, UpWebhookRepaymentPushFailures. Two filters publish it: the webhook's own
# failures and the balance-poller's repayment-missed safety net. Don't split it back into
# separate alarms, and don't merge with metric math instead: a metric-math alarm is billed
# per metric it reads, so it saves nothing.

# Loud failures, all on the up_webhook log group. The `?a ?b ?c` pattern is an OR:
# - "up webhook: processing failed" (quoted → exact-substring match, the line has spaces and a
#   colon): a validly-signed Up delivery failed to fetch/push. The handler catches it and
#   returns a 500 dict, so AWS's built-in Lambda Errors metric never fires.
# - UP_WEBHOOK_TOKEN_REJECTED: Up answered 401/403 to our personal access token.
# - UP_WEBHOOK_NO_DEVICE_TOKENS: a qualifying repayment arrived but no phone is registered.
#   This path returns without raising, so it logs no "processing failed" line.
# Keep this pattern and up_webhook.py's log lines in lockstep so this silent-failure monitor
# can't itself silently never match. The 401 (rotated signing secret) path is deliberately NOT
# alarmed: the route is public, so scanners make 401 noise — the repayment-missed safety net
# below catches that case instead.
resource "aws_cloudwatch_log_metric_filter" "up_webhook_failures" {
  name           = "${var.project_name}-up-webhook-failures"
  log_group_name = aws_cloudwatch_log_group.up_webhook.name
  pattern        = "?\"up webhook: processing failed\" ?UP_WEBHOOK_TOKEN_REJECTED ?UP_WEBHOOK_NO_DEVICE_TOKENS"

  metric_transformation {
    name          = "UpWebhookRepaymentPushFailures"
    namespace     = "${var.project_name}/UpWebhook"
    value         = "1"
    default_value = "0"
  }
}

# Silent failures — the real backstop, on the balance_poller log group. One datapoint when
# the daily poll finds a repayment landed but no push fired within the lookback window (handler.py logs
# "UP_WEBHOOK_REPAYMENT_MISSED ..."). TWO independent detectors log this token, so the
# substring pattern catches both: the coarse balance-drop check (WHIT-316) and the precise
# transaction-based check (WHIT-317, tagged "source=txn"). This is the ONLY signal for the
# silent modes: a re-linked account (wrong id → 200, no push) or a deregistered webhook
# (never runs). Both read from the bank feed, independent of the Up webhook, so the miss is
# still seen when the webhook is broken. It publishes the SAME metric as up_webhook_failures,
# so the one alarm below covers both. Keep this pattern and handler.py in lockstep.
resource "aws_cloudwatch_log_metric_filter" "up_webhook_repayment_missed" {
  name           = "${var.project_name}-up-webhook-repayment-missed"
  log_group_name = aws_cloudwatch_log_group.balance_poller.name
  pattern        = "UP_WEBHOOK_REPAYMENT_MISSED"

  metric_transformation {
    name          = "UpWebhookRepaymentPushFailures"
    namespace     = "${var.project_name}/UpWebhook"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "up_webhook_repayment_push" {
  alarm_name          = "${var.project_name}-up-webhook-repayment-push"
  namespace           = "${var.project_name}/UpWebhook"
  metric_name         = "UpWebhookRepaymentPushFailures"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "The instant home-loan repayment push may be down. Search both /aws/lambda/abundo-up-webhook and /aws/lambda/abundo-balance-poller for these markers. In /aws/lambda/abundo-up-webhook: 'up webhook: processing failed' = a validly-signed Up delivery failed to fetch/push (Up retries, so a self-healing blip can page once). UP_WEBHOOK_TOKEN_REJECTED = Up rejected our personal access token (401/403): replace /abundo/up-personal-access-token in SSM and check Up returns 404 (not 401) for a fake transaction id. UP_WEBHOOK_NO_DEVICE_TOKENS = a qualifying repayment arrived but no phone is registered for push: open the app on a phone to register it. In /aws/lambda/abundo-balance-poller: UP_WEBHOOK_REPAYMENT_MISSED = a repayment landed with no push (silent webhook failure: rotated signing secret, re-linked account or deregistered webhook); source=txn marks the transaction-based check."
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# A corrupt saved milestone row (missing label/targetBalance, non-dict, a non-numeric target,
# or — since WHIT-417 — an unparsable targetDate) is skipped so the rest of the plan still
# celebrates, but the skip must be VISIBLE
# rather than silently eating a milestone push (WHIT-387). _resolve_plan logs one of two tokens
# on the balance-poller log group: MILESTONE_ROW_MALFORMED (a single bad row) or
# MILESTONE_PLAN_MALFORMED (the whole stored plan isn't a list). The `?a ?b` pattern is an OR,
# so either fires the metric. Keep this pattern and shared/milestones.py in lockstep — the skip
# DECISION now lives in shared/milestone_rows.py (WHIT-394), but only _resolve_plan logs these
# tokens. The client read (repository_milestone._to_client) shares the same validator and
# deliberately logs at WARNING with NO token, so a screen read never fires this poller alarm.
resource "aws_cloudwatch_log_metric_filter" "milestone_row_malformed" {
  name           = "${var.project_name}-milestone-row-malformed"
  log_group_name = aws_cloudwatch_log_group.balance_poller.name
  pattern        = "?MILESTONE_ROW_MALFORMED ?MILESTONE_PLAN_MALFORMED"

  metric_transformation {
    name          = "MilestoneRowMalformed"
    namespace     = "${var.project_name}/Milestones"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "milestone_row_malformed" {
  alarm_name          = "${var.project_name}-milestone-row-malformed"
  namespace           = "${var.project_name}/Milestones"
  metric_name         = "MilestoneRowMalformed"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_description   = "A saved mortgage-milestone row was corrupt and got skipped during the daily balance poll (WHIT-387). The rest of the plan still celebrated, but the stored plan has a bad row (missing label/targetBalance, non-dict, or a non-numeric target) that should be inspected and re-saved. Since WHIT-417 an unparsable targetDate counts too — that row is also hidden from the plan screen."
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
