"""WHIT-236 — the goal-nudge scheduled lambda (lambda_goal_nudge/handler.py).

Covers the handler's ONE job: wire the real repos into notify_behind_goals and report the
count, best-effort (never raise). notify_behind_goals is monkeypatched to capture the wiring
+ drive the failure path. The wiring assertion locks the SIGNED balance source
(AccountBalanceRepository).
"""

import logging

from _terraform import MONITORING_TF, alarm_metrics, filter_metrics, filter_pattern, tf_attr, tf_block

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


def test_heartbeat_alarm_pages_when_the_sweep_goes_silent():
    # No heartbeat at all (crash, timeout, stopped schedule) must count as failing.
    text = MONITORING_TF.read_text()
    heartbeat_metric = filter_metrics(text)["goal_nudge_runs"]
    for name, metric in alarm_metrics(text).items():
        if metric == heartbeat_metric:
            alarm = tf_block(text, "aws_cloudwatch_metric_alarm", name)
            assert tf_attr(alarm, "treat_missing_data") == '"breaching"'
