"""WHIT-236 — parity tests for the server pace port (shared/goal_pace.py) against the
client engine (src/context.tsx paydaysUntil + the pace slice of balanceGoalView). The
expected values are hand-computed and mirror the client's own logic tests
(balanceGoal.logic.test.ts) so a revert of the port reddens here. Fortnightly cycle whose
paydays land Jun6, Jun20, Jul4, Jul18, Aug1, Aug15, Aug29; "today" = Sat 11 Jul 2026.
"""

from datetime import date
from decimal import Decimal

import pytest

CYCLE = {"length": 14, "last_pay_date": "2026-06-06"}
TODAY = date(2026, 7, 11)


def _pace(shared, **kw):
    return shared.goal_pace.goal_pace(**kw)


# --- paydays_until -----------------------------------------------------------

class TestPaydaysUntil:
    def _n(self, shared, target, today=TODAY, cycle=CYCLE):
        return shared.goal_pace.paydays_until(cycle["length"], cycle["last_pay_date"], target, today)

    def test_counts_the_payday_landing_on_the_target(self, shared):
        # (Jul11, Jul18] -> only Jul18. Naive floor(7/14) would say 0.
        assert self._n(shared, "2026-07-18") == 1

    def test_excludes_a_payday_one_day_past_the_target(self, shared):
        assert self._n(shared, "2026-07-17") == 0

    def test_excludes_todays_own_payday(self, shared):
        # today = Jul4 (a payday); (Jul4, Jul18] -> only Jul18.
        assert self._n(shared, "2026-07-18", today=date(2026, 7, 4)) == 1

    def test_future_last_pay_date_fills_backward(self, shared):
        # pay=Aug1; (Jul11, Sep1] -> Jul18, Aug1, Aug15, Aug29 = 4. Needs floor division on a
        # negative delta (last_pay_date in the future) — truncation would diverge.
        n = shared.goal_pace.paydays_until(14, "2026-08-01", "2026-09-01", TODAY)
        assert n == 4

    def test_target_before_last_pay_date_is_zero(self, shared):
        assert self._n(shared, "2026-06-01") == 0

    def test_non_positive_length_is_zero(self, shared):
        assert shared.goal_pace.paydays_until(0, "2026-06-06", "2026-08-15", TODAY) == 0

    def test_unparseable_date_is_zero(self, shared):
        assert self._n(shared, "not-a-date") == 0


# --- goal_pace: grow ---------------------------------------------------------

class TestGoalPaceGrow:
    def _goal(self, **over):
        goal = {"direction": "grow", "target_amount": Decimal(10000),
                "target_date": "2026-08-15", "account_id": "up-spending"}
        goal.update(over)
        return goal

    def test_remaining_over_paydays_left(self, shared):
        # target_date Aug15 -> 3 paydays (Jul18, Aug1, Aug15). remaining 6000 / 3 = 2000.
        p = _pace(shared, goal=self._goal(), current_balance=Decimal(4000),
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["paydays_left"] == 3
        assert p["remaining"] == Decimal(6000)
        assert p["pace_per_payday"] == Decimal(2000)

    def test_baseline_does_not_change_pace(self, shared):
        # pace uses target - current, NOT the baseline (baseline only drives progress).
        p = _pace(shared, goal=self._goal(baseline=Decimal(2000)), current_balance=Decimal(4000),
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["remaining"] == Decimal(6000)

    def test_overdrawn_synced_clamps_to_zero_current(self, shared):
        # balance -50 -> current 0 -> remaining full 10000 (not abs(-50)).
        p = _pace(shared, goal=self._goal(), current_balance=Decimal(-50),
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["remaining"] == Decimal(10000)

    def test_met_goal_is_zero_remaining_and_pace(self, shared):
        p = _pace(shared, goal=self._goal(target_amount=Decimal(20000)), current_balance=Decimal(25000),
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["remaining"] == Decimal(0)
        assert p["pace_per_payday"] == Decimal(0)

    def test_manual_grow_reads_manual_balance(self, shared):
        goal = self._goal(account_id=None, manual_balance=Decimal(4000))
        p = _pace(shared, goal=goal, current_balance=None,
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["pace_per_payday"] == Decimal(2000)

    def test_synced_unknown_balance_is_none_pace(self, shared):
        p = _pace(shared, goal=self._goal(), current_balance=None,
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["remaining"] is None
        assert p["pace_per_payday"] is None
        assert p["paydays_left"] == 3  # paydays still count

    def test_overdue_puts_whole_remaining_on_one_payday(self, shared):
        p = _pace(shared, goal=self._goal(target_date="2026-06-01"), current_balance=Decimal(4000),
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["paydays_left"] == 0
        assert p["pace_per_payday"] == Decimal(6000)  # remaining, not remaining/0


# --- goal_pace: paydown ------------------------------------------------------

class TestGoalPacePaydown:
    def _debt(self, **over):
        goal = {"direction": "paydown", "target_amount": Decimal(0), "baseline": Decimal(20000),
                "target_date": "2026-08-15", "account_id": "up-spending"}
        goal.update(over)
        return goal

    def test_synced_negative_balance_normalised_to_owed(self, shared):
        # synced -12000 -> owed 12000 -> remaining 12000 / 3 = 4000.
        p = _pace(shared, goal=self._debt(), current_balance=Decimal(-12000),
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["remaining"] == Decimal(12000)
        assert p["pace_per_payday"] == Decimal(4000)

    def test_manual_debt_matches_synced_negative(self, shared):
        manual = self._debt(account_id=None, manual_balance=Decimal(12000))
        p = _pace(shared, goal=manual, current_balance=None,
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["pace_per_payday"] == Decimal(4000)

    def test_synced_loan_in_credit_reads_as_met(self, shared):
        # balance +200 -> owed max(0, -200) = 0 -> remaining 0, pace 0 (no phantom debt).
        p = _pace(shared, goal=self._debt(), current_balance=Decimal(200),
                  length=14, last_pay_date="2026-06-06", today=TODAY)
        assert p["remaining"] == Decimal(0)
        assert p["pace_per_payday"] == Decimal(0)
