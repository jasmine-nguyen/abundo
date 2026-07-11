"""WHIT-236 — adversarial parity/precision gaps in the pace port (shared/goal_pace.py)
that the implementer's test_goal_pace.py leaves open: non-fortnightly cycle lengths, the
target==today boundary, a paydown goal WITHOUT a baseline, and Decimal precision on a
non-integer pace. Expected values hand-computed in the Melbourne-pinned world of the
sibling suite (last_pay_date 2026-06-06, today Sat 11 Jul 2026).
"""

from datetime import date
from decimal import Decimal

TODAY = date(2026, 7, 11)


def _pu(shared, length, target, pay="2026-06-06", today=TODAY):
    return shared.goal_pace.paydays_until(length, pay, target, today)


def _pace(shared, **kw):
    return shared.goal_pace.goal_pace(**kw)


# --- paydays_until: cycle lengths other than 14 ------------------------------

class TestPaydaysUntilOtherLengths:
    def test_weekly_next_payday_only(self, shared):
        # [A20] weekly (7): Jun6..Jul11 are past; (Jul11, Jul18] -> only Jul18.
        assert _pu(shared, 7, "2026-07-18") == 1

    def test_weekly_two_paydays(self, shared):
        # [A21] (Jul11, Jul25] -> Jul18, Jul25 = 2.
        assert _pu(shared, 7, "2026-07-25") == 2

    def test_monthly_length_floor_math(self, shared):
        # [A22] 30-day cycle: floor(70/30)-floor(35/30) = 2-1 = 1.
        assert _pu(shared, 30, "2026-08-15") == 1

    def test_monthly_two_paydays(self, shared):
        # [A23] Sep20 -> floor(106/30)-floor(35/30) = 3-1 = 2.
        assert _pu(shared, 30, "2026-09-20") == 2


# --- goal_pace: boundary + precision holes -----------------------------------

class TestGoalPaceEdges:
    def _grow(self, **over):
        g = {"direction": "grow", "target_amount": Decimal(10000),
             "target_date": "2026-08-15", "account_id": "up-spending"}
        g.update(over)
        return g

    def test_target_date_today_is_zero_paydays_whole_remaining(self, shared):
        # [A24] target_date == today -> 0 paydays in (today, target]; the whole
        # remaining lands on one payday (deadline is here), NOT remaining/0.
        p = _pace(shared, goal=self._grow(target_date="2026-07-11"),
                  current_balance=Decimal(4000), length=14,
                  last_pay_date="2026-06-06", today=TODAY)
        assert p["paydays_left"] == 0
        assert p["remaining"] == Decimal(6000)
        assert p["pace_per_payday"] == Decimal(6000)

    def test_paydown_without_baseline_still_paces(self, shared):
        # [A25] pace math never reads `baseline` (it only drives progress %), so a
        # paydown goal with NO baseline still paces off owed - target.
        debt = {"direction": "paydown", "target_amount": Decimal(0),
                "target_date": "2026-08-15", "account_id": "up-homeloan"}
        p = _pace(shared, goal=debt, current_balance=Decimal(-12000), length=14,
                  last_pay_date="2026-06-06", today=TODAY)
        assert p["remaining"] == Decimal(12000)
        assert p["pace_per_payday"] == Decimal(4000)  # 12000 / 3

    def test_non_integer_pace_keeps_full_decimal_precision(self, shared):
        # [A26] remaining 8000 over 3 paydays is a repeating decimal; the port keeps
        # Decimal precision (not a truncated int) so the copy can round it correctly.
        p = _pace(shared, goal=self._grow(target_amount=Decimal(8000)),
                  current_balance=Decimal(0), length=14,
                  last_pay_date="2026-06-06", today=TODAY)
        assert p["paydays_left"] == 3
        assert p["remaining"] == Decimal(8000)
        # 8000/3 = 2666.66...; must be > 2666 and < 2667, i.e. NOT floored to an int.
        assert Decimal(2666) < p["pace_per_payday"] < Decimal(2667)
