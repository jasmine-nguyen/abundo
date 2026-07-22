"""WHIT-316 QA gap tests: adversarial edges the implementer's matrix left open.

Covers the exact 7-day lookback boundary (the `last_fired_at >= cutoff` comparison and
the day-arithmetic), with wall-clock time PINNED so the +/-1s cases can't flake. The
implementer only exercised 30-days-stale and 1-day-recent — never the boundary itself.
"""

import logging
from decimal import Decimal

_DAY = 24 * 60 * 60
_LOOKBACK = 7
MARKER = "UP_WEBHOOK_REPAYMENT_MISSED"
_NOW = 1_752_000_000  # fixed epoch; reasoned in seconds, not "now"


class _FakeNotify:
    def __init__(self, last_fired_at):
        self._last_fired_at = last_fired_at

    def last_repayment_fired_at(self):
        return self._last_fired_at


def _run(handler, monkeypatch, caplog, *, last_fired_at):
    monkeypatch.setattr(handler.time, "time", lambda: _NOW)
    caplog.set_level(logging.ERROR)
    handler.check_repayment_landed_but_no_push(
        Decimal("600000"), Decimal("596000"), _FakeNotify(last_fired_at),
    )
    return MARKER in caplog.text


def test_push_exactly_on_lookback_edge_is_healthy(handler, monkeypatch, caplog):
    # last_fired_at == cutoff (exactly 7 days ago) counts as recent -> silent (>=).
    edge = _NOW - _LOOKBACK * _DAY
    assert not _run(handler, monkeypatch, caplog, last_fired_at=edge)


def test_push_one_second_past_lookback_alarms(handler, monkeypatch, caplog):
    # One second older than the 7-day window -> stale -> alarm. Guards the day-arithmetic
    # (7*24*60*60) and the >= boundary: flipping >= to > would make the edge case above
    # alarm, and shrinking the window would move this seam.
    just_stale = _NOW - _LOOKBACK * _DAY - 1
    assert _run(handler, monkeypatch, caplog, last_fired_at=just_stale)


def test_push_one_second_inside_lookback_is_healthy(handler, monkeypatch, caplog):
    fresh = _NOW - _LOOKBACK * _DAY + 1
    assert not _run(handler, monkeypatch, caplog, last_fired_at=fresh)
