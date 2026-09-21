"""Unit tests for the bill-spread math in shared/spend.py (WHIT-504): `spread_index`
(how many cycles a plan is past its anchor) and `spread_adjustment` (the signed amount a
cycle's spendable moves by). Pure arithmetic; no repos, no AWS.

The invariant every test circles back to: the anchor cycle gets the full `+amount`
cushion, the next `cycles` cycles each give back a slice, and those slices sum to
EXACTLY the amount — so the plan nets to zero and no cent is created or lost.
"""

from decimal import Decimal

import pytest


# --- spread_adjustment: cushion, slices, then nothing ---------------------------


def test_anchor_cycle_gets_the_full_amount_as_a_cushion(shared):
    assert shared.spend.spread_adjustment(Decimal("1390.91"), 4, 0) == Decimal("1390.91")


@pytest.mark.parametrize("amount, cycles", [
    ("1390.91", 4),   # the Insurance bill that motivated the feature
    ("100.00", 3),    # not evenly divisible — the odd cent must land somewhere
    ("0.01", 3),      # one cent over three cycles: one slice carries it, two are zero
    ("250.00", 1),    # a single payback cycle
    ("999.99", 24),   # the max cycle count
])
def test_the_payback_slices_sum_back_to_exactly_the_amount(shared, amount, cycles):
    # FAIL-ON-REVERT for the cent-exact split: a naive amount/cycles rounding would drift
    # by a cent on the non-divisible cases and break net-zero.
    amount = Decimal(amount)
    slices = [shared.spend.spread_adjustment(amount, cycles, k) for k in range(1, cycles + 1)]
    assert all(s <= 0 for s in slices)
    assert sum(slices, Decimal(0)) == -amount
    # Net over the plan's whole life: cushion + slices == 0.
    assert shared.spend.spread_adjustment(amount, cycles, 0) + sum(slices, Decimal(0)) == 0


def test_the_odd_cents_go_on_the_earliest_slices(shared):
    # $100 over 3: 10000 cents = 3333 * 3 + 1 -> the first slice carries the extra cent.
    assert shared.spend.spread_adjustment(Decimal("100.00"), 3, 1) == Decimal("-33.34")
    assert shared.spend.spread_adjustment(Decimal("100.00"), 3, 2) == Decimal("-33.33")
    assert shared.spend.spread_adjustment(Decimal("100.00"), 3, 3) == Decimal("-33.33")
    # $1390.91 over 4: 139091 = 34772 * 4 + 3 -> three slices of 347.73, then 347.72.
    assert shared.spend.spread_adjustment(Decimal("1390.91"), 4, 1) == Decimal("-347.73")
    assert shared.spend.spread_adjustment(Decimal("1390.91"), 4, 4) == Decimal("-347.72")


def test_the_last_payback_cycle_is_index_n_and_the_plan_is_over_at_n_plus_one(shared):
    # FAIL-ON-REVERT for the off-by-one: index == cycles is still a payback cycle (the LAST
    # slice); index == cycles + 1 is past the plan and contributes nothing.
    amount = Decimal("1390.91")
    assert shared.spend.spread_adjustment(amount, 4, 4) == Decimal("-347.72")
    assert shared.spend.spread_adjustment(amount, 4, 5) == Decimal(0)


def test_far_past_the_plan_still_contributes_nothing(shared):
    # A first-open-after-a-long-gap read: the position keeps counting up past `cycles`, and
    # the plan must stay finished — never re-arm or keep draining.
    assert shared.spend.spread_adjustment(Decimal("1390.91"), 24, 25) == Decimal(0)
    assert shared.spend.spread_adjustment(Decimal("1390.91"), 24, 500) == Decimal(0)


def test_a_negative_index_contributes_nothing(shared):
    # No aligned plan produces one (the anchor is never in the future), but the math must
    # not hand out a cushion or a slice for it.
    assert shared.spend.spread_adjustment(Decimal("100.00"), 3, -1) == Decimal(0)


# --- spread_index: an UNCAPPED elapsed-cycle count ------------------------------


def test_spread_index_counts_whole_cycles_since_the_anchor(shared):
    assert shared.spend.spread_index("2026-08-06", "2026-08-06", 30) == 0   # still the anchor cycle
    assert shared.spend.spread_index("2026-07-07", "2026-08-06", 30) == 1   # the next cycle
    assert shared.spend.spread_index("2026-05-08", "2026-08-06", 30) == 3


@pytest.mark.parametrize("length", [7, 14, 30])
def test_spread_index_steps_once_per_cycle_for_each_cadence(shared, length):
    from datetime import date, timedelta

    anchor = date(2026, 1, 1)
    for k in range(0, 6):
        current = (anchor + timedelta(days=k * length)).isoformat()
        assert shared.spend.spread_index(anchor.isoformat(), current, length) == k


def test_spread_index_is_not_capped_by_a_lookback_limit(shared):
    # FAIL-ON-REVERT for the saturation bug: deriving the position from the CAPPED
    # `completed_cycle_windows` (max 12 or 24) would pin a long-gap read at the cap, so a
    # plan whose `cycles` equals the cap could never be seen to end. The direct count keeps
    # climbing: ~948 days on a 30-day cycle is 31 cycles, past any cap.
    index = shared.spend.spread_index("2024-01-01", "2026-08-06", 30)
    assert index == 31
    assert index > 24
    assert index != len(shared.spend.completed_cycle_windows("2024-01-01", "2026-08-06", 30, 24))
