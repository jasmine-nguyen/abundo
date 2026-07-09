"""Unit tests for the pay-cycle window helpers in shared/spend.py — specifically
nth_prior_cycle_window, the historical look-back stepping WHIT-68 shares between
/breakdown and the AI trend. Pure date math; no repos, no AWS.
"""

from datetime import date, timedelta

import pytest


def test_first_prior_cycle_is_the_length_day_span_ending_the_day_before(shared):
    # Current cycle starts 2024-01-31, fortnightly → prior cycle is [2024-01-17,
    # 2024-01-30]: a full 14 inclusive days that ends the day before the current start.
    start, end = shared.spend.nth_prior_cycle_window("2024-01-31", 14, 1)
    assert (start, end) == ("2024-01-17", "2024-01-30")
    assert (date.fromisoformat(end) - date.fromisoformat(start)).days == 13  # 14 inclusive days


def test_nth_prior_steps_back_n_full_cycles_with_no_gap(shared):
    p1_start, _p1_end = shared.spend.nth_prior_cycle_window("2024-01-31", 14, 1)
    p2_start, p2_end = shared.spend.nth_prior_cycle_window("2024-01-31", 14, 2)
    assert (p2_start, p2_end) == ("2024-01-03", "2024-01-16")
    # The 2nd prior window ends exactly the day before the 1st prior window starts.
    assert (date.fromisoformat(p1_start) - date.fromisoformat(p2_end)).days == 1


@pytest.mark.parametrize("length", [7, 14, 30])
def test_prior_window_spans_exactly_length_days_for_each_cadence(shared, length):
    start, end = shared.spend.nth_prior_cycle_window("2024-06-01", length, 1)
    assert date.fromisoformat(start) == date(2024, 6, 1) - timedelta(days=length)
    assert date.fromisoformat(end) == date(2024, 6, 1) - timedelta(days=1)


def test_prior_window_abuts_the_current_cycle_start(shared):
    # Derive the current cycle start the way the endpoint does, then step back once:
    # the prior window's end is the day before the current window's start (no overlap).
    cycle_start, _today = shared.spend.current_cycle_window("2024-01-03", 14, today=date(2024, 1, 20))
    assert cycle_start == "2024-01-17"
    _prior_start, prior_end = shared.spend.nth_prior_cycle_window(cycle_start, 14, 1)
    assert (date.fromisoformat(cycle_start) - date.fromisoformat(prior_end)).days == 1


def test_n_below_one_raises(shared):
    # n < 1 is a caller bug (the current window comes from current_cycle_window, not
    # here); the helper raises rather than returning an inverted window.
    with pytest.raises(ValueError):
        shared.spend.nth_prior_cycle_window("2024-01-31", 14, 0)
    with pytest.raises(ValueError):
        shared.spend.nth_prior_cycle_window("2024-01-31", 14, -1)
