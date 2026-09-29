"""WHIT-655 QA: the merged Up webhook alarm can actually fire, and the budget guard can't be dodged.

Billing: every standard alarm costs one alarm-metric (10 free), a high-resolution alarm (period
< 60s) and a composite alarm are billed at a higher rate outside the standard free tier.
"""

import re

from _terraform import MONITORING_TF, TERRAFORM_DIR, alarm_names, tf_attr, tf_block

CUSTOM_METRIC_FREE_TIER = 10


def _filter_metrics(text):
    """(namespace, metric name) published by every log metric filter."""
    names = re.findall(r'^resource "aws_cloudwatch_log_metric_filter" "([^"]+)"', text, re.M)
    published = {}
    for name in names:
        transformation = tf_block(text, "aws_cloudwatch_log_metric_filter", name).split("metric_transformation", 1)[1]
        published[name] = (tf_attr(transformation, "namespace"), tf_attr(transformation, "name"))
    return published


def _alarm_metrics(text):
    return {
        name: (tf_attr(block, "namespace"), tf_attr(block, "metric_name"))
        for name in alarm_names(text)
        for block in [tf_block(text, "aws_cloudwatch_metric_alarm", name)]
    }


# [A1] (P0) An alarm on a custom metric no filter publishes can never fire — e.g. the merged alarm
# left watching a metric the up_webhook_failures filter no longer emits.
def test_every_custom_alarm_watches_a_metric_some_filter_publishes():
    text = MONITORING_TF.read_text()
    published = set(_filter_metrics(text).values())
    dead = {
        name: metric for name, metric in _alarm_metrics(text).items()
        if not metric[0].startswith('"AWS/') and metric not in published
    }
    assert dead == {}, f"alarms watching a metric no filter publishes: {dead}"


# [A2] (P0) A filter whose metric no alarm watches is a silent failure the merge dropped — e.g.
# repayment_missed left on its old UpWebhookRepaymentMissed metric after its alarm was deleted.
def test_every_filter_metric_is_watched_by_an_alarm():
    text = MONITORING_TF.read_text()
    watched = set(_alarm_metrics(text).values())
    orphaned = {name: metric for name, metric in _filter_metrics(text).items() if metric not in watched}
    assert orphaned == {}, f"filters nobody alarms on: {orphaned}"


# [A3] (P0) The merged alarm is fed by exactly the two planned filters, on the two planned log groups.
def test_merged_metric_is_published_by_exactly_the_webhook_and_poller_filters():
    text = MONITORING_TF.read_text()
    alarm = tf_block(text, "aws_cloudwatch_metric_alarm", "up_webhook_repayment_push")
    merged = (tf_attr(alarm, "namespace"), tf_attr(alarm, "metric_name"))
    feeders = sorted(name for name, metric in _filter_metrics(text).items() if metric == merged)
    assert feeders == ["up_webhook_failures", "up_webhook_repayment_missed"]
    log_groups = {
        name: tf_attr(tf_block(text, "aws_cloudwatch_log_metric_filter", name), "log_group_name")
        for name in feeders
    }
    assert log_groups == {
        "up_webhook_failures": "aws_cloudwatch_log_group.up_webhook.name",
        "up_webhook_repayment_missed": "aws_cloudwatch_log_group.balance_poller.name",
    }


# [A4] (P1) Plan: 11 → 8 custom metrics, inside the 10 free custom metrics.
def test_distinct_custom_metrics_fit_the_free_tier():
    metrics = set(_filter_metrics(MONITORING_TF.read_text()).values())
    assert len(metrics) <= CUSTOM_METRIC_FREE_TIER, sorted(metrics)


# [A5] (P1) The budget counts standard alarms only. A composite alarm or a high-resolution period
# is billed outside the 10 free standard alarms, so it would dodge a count of metric_alarm blocks.
def test_no_alarm_type_that_dodges_the_standard_alarm_count():
    for tf_file in TERRAFORM_DIR.glob("*.tf"):
        text = tf_file.read_text()
        assert "aws_cloudwatch_composite_alarm" not in text, f"{tf_file.name}: composite alarms are billed separately"
        assert len(alarm_names(text)) == len(re.findall(r'resource\s+"aws_cloudwatch_metric_alarm"', text)), \
            f"{tf_file.name}: an alarm declaration alarm_names can't see"
        for name in alarm_names(text):
            period = int(tf_attr(tf_block(text, "aws_cloudwatch_metric_alarm", name), "period"))
            assert period >= 60, f"{name}: period {period}s is a high-resolution (pricier) alarm"


def _log_group_name(resource):
    variables = (TERRAFORM_DIR / "variables.tf").read_text()
    project = re.search(r'variable "project_name" \{.*?default\s*=\s*"([^"]+)"', variables, re.S).group(1)
    block = tf_block((TERRAFORM_DIR / "lambda.tf").read_text(), "aws_cloudwatch_log_group", resource)
    return tf_attr(block, "name").strip('"').replace("${var.project_name}", project)


# [A6] (P0) Plan: "Use the real log-group names from the aws_cloudwatch_log_group resources", and
# each marker is described under the log group it is actually logged to.
def test_description_sends_the_reader_to_the_real_log_group_for_each_marker():
    alarm = tf_block(MONITORING_TF.read_text(), "aws_cloudwatch_metric_alarm", "up_webhook_repayment_push")
    description = tf_attr(alarm, "alarm_description")
    webhook_group = _log_group_name("up_webhook")
    poller_group = _log_group_name("balance_poller")
    assert webhook_group in description and poller_group in description

    webhook_section = description.split(f"In {webhook_group}:", 1)[1].split(f"In {poller_group}:", 1)[0]
    poller_section = description.split(f"In {poller_group}:", 1)[1]
    for marker in ("up webhook: processing failed", "UP_WEBHOOK_TOKEN_REJECTED", "UP_WEBHOOK_NO_DEVICE_TOKENS"):
        assert marker in webhook_section and marker not in poller_section, marker
    assert "UP_WEBHOOK_REPAYMENT_MISSED" in poller_section
    assert "/abundo/up-personal-access-token" in webhook_section


# [A7] (P1) Critic tweak: the header keeps the note that the 401 signing-secret path is deliberately
# not alarmed and is caught by the repayment-missed safety net instead.
def test_header_keeps_the_unalarmed_401_note():
    text = MONITORING_TF.read_text()
    header = text[text.index("# --- Up-webhook health alarm"):text.index('resource "aws_cloudwatch_log_metric_filter" "up_webhook_failures"')]
    assert "401" in header and "NOT" in header and "alarmed" in header
    assert "repayment-missed" in header
    assert "metric math" in header
