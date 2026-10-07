"""Tests for the missed-repayment alarm backstop (WHIT-316).

`check_repayment_landed_but_no_push` logs `UP_WEBHOOK_REPAYMENT_MISSED` (which a
CloudWatch alarm watches) when the mortgage balance dropped like a repayment landed but
no push fired within the lookback window. Unit-tests the branch matrix directly, then
confirms `_check_homeloan` isolates each home-loan check's failure.
"""

import logging
import time
from decimal import Decimal

import pytest

from _terraform import MONITORING_TF, filter_pattern, tf_attr, tf_block
from _transaction_range_fakes import _QueuedTransactionRepo

MARKER = "UP_WEBHOOK_REPAYMENT_MISSED"
_DAY = 24 * 60 * 60
_LOOKBACK = 7
_NOW = 1_752_000_000  # fixed epoch for the pinned-clock lookback-edge tests


class _FakeNotify:
    def __init__(self, last_fired_at=None):
        self._last_fired_at = last_fired_at

    def last_repayment_fired_at(self):
        return self._last_fired_at


def _check(handler, caplog, *, old, new, last_fired_at):
    caplog.set_level(logging.ERROR)
    handler.check_repayment_landed_but_no_push(old, new, _FakeNotify(last_fired_at))
    return MARKER in caplog.text


# --- the branch matrix -----------------------------------------------------

def test_drop_with_no_recorded_push_alarms(handler, caplog):
    assert _check(handler, caplog, old=Decimal("600000"), new=Decimal("596000"), last_fired_at=None)


def test_drop_with_stale_push_alarms(handler, caplog):
    stale = int(time.time()) - 30 * _DAY
    assert _check(handler, caplog, old=Decimal("600000"), new=Decimal("596000"), last_fired_at=stale)


def test_drop_with_recent_push_is_silent(handler, caplog):
    recent = int(time.time()) - 1 * _DAY
    assert not _check(handler, caplog, old=Decimal("600000"), new=Decimal("596000"), last_fired_at=recent)


def test_small_drop_is_silent(handler, caplog):
    # $1,000 drop < the $3,000 threshold.
    assert not _check(handler, caplog, old=Decimal("600000"), new=Decimal("599000"), last_fired_at=None)


def test_no_prior_balance_is_silent(handler, caplog):
    assert not _check(handler, caplog, old=None, new=Decimal("596000"), last_fired_at=None)


def test_balance_rose_is_silent(handler, caplog):
    # Interest / redraw raises the balance — never a repayment, never an alarm.
    assert not _check(handler, caplog, old=Decimal("600000"), new=Decimal("604000"), last_fired_at=None)


def test_zero_drop_is_silent(handler, caplog):
    # A second poll after a drop day sees old == new → no re-alarm; also the deploy
    # transition where the drop was already stored before this check shipped.
    assert not _check(handler, caplog, old=Decimal("596000"), new=Decimal("596000"), last_fired_at=None)


def test_boundary_exactly_threshold_alarms(handler, caplog):
    # Exactly $3,000 counts (>= threshold).
    assert _check(handler, caplog, old=Decimal("599000"), new=Decimal("596000"), last_fired_at=None)


# --- the 7-day lookback edge (wall-clock PINNED so +/-1s can't flake) --------


def _run_pinned_clock(handler, monkeypatch, caplog, *, last_fired_at):
    monkeypatch.setattr(handler.time, "time", lambda: _NOW)
    caplog.set_level(logging.ERROR)
    handler.check_repayment_landed_but_no_push(
        Decimal("600000"), Decimal("596000"), _FakeNotify(last_fired_at),
    )
    return MARKER in caplog.text


def test_push_exactly_on_lookback_edge_is_healthy(handler, monkeypatch, caplog):
    # last_fired_at == cutoff (exactly 7 days ago) counts as recent -> silent (>=).
    edge = _NOW - _LOOKBACK * _DAY
    assert not _run_pinned_clock(handler, monkeypatch, caplog, last_fired_at=edge)


def test_push_one_second_past_lookback_alarms(handler, monkeypatch, caplog):
    # One second older than the 7-day window -> stale -> alarm. Guards the day-arithmetic
    # (7*24*60*60) and the >= boundary: flipping >= to > would make the edge case above
    # alarm, and shrinking the window would move this seam.
    just_stale = _NOW - _LOOKBACK * _DAY - 1
    assert _run_pinned_clock(handler, monkeypatch, caplog, last_fired_at=just_stale)


def test_push_one_second_inside_lookback_is_healthy(handler, monkeypatch, caplog):
    fresh = _NOW - _LOOKBACK * _DAY + 1
    assert not _run_pinned_clock(handler, monkeypatch, caplog, last_fired_at=fresh)


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
