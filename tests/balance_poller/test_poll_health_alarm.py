"""WHIT-645: Jas is emailed when account balances stop refreshing, whatever the cause.

The poller swallows every failure, so the alarm watches a heartbeat instead: only a fully
clean run (every BALANCE_SOURCES account stored, home loan included) logs BALANCE_POLL_ALL_STORED.
A metric filter counts that line; the alarm pages when 2 daily runs in a row have none
(silence included) and emails again on recovery.
"""

import logging

from _http_fakes import FakeResponse
from _terraform import filter_pattern


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


# Every BALANCE_SOURCES aid -> a good getBalance payload.
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
    assert result == {"accounts_stored": len(handler.BALANCE_SOURCES)}
    assert any(pattern in r.getMessage() for r in caplog.records), "clean run logged no heartbeat"
    # The Lambda runtime's root logger sits at WARNING: the handler's own logger must enable INFO.
    assert handler.logger.level == logging.INFO

    # One account's read fails (e.g. a 404 after its ID changed) → balances are stale → no heartbeat.
    result = _run_poll(handler, monkeypatch, caplog, failing_aid="3zVQJ8Btz_IRmqp78VrQnQ")
    assert result["accounts_stored"] == len(handler.BALANCE_SOURCES) - 1
    assert not any(pattern in r.getMessage() for r in caplog.records), "partial run logged the heartbeat"


def test_heartbeat_still_logged_when_goal_checkpoint_and_feed_stall_checks_fail(handler, monkeypatch, caplog):
    # Follow-on checks failing must not suppress the heartbeat: the balances did store.
    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(handler, "_check_goal_checkpoints", boom)
    monkeypatch.setattr(handler, "check_feed_stalls", boom)

    result = _run_poll(handler, monkeypatch, caplog)

    assert result == {"accounts_stored": len(handler.BALANCE_SOURCES)}
    assert sum("BALANCE_POLL_ALL_STORED" in r.getMessage() for r in caplog.records) == 1
