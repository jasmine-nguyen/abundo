"""WHIT-655: CloudWatch alarms stay inside the 10-alarm free tier without losing coverage.

Every custom alarm watches a metric some log filter publishes (else it can never fire), and every
filter's metric is watched by an alarm (else a failure is logged and nobody hears about it).
Metric math is billed per metric it reads, so merging with a formula would save nothing.
"""

import re

from _terraform import MONITORING_TF, TERRAFORM_DIR, alarm_names, tf_attr, tf_block

FREE_TIER_ALARMS = 10


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


def test_alarms_fit_the_free_tier():
    names = alarm_names(MONITORING_TF.read_text())
    assert len(names) <= FREE_TIER_ALARMS, f"{len(names)} alarms, free tier is {FREE_TIER_ALARMS}: {names}"

    for tf_file in TERRAFORM_DIR.glob("*.tf"):
        assert "metric_query" not in tf_file.read_text(), f"{tf_file.name}: metric math is billed per metric read"
        if tf_file != MONITORING_TF:
            assert alarm_names(tf_file.read_text()) == [], f"{tf_file.name} declares an alarm outside monitoring.tf"


def test_every_custom_alarm_watches_a_metric_some_filter_publishes():
    text = MONITORING_TF.read_text()
    published = set(_filter_metrics(text).values())
    dead = {
        name: metric for name, metric in _alarm_metrics(text).items()
        if not metric[0].startswith('"AWS/') and metric not in published
    }
    assert dead == {}, f"alarms watching a metric no filter publishes: {dead}"


def test_every_filter_metric_is_watched_by_an_alarm():
    text = MONITORING_TF.read_text()
    watched = set(_alarm_metrics(text).values())
    orphaned = {name: metric for name, metric in _filter_metrics(text).items() if metric not in watched}
    assert orphaned == {}, f"filters nobody alarms on: {orphaned}"
