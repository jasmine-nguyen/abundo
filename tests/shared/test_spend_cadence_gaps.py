"""WHIT-559 PR2a — cadence_cycles boundary gaps not covered by test_spend_cadence.py (which covers
the map, both clamps via 365/7, non-positive, and a clean Decimal). Here: the upper clamp is
INCLUSIVE at SPREAD_MAX_CYCLES (exactly-at-max is NOT clamped down), and a Decimal gap whose quotient
is not a whole number still rounds numerically."""

from decimal import Decimal

import pytest


def test_exactly_at_the_max_is_kept_not_clamped_down(shared):
    # [A30] 336/14 = 24 exactly -> stays 24. Distinguishes an inclusive clamp (min(c, 24)) from an
    # off-by-one exclusive one (min(c, 23)) that 365 alone would not localise to the boundary.
    assert shared.spend.cadence_cycles(336, 14) == 24


def test_one_beat_over_the_max_clamps_to_the_max(shared):
    # [A31] 350/14 = 25 -> clamps to 24. Pins the first value past the boundary.
    assert shared.spend.cadence_cycles(350, 14) == 24


def test_a_non_whole_decimal_quotient_rounds_numerically(shared):
    # [A32] A Decimal gap off a stored row whose /length is not whole still rounds (45/14 = 3.21 -> 3),
    # never raises on the Decimal/int division.
    assert shared.spend.cadence_cycles(Decimal("45"), 14) == 3
