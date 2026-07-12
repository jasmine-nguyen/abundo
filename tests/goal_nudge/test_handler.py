"""WHIT-236 — the goal-nudge scheduled lambda (lambda_goal_nudge/handler.py).

Covers the handler's ONE job: wire the real repos into notify_behind_goals and report the
count, best-effort (never raise). notify_behind_goals is monkeypatched to capture the wiring
+ drive the failure path. The wiring assertion locks the SIGNED balance source
(AccountBalanceRepository, not the ABS HomeLoanBalanceRepository — the critic's MAJOR fix).
"""

import logging

import pytest


def test_wires_the_repos_and_returns_the_count(handler, monkeypatch):
    captured = {}

    def fake_notify(**kwargs):
        captured.update(kwargs)
        return 2

    monkeypatch.setattr(handler, "notify_behind_goals", fake_notify)
    result = handler.lambda_handler({}, None)

    assert result == {"nudged": 2}
    # The five repos the nudge needs, each the RIGHT type.
    assert type(captured["goals_repo"]).__name__ == "GoalsRepository"
    assert type(captured["paycycle_repo"]).__name__ == "PayCycleRepository"
    assert type(captured["device_repo"]).__name__ == "DeviceRepository"
    assert type(captured["notify_repo"]).__name__ == "NotifyRepository"
    # SIGNED source — NOT HomeLoanBalanceRepository (which stores the ABS principal).
    assert type(captured["balance_repo"]).__name__ == "AccountBalanceRepository"


def test_happy_path_logs_the_heartbeat_marker(handler, monkeypatch, caplog):
    # WHIT-260: the goal-nudge-not-running alarm's metric filter matches this exact success
    # marker ("nudge(s) sent"). Lock the wording so a reworded log line can't silently break the
    # heartbeat monitor — the terraform pattern and this line must change in lockstep.
    monkeypatch.setattr(handler, "notify_behind_goals", lambda **kwargs: 3)
    with caplog.at_level(logging.INFO):
        handler.lambda_handler({}, None)
    assert "nudge(s) sent" in caplog.text


def test_swallows_a_failure_and_reports_zero(handler, monkeypatch, caplog):
    def boom(**kwargs):
        raise RuntimeError("dynamo down")

    monkeypatch.setattr(handler, "notify_behind_goals", boom)
    # Best-effort: a repo/push failure must not raise out of the scheduled invocation.
    with caplog.at_level(logging.INFO):
        result = handler.lambda_handler({}, None)
    assert result == {"nudged": 0}
    # WHIT-260: the swallowed-failure path must NOT emit the heartbeat marker, or the
    # not-running alarm would count a broken sweep as a healthy run and never fire.
    assert "nudge(s) sent" not in caplog.text
