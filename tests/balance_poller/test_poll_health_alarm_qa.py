"""WHIT-645 QA: adversarial edges of the balance-poll heartbeat and its alarm.

The heartbeat must track "every balance was stored" and nothing else: follow-on checks
(goal checkpoints, feed stalls, repayment-miss) failing must NOT suppress it, and any
missed balance must. The terraform side must match the exact line CloudWatch will see.
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
    def __init__(self, list_raises=False):
        self.list_raises = list_raises

    def list_balances(self, account_ids):
        if self.list_raises:
            raise RuntimeError("DynamoDB throttled")
        return []

    def upsert_balance(self, account_id, amount, available_balance, currency, as_of, account_type):
        pass


def _payload(aid, amount, account_type):
    return {"success": True, "data": {
        "date": "2026-09-28T00:00:00.000Z", "accountId": aid, "accountType": account_type,
        "amount": amount, "availableBalance": 0, "currency": "AUD",
    }}


def _payloads(spending_amount=96270.59):
    return {
        "3zVQJ8Btz_IRmqp78VrQnQ": _payload("3zVQJ8Btz_IRmqp78VrQnQ", spending_amount, "checking"),
        "T6d8ppsYssBDFCwl1qEb0w": _payload("T6d8ppsYssBDFCwl1qEb0w", -596642.43, "mortgage"),
        "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0":
            _payload("9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0", -6492.26, "unknown"),
        "A3AC9195-9E8D-48B8-86D0-46D130D7F64A":
            _payload("A3AC9195-9E8D-48B8-86D0-46D130D7F64A", -230, "unknown"),
    }


def _stub(handler, monkeypatch, caplog, *, payloads=None, account_repo=None, urlopen=None):
    payloads = payloads or _payloads()
    monkeypatch.setattr(handler, "get_api_key", lambda: "the-key")
    monkeypatch.setattr(handler, "HomeLoanBalanceRepository", lambda: _FakeHomeLoanRepo())
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: account_repo or _FakeAccountRepo())

    def default_urlopen(req, timeout=None):
        for aid, payload in payloads.items():
            if aid in req.full_url:
                return FakeResponse(payload)
        raise AssertionError(f"no stub payload for {req.full_url}")

    monkeypatch.setattr(handler.urllib.request, "urlopen", urlopen or default_urlopen)
    caplog.set_level(logging.INFO)


def _heartbeats(caplog):
    pattern = filter_pattern("balance_poll_all_stored")
    return [r for r in caplog.records if pattern in r.getMessage()]


def _raise(*args, **kwargs):
    raise RuntimeError("boom")


# [A2] (P0) follow-on checks failing must not suppress the heartbeat (balances did store).
def test_heartbeat_still_logged_when_goal_checkpoint_and_feed_stall_checks_fail(handler, monkeypatch, caplog):
    _stub(handler, monkeypatch, caplog)
    monkeypatch.setattr(handler, "_check_goal_checkpoints", _raise)
    monkeypatch.setattr(handler, "check_feed_stalls", _raise)

    result = handler.lambda_handler({}, None)

    assert result == {"homeloan_stored": True, "accounts_stored": len(handler.BALANCE_SOURCES)}
    assert len(_heartbeats(caplog)) == 1


# [A3] (P0) the repayment-miss backstops failing inside the home-loan poll must not suppress it.
def test_heartbeat_still_logged_when_repayment_miss_checks_fail(handler, monkeypatch, caplog):
    _stub(handler, monkeypatch, caplog)
    monkeypatch.setattr(handler, "check_ingested_repayment_without_push", _raise)
    monkeypatch.setattr(handler, "check_repayment_landed_but_no_push", _raise)
    monkeypatch.setattr(handler, "notify_milestone_crossing", _raise)

    handler.lambda_handler({}, None)

    assert len(_heartbeats(caplog)) == 1


# [A4] (P1) the prior-balance batch read failing still stores every balance → heartbeat.
def test_heartbeat_still_logged_when_prior_balance_read_fails(handler, monkeypatch, caplog):
    _stub(handler, monkeypatch, caplog, account_repo=_FakeAccountRepo(list_raises=True))

    result = handler.lambda_handler({}, None)

    assert result["accounts_stored"] == len(handler.BALANCE_SOURCES)
    assert len(_heartbeats(caplog)) == 1


# [A5] (P0) home loan stored but EVERY account read fails (BankSync balance-side outage) → no heartbeat.
def test_no_heartbeat_when_every_account_read_fails_but_home_loan_stored(handler, monkeypatch, caplog):
    _stub(handler, monkeypatch, caplog)
    # The home-loan normaliser wraps the shared one, so pin it to a good reading first.
    monkeypatch.setattr(handler, "normalise_balance", lambda payload: {
        "balance": 596642.43, "as_of": "2026-09-28T00:00:00.000Z", "currency": "AUD",
    })
    monkeypatch.setattr(handler, "normalise_account_balance", _raise)

    result = handler.lambda_handler({}, None)

    assert result == {"homeloan_stored": True, "accounts_stored": 0}
    assert _heartbeats(caplog) == []


# [A6] (P0) the home-loan payload is bad (not a repo failure) while every account stores → no heartbeat.
def test_no_heartbeat_when_home_loan_payload_is_rejected(handler, monkeypatch, caplog):
    _stub(handler, monkeypatch, caplog)
    monkeypatch.setattr(handler, "normalise_balance", _raise)

    result = handler.lambda_handler({}, None)

    assert result == {"homeloan_stored": False, "accounts_stored": len(handler.BALANCE_SOURCES)}
    assert _heartbeats(caplog) == []


# [A7] (P1) BankSync answers success:false for one account (outage shape, not an exception) → no heartbeat.
def test_no_heartbeat_when_one_account_returns_success_false(handler, monkeypatch, caplog):
    payloads = _payloads()
    payloads["A3AC9195-9E8D-48B8-86D0-46D130D7F64A"] = {"success": False, "error": "upstream"}
    _stub(handler, monkeypatch, caplog, payloads=payloads)

    result = handler.lambda_handler({}, None)

    assert result["accounts_stored"] == len(handler.BALANCE_SOURCES) - 1
    assert _heartbeats(caplog) == []


# [A8] (P1) a genuine 0 balance is a successful read → still a clean run.
def test_heartbeat_logged_when_an_account_balance_is_exactly_zero(handler, monkeypatch, caplog):
    _stub(handler, monkeypatch, caplog, payloads=_payloads(spending_amount=0))

    handler.lambda_handler({}, None)

    assert len(_heartbeats(caplog)) == 1


# [A9] (P0) the heartbeat must reach CloudWatch: logged by the handler's logger at INFO+,
# with that logger actually enabled for INFO (the Lambda runtime's root sits at WARNING).
def test_heartbeat_is_an_enabled_info_record_from_the_handler_logger(handler, monkeypatch, caplog):
    _stub(handler, monkeypatch, caplog)

    handler.lambda_handler({}, None)

    [record] = _heartbeats(caplog)
    assert record.levelno >= logging.INFO
    assert record.name == handler.logger.name
    assert handler.logger.level == logging.INFO


# [A10] (P0) CloudWatch matches an unquoted pattern as a whole term: it must be a bare
# alphanumeric/underscore token and appear in the emitted line delimited by whitespace.
def test_filter_pattern_is_a_bare_term_the_emitted_line_contains_as_a_whole_word(handler, monkeypatch, caplog):
    pattern = filter_pattern("balance_poll_all_stored")
    assert re.fullmatch(r"[A-Za-z0-9_]+", pattern), f"pattern needs quoting in CloudWatch: {pattern!r}"
    _stub(handler, monkeypatch, caplog)

    handler.lambda_handler({}, None)

    [record] = _heartbeats(caplog)
    assert pattern in record.getMessage().split()


# [A11] (P1) the alarm description points at the real log group of the real function.
def test_alarm_description_names_the_real_poller_log_group():
    project = re.search(r'variable "project_name" \{.*?default\s*=\s*"([^"]+)"',
                        (TERRAFORM_DIR / "variables.tf").read_text(), re.S).group(1)
    function = tf_block((TERRAFORM_DIR / "lambda.tf").read_text(), "aws_lambda_function", "balance_poller")
    function_name = tf_attr(function, "function_name").strip('"').replace("${var.project_name}", project)
    alarm = tf_block(MONITORING_TF.read_text(), "aws_cloudwatch_metric_alarm", "balance_poll_stale")
    description = tf_attr(alarm, "alarm_description")
    assert f"/aws/lambda/{function_name}" in description
    assert "balance poll failed" in description


# [A12] (P1) the metric the alarm reads is published by exactly one filter (no collision).
def test_balance_poll_metric_is_published_by_one_filter_only():
    text = MONITORING_TF.read_text()
    assert len(re.findall(r'\bname\s*=\s*"BalancePollAllStored"', text)) == 1
    assert len(re.findall(r'metric_name\s*=\s*"BalancePollAllStored"', text)) == 1
