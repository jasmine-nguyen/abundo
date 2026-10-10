"""Tests for the missed-repayment alarm backstop (WHIT-316).

`check_repayment_landed_but_no_push` logs `UP_WEBHOOK_REPAYMENT_MISSED` (which a
CloudWatch alarm watches) when the mortgage balance dropped like a repayment landed but
no push fired within the lookback window. Unit-tests the branch matrix directly, then
confirms `_check_homeloan` isolates each home-loan check's failure.
"""

import logging
from decimal import Decimal

import pytest

from _terraform import MONITORING_TF, filter_pattern, tf_attr, tf_block
from _transaction_range_fakes import _QueuedTransactionRepo

MARKER = "UP_WEBHOOK_REPAYMENT_MISSED"
_DAY = 24 * 60 * 60
_LOOKBACK = 7
_NOW = 1_752_000_000  # pinned clock, so the lookback edges can't flake


class _FakeNotify:
    def __init__(self, last_fired_at=None):
        self._last_fired_at = last_fired_at

    def last_repayment_fired_at(self):
        return self._last_fired_at


@pytest.mark.parametrize(
    ("old", "new", "last_fired_at", "alarms"),
    [
        (Decimal("600000"), Decimal("596000"), None, True),
        (Decimal("600000"), Decimal("596000"), _NOW - 30 * _DAY, True),
        (Decimal("600000"), Decimal("596000"), _NOW - 1 * _DAY, False),
        (Decimal("600000"), Decimal("599000"), None, False),                         # under the $3,000 threshold
        (None, Decimal("596000"), None, False),
        (Decimal("600000"), Decimal("604000"), None, False),                         # interest or redraw
        (Decimal("599000"), Decimal("596000"), None, True),                          # exactly $3,000 counts
        (Decimal("600000"), Decimal("596000"), _NOW - _LOOKBACK * _DAY, False),      # push exactly 7 days ago
        (Decimal("600000"), Decimal("596000"), _NOW - _LOOKBACK * _DAY - 1, True),
    ],
    ids=["no-push", "stale-push", "recent-push", "small-drop", "no-prior", "balance-rose",
         "exactly-threshold", "push-on-lookback-edge", "push-1s-past-lookback"],
)
def test_balance_drop_alarm_matrix(handler, monkeypatch, caplog, old, new, last_fired_at, alarms):
    monkeypatch.setattr(handler.time, "time", lambda: _NOW)
    caplog.set_level(logging.ERROR)

    handler.check_repayment_landed_but_no_push(old, new, _FakeNotify(last_fired_at))

    assert (MARKER in caplog.text) is alarms


# --- integration with _check_homeloan --------------------------------------
# lambda_handler wiring (abs inputs, WHIT-317 surviving a failed fetch) is in test_homeloan_single_poll.py.

_CHECKS = ("check_ingested_repayment_without_push", "notify_homeloan_milestone", "check_repayment_landed_but_no_push")


@pytest.mark.parametrize("failing", _CHECKS)
def test_check_homeloan_isolates_each_check_failure(handler, monkeypatch, failing):
    monkeypatch.setattr(handler, "NotifyRepository", lambda: _FakeNotify())
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    ran = []
    for name in _CHECKS:
        def check(*a, name=name, **k):
            ran.append(name)
            if name == failing:
                raise RuntimeError("check blew up")
        monkeypatch.setattr(handler, name, check)

    handler._check_homeloan([{"account_id": "up-homeloan", "old": Decimal("-600000"), "new": Decimal("-596000")}])

    assert ran == list(_CHECKS)  # the failure was swallowed and every other check still ran


# --- WHIT-655: both detectors' lines still feed the merged Up webhook alarm ---

class _FakeNoPushes:
    def repayment_push_amounts_since(self, cutoff):
        return []


def test_both_detectors_log_a_line_the_repayment_missed_filter_matches(handler, caplog):
    pattern = filter_pattern("up_webhook_repayment_missed")
    metric_filter = tf_block(MONITORING_TF.read_text(), "aws_cloudwatch_log_metric_filter", "up_webhook_repayment_missed")
    assert tf_attr(metric_filter, "log_group_name") == "aws_cloudwatch_log_group.balance_poller.name"

    caplog.set_level(logging.ERROR)
    handler.check_repayment_landed_but_no_push(Decimal("600000"), Decimal("596000"), _FakeNotify(None))
    coarse = [record.getMessage() for record in caplog.records]
    caplog.clear()
    handler.check_ingested_repayment_without_push(_FakeNoPushes(), _QueuedTransactionRepo([{"type": "TRANSFER_INCOMING", "amount": Decimal("3573.00"), "date": "2026-07-04"}]), _NOW)
    precise = [record.getMessage() for record in caplog.records]

    # A bare CloudWatch term matches a whole word.
    assert any(pattern in message.split() for message in coarse), coarse
    assert any(pattern in message.split() and "source=txn" in message for message in precise), precise
