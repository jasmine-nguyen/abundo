"""WHIT-341 GAP — the "one clock" parity claim.

The whole point of moving `days_left` server-side is that the app STOPS computing
its own countdown, so app and server can never disagree by a day. That only holds if,
on clean data, the server's `get_paycycle_view` days_left EXACTLY equals what the
client's `cycleClock` would compute for the same (payday, length, today).

Here the reference `_client_days_left` is a faithful, INDEPENDENT re-implementation of
the CLIENT algorithm (src/context.tsx cycleClock: whole-day modular arithmetic), NOT of
the server's cycle-start-plus-length math. So if the server formula drifts, the two code
paths disagree and this fails (fail-on-revert for get_paycycle_view). The client half of
the parity is separately locked by src/__tests__/cycleClock.logic.test.ts.

Swept across a Melbourne DST-end week (Apr 2026) and DST-start week (Oct 2026): Python
`date` arithmetic is calendar-day based, so a DST change must NOT shift the count — this
proves the server side is DST-immune the same way the client's UTC-whole-day math is.
"""

from datetime import date, timedelta

import pytest


class FakePayCycleRepo:
    """Minimal handler-level stand-in — get_paycycle_view only reads the cycle.
    (importlib import-mode blocks importing the sibling test module's copy by name.)"""

    def __init__(self, cycle):
        self._cycle = dict(cycle)

    def get_paycycle(self):
        return dict(self._cycle)


def _client_days_left(last_pay_date: str, length: int, today: date) -> int:
    """The CLIENT's cycleClock algorithm, re-implemented independently (see module docstring)."""
    pay = date.fromisoformat(last_pay_date)
    elapsed_days = (today - pay).days
    cycles_elapsed = max(0, elapsed_days // length)  # matches Math.max(0, Math.floor(...))
    days_into_cycle = elapsed_days - cycles_elapsed * length
    return max(0, min(length, length - days_into_cycle))


# A payday/length matrix crossed with two 14-day windows straddling Melbourne's DST seams.
_PAYDAYS = [("2026-03-22", 14), ("2026-01-01", 7), ("2025-12-15", 30), ("2026-04-05", 14)]
_DST_WEEKS = ["2026-04-01", "2026-10-01"]  # DST ends 2026-04-05, starts 2026-10-04


@pytest.mark.parametrize("last_pay_date,length", _PAYDAYS)
@pytest.mark.parametrize("week_start", _DST_WEEKS)
def test_server_days_left_equals_client_cycleclock_across_dst(handler, monkeypatch, last_pay_date, length, week_start):
    import spend

    start = date.fromisoformat(week_start)
    for i in range(14):
        today = start + timedelta(days=i)
        monkeypatch.setattr(spend, "_melbourne_today", lambda t=today: t)
        server = handler.get_paycycle_view(
            FakePayCycleRepo(cycle={"length": length, "last_pay_date": last_pay_date})
        )["days_left"]
        assert server == _client_days_left(last_pay_date, length, today), (
            f"drift on {today} for pay={last_pay_date} len={length}: "
            f"server={server} client={_client_days_left(last_pay_date, length, today)}"
        )


def test_server_days_left_is_always_within_1_to_length(handler, monkeypatch):
    """The server never emits a countdown outside [1, length] on clean data — so a 0 or a
    >length value at the client can only come from a corrupt cache / older field, not this
    endpoint. (Anchors the days_left===0 edge the client defends against.)"""
    import spend

    pay, length = "2026-01-01", 14
    start = date.fromisoformat("2026-01-01")
    seen = set()
    for i in range(60):
        today = start + timedelta(days=i)
        monkeypatch.setattr(spend, "_melbourne_today", lambda t=today: t)
        seen.add(handler.get_paycycle_view(FakePayCycleRepo(cycle={"length": length, "last_pay_date": pay}))["days_left"])
    assert min(seen) == 1 and max(seen) == length
