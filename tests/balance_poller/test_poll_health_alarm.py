"""WHIT-645: Jas is emailed when account balances stop refreshing, whatever the cause.

The poller swallows every failure, so the alarm watches a heartbeat instead: only a fully
clean run (home loan + every BALANCE_SOURCES account stored) logs BALANCE_POLL_ALL_STORED.
A metric filter counts that line; the alarm pages when 2 daily runs in a row have none
(silence included) and emails again on recovery.
"""

import logging
import re

from _http_fakes import FakeResponse
from _terraform import MONITORING_TF, TERRAFORM_DIR, filter_pattern, tf_attr, tf_block


class _FakeHomeLoanRepo:
    def get_balance(self, account_id):
        return None

    def upsert_balance(self, account_id, balance, as_of, currency):
        pass


class _FakeAccountRepo:
    def list_balances(self, account_ids):
        return []

    def upsert_balance(self, account_id, amount, available_balance, currency, as_of, account_type):
        pass


def _payload(aid, amount, account_type, date="2026-09-28T00:00:00.000Z"):
    return {"success": True, "data": {
        "date": date, "accountId": aid, "accountType": account_type,
        "amount": amount, "availableBalance": 0, "currency": "AUD",
    }}


# Every BALANCE_SOURCES aid -> a good getBalance payload (the mortgage aid also feeds the home loan).
_PAYLOADS_BY_AID = {
    "3zVQJ8Btz_IRmqp78VrQnQ": _payload("3zVQJ8Btz_IRmqp78VrQnQ", 96270.59, "checking"),
    "T6d8ppsYssBDFCwl1qEb0w": _payload("T6d8ppsYssBDFCwl1qEb0w", -596642.43, "mortgage"),
    "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0":
        _payload("9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0", -6492.26, "unknown"),
    "A3AC9195-9E8D-48B8-86D0-46D130D7F64A":
        _payload("A3AC9195-9E8D-48B8-86D0-46D130D7F64A", -230, "unknown"),
}


def _run_poll(handler, monkeypatch, caplog, failing_aid=None):
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: _FakeHomeLoanRepo())
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: _FakeAccountRepo())

    # The account-balance read for `failing_aid` fails; every other aid returns its payload.
    def urlopen(req, timeout=None):
        for aid, payload in _PAYLOADS_BY_AID.items():
            if aid in req.full_url:
                if aid == failing_aid:
                    raise RuntimeError("HTTP Error 404: Not Found")
                return FakeResponse(payload)
        raise AssertionError(f"no stub payload for {req.full_url}")

    monkeypatch.setattr(handler.urllib.request, "urlopen", urlopen)
    caplog.clear()
    caplog.set_level(logging.INFO)
    return handler.lambda_handler({}, None)


def test_only_a_fully_clean_balance_poll_logs_the_heartbeat_the_alarm_watches(handler, monkeypatch, caplog):
    pattern = filter_pattern("balance_poll_all_stored")
    assert pattern == "BALANCE_POLL_ALL_STORED", f"terraform pattern changed: {pattern!r}"

    result = _run_poll(handler, monkeypatch, caplog)
    assert result == {"homeloan_stored": True, "accounts_stored": len(handler.BALANCE_SOURCES)}
    assert any(pattern in r.getMessage() for r in caplog.records), "clean run logged no heartbeat"

    # One account's read fails (e.g. a 404 after its ID changed) → balances are stale → no heartbeat.
    result = _run_poll(handler, monkeypatch, caplog, failing_aid="3zVQJ8Btz_IRmqp78VrQnQ")
    assert result["accounts_stored"] == len(handler.BALANCE_SOURCES) - 1
    assert not any(pattern in r.getMessage() for r in caplog.records), "partial run logged the heartbeat"


def test_alarm_emails_alerts_when_balances_have_not_refreshed_for_two_daily_runs():
    text = MONITORING_TF.read_text()
    metric_filter = tf_block(text, "aws_cloudwatch_log_metric_filter", "balance_poll_all_stored")
    assert tf_attr(metric_filter, "log_group_name") == "aws_cloudwatch_log_group.balance_poller.name"
    assert tf_attr(metric_filter, "default_value") == '"0"'
    assert tf_attr(metric_filter, "value") == '"1"'
    filter_namespace = re.search(r'metric_transformation \{.*?namespace\s*=\s*(.+?)\s*$',
                                 metric_filter, re.S | re.M).group(1)
    filter_metric = re.search(r'metric_transformation \{.*?\bname\s*=\s*(.+?)\s*$',
                              metric_filter, re.S | re.M).group(1)
    assert filter_metric == '"BalancePollAllStored"'
    assert filter_namespace == '"${var.project_name}/BalancePoller"'

    alarm = tf_block(text, "aws_cloudwatch_metric_alarm", "balance_poll_stale")
    assert tf_attr(alarm, "namespace") == filter_namespace
    assert tf_attr(alarm, "metric_name") == filter_metric
    assert tf_attr(alarm, "statistic") == '"Sum"'
    assert tf_attr(alarm, "period") == "86400"
    assert tf_attr(alarm, "evaluation_periods") == "2"
    assert tf_attr(alarm, "datapoints_to_alarm") == "2"
    assert tf_attr(alarm, "threshold") == "1"
    assert tf_attr(alarm, "comparison_operator") == '"LessThanThreshold"'
    # Total silence (schedule off, import crash, timeout) must page too.
    assert tf_attr(alarm, "treat_missing_data") == '"breaching"'
    assert tf_attr(alarm, "alarm_actions") == "[aws_sns_topic.alerts.arn]"
    assert tf_attr(alarm, "ok_actions") == "[aws_sns_topic.alerts.arn]"
    assert "abundo-balance-poller" in tf_attr(alarm, "alarm_description")

    # The 86400s period counts missed RUNS only because the poll runs daily.
    variables = (TERRAFORM_DIR / "variables.tf").read_text()
    match = re.search(r'variable "balance_poll_schedule_expression" \{(.*?)\n\}', variables, re.S)
    assert match
    assert tf_attr(match.group(1), "default") == '"rate(1 day)"'
