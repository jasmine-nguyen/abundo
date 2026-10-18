"""WHIT-236 — the goal-nudge scheduled lambda (lambda_goal_nudge/handler.py).

Covers the handler's ONE job: wire the real repos into notify_behind_goals and report the
count, best-effort (never raise). notify_behind_goals is monkeypatched to capture the wiring
+ drive the failure path. The wiring assertion locks the SIGNED balance source
(AccountBalanceRepository).
"""

import logging

from _terraform import MONITORING_TF, alarm_names, filter_pattern, tf_attr, tf_block

HEARTBEAT = filter_pattern("goal_nudge_runs").strip('"')


def test_wires_the_repos_and_returns_the_count(handler, monkeypatch, caplog):
    captured = {}

    def fake_notify(**kwargs):
        captured.update(kwargs)
        return 2

    monkeypatch.setattr(handler, "notify_behind_goals", fake_notify)
    with caplog.at_level(logging.INFO):
        result = handler.lambda_handler({}, None)

    assert result == {"nudged": 2}
    # The SIGNED balance source.
    assert type(captured["balance_repo"]).__name__ == "AccountBalanceRepository"
    # The goal-nudge health alarm's metric filter matches this success marker.
    assert HEARTBEAT in caplog.text


def test_swallows_a_failure_and_reports_zero(handler, monkeypatch, caplog):
    def boom(**kwargs):
        raise RuntimeError("dynamo down")

    monkeypatch.setattr(handler, "notify_behind_goals", boom)
    # Best-effort: a repo/push failure must not raise out of the scheduled invocation.
    with caplog.at_level(logging.INFO):
        result = handler.lambda_handler({}, None)
    assert result == {"nudged": 0}
    # The swallowed-failure path must NOT emit the heartbeat marker, or the goal-nudge
    # health alarm would count a broken sweep as a healthy run and never fire.
    assert HEARTBEAT not in caplog.text


def test_one_health_alarm_pages_when_the_heartbeat_stops():
    # ABU-102: a swallowed failure, a crash/timeout and a stopped schedule all mean no heartbeat,
    # so a single alarm on the heartbeat metric covers every cause.
    text = MONITORING_TF.read_text()
    goal_nudge_alarms = [
        name for name in alarm_names(text)
        for block in [tf_block(text, "aws_cloudwatch_metric_alarm", name)]
        if "goal-nudge" in block or "goal_nudge" in block
    ]
    assert goal_nudge_alarms == ["goal_nudge_health"]

    alarm = tf_block(text, "aws_cloudwatch_metric_alarm", "goal_nudge_health")
    heartbeat = tf_block(text, "aws_cloudwatch_log_metric_filter", "goal_nudge_runs").split("metric_transformation", 1)[1]
    assert tf_attr(alarm, "alarm_name") == '"${var.project_name}-goal-nudge-health"'
    assert tf_attr(alarm, "metric_name") == tf_attr(heartbeat, "name")
    assert tf_attr(alarm, "namespace") == tf_attr(heartbeat, "namespace")
    # Total silence (no invocation at all) must page.
    assert tf_attr(alarm, "treat_missing_data") == '"breaching"'
    assert tf_attr(alarm, "alarm_actions") == "[aws_sns_topic.alerts.arn]"
    assert tf_attr(alarm, "ok_actions") == "[aws_sns_topic.alerts.arn]"
