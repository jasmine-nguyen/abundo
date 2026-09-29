"""WHIT-655: CloudWatch alarms stay inside the 10-alarm free tier without losing coverage.

The four Up webhook alarms merge into one hourly alarm fed by ONE metric, published by two
filters: the webhook's own failures and the balance-poller's repayment-missed safety net.
Metric math is billed per metric it reads, so merging with a formula would save nothing.
"""

from _terraform import MONITORING_TF, TERRAFORM_DIR, alarm_names, tf_attr, tf_block

FREE_TIER_ALARMS = 10


def _metric_published_by(text, filter_name):
    metric_filter = tf_block(text, "aws_cloudwatch_log_metric_filter", filter_name)
    transformation = metric_filter.split("metric_transformation", 1)[1]
    return tf_attr(metric_filter, "log_group_name"), tf_attr(transformation, "name"), tf_attr(transformation, "namespace")


def test_alarms_fit_the_free_tier_and_one_alarm_covers_every_up_webhook_failure():
    text = MONITORING_TF.read_text()
    names = alarm_names(text)
    assert "milestone_row_malformed" in names, "alarm_names reader found nothing — it must not pass by returning []"
    assert len(names) <= FREE_TIER_ALARMS, f"{len(names)} alarms, free tier is {FREE_TIER_ALARMS}: {names}"

    for tf_file in TERRAFORM_DIR.glob("*.tf"):
        assert "metric_query" not in tf_file.read_text(), f"{tf_file.name}: metric math is billed per metric read"
        if tf_file != MONITORING_TF:
            assert alarm_names(tf_file.read_text()) == [], f"{tf_file.name} declares an alarm outside monitoring.tf"

    for retired in ("up_webhook_errors", "up_webhook_token_rejected",
                    "up_webhook_no_device_tokens", "up_webhook_repayment_missed"):
        assert retired not in names

    alarm = tf_block(text, "aws_cloudwatch_metric_alarm", "up_webhook_repayment_push")
    assert tf_attr(alarm, "alarm_name") == '"${var.project_name}-up-webhook-repayment-push"'
    assert tf_attr(alarm, "metric_name") == '"UpWebhookRepaymentPushFailures"'
    assert tf_attr(alarm, "namespace") == '"${var.project_name}/UpWebhook"'
    assert tf_attr(alarm, "statistic") == '"Sum"'
    assert tf_attr(alarm, "period") == "3600"
    assert tf_attr(alarm, "evaluation_periods") == "1"
    assert tf_attr(alarm, "threshold") == "1"
    assert tf_attr(alarm, "comparison_operator") == '"GreaterThanOrEqualToThreshold"'
    assert tf_attr(alarm, "treat_missing_data") == '"notBreaching"'
    assert tf_attr(alarm, "alarm_actions") == "[aws_sns_topic.alerts.arn]"

    description = tf_attr(alarm, "alarm_description")
    for marker in ("up webhook: processing failed", "UP_WEBHOOK_TOKEN_REJECTED",
                   "UP_WEBHOOK_NO_DEVICE_TOKENS", "UP_WEBHOOK_REPAYMENT_MISSED"):
        assert marker in description, f"alarm description doesn't say where to look for {marker}"

    assert _metric_published_by(text, "up_webhook_failures") == (
        "aws_cloudwatch_log_group.up_webhook.name",
        '"UpWebhookRepaymentPushFailures"',
        '"${var.project_name}/UpWebhook"',
    )
    assert _metric_published_by(text, "up_webhook_repayment_missed") == (
        "aws_cloudwatch_log_group.balance_poller.name",
        '"UpWebhookRepaymentPushFailures"',
        '"${var.project_name}/UpWebhook"',
    )
