"""Unit tests for cadence_cycles (shared/spend.py) — the cadence→pay-cycles conversion a rule uses
to auto-smooth a bill (WHIT-559). Pure: a bill's day-gap and the user's pay-cycle length in,
a clamped whole number of cycles out."""

from decimal import Decimal

import pytest


@pytest.mark.parametrize("gap, length, expected", [
    (14, 14, 1),                 # weekly-on-fortnightly beat -> one cycle
    (30, 14, 2),                 # monthly bill on a fortnightly pay cycle -> ~2 cycles
    (91, 30, 3),                 # quarterly on monthly -> 3
    (30, 30, 1),                 # monthly bill, monthly pay cycle -> 1
    (7, 14, 1),                  # sub-cycle cadence rounds down to the floor, never 0
    (365, 14, 24),               # a yearly bill clamps to SPREAD_MAX_CYCLES (24), not 26
    (Decimal("30"), 14, 2),      # a Decimal gap off a stored rule row divides fine
])
def test_cadence_cycles_maps_and_clamps(shared, gap, length, expected):
    assert shared.spend.cadence_cycles(gap, length) == expected


def test_a_yearly_bill_is_clamped_to_the_max(shared):
    # FAIL-ON-REVERT for the upper clamp: 365/14 = 26 rounds past SPREAD_MAX_CYCLES(24) -> clamp to 24.
    assert shared.spend.cadence_cycles(365, 14) == 24


def test_a_sub_cycle_cadence_floors_at_one(shared):
    # FAIL-ON-REVERT for the lower clamp: 7/14 rounds to 0; the floor keeps it at 1 (never a 0-cycle
    # spread, which would divide by zero in the spread math).
    assert shared.spend.cadence_cycles(7, 14) == 1


@pytest.mark.parametrize("gap, length", [(0, 14), (-5, 14), (30, 0), (30, -1)])
def test_non_positive_inputs_fall_back_to_the_minimum(shared, gap, length):
    # A malformed cadence/length spreads over one cycle rather than crashing or returning nonsense.
    assert shared.spend.cadence_cycles(gap, length) == 1
