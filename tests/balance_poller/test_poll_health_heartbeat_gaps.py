"""WHIT-645: the other ways a balance poll can fall short also log no heartbeat.

A failed API-key fetch must not emit BALANCE_POLL_ALL_STORED, or the balance-poll alarm would
never page for it. (A failed home-loan read is one failed account: see
test_homeloan_single_poll.py.)
"""

import logging

_HEARTBEAT = "BALANCE_POLL_ALL_STORED"


def test_a_failed_api_key_fetch_logs_no_heartbeat(handler, monkeypatch, caplog):
    def get_api_key():
        raise RuntimeError("SSM throttled")

    monkeypatch.setattr(handler, "get_api_key", get_api_key)
    caplog.set_level(logging.INFO)

    result = handler.lambda_handler({}, None)

    assert result == {"homeloan_stored": False, "accounts_stored": 0}
    assert not any(_HEARTBEAT in r.getMessage() for r in caplog.records)
