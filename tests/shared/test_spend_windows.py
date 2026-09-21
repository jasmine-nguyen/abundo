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


# --- completed_cycle_windows + transactions_in_window (budget rollover) -------


def test_completed_cycle_windows_are_the_full_cycles_between_anchor_and_now(shared):
    # Anchor 90 days before the current cycle_start, monthly (30) → exactly 3 completed
    # cycles, oldest-first, each a 30-day inclusive span abutting the next with no gap.
    windows = shared.spend.completed_cycle_windows("2026-05-08", "2026-08-06", 30, max_cycles=12)
    assert windows == [
        ("2026-05-08", "2026-06-06"),
        ("2026-06-07", "2026-07-06"),
        ("2026-07-07", "2026-08-05"),
    ]
    # Each window's end is the day before the next window's start (no overlap, no gap).
    for (s1, e1), (s2, _e2) in zip(windows, windows[1:]):
        assert (date.fromisoformat(s2) - date.fromisoformat(e1)).days == 1
    # The last completed window ends the day before the current cycle_start.
    assert (date.fromisoformat("2026-08-06") - date.fromisoformat(windows[-1][1])).days == 1


def test_completed_cycle_windows_empty_when_no_full_cycle_elapsed(shared):
    # current_start == anchor (still in the first cycle) → nothing to fold.
    assert shared.spend.completed_cycle_windows("2026-08-06", "2026-08-06", 30, max_cycles=12) == []
    # A current_start BEFORE the anchor (defensive) also yields nothing, never an inverted window.
    assert shared.spend.completed_cycle_windows("2026-08-06", "2026-07-01", 30, max_cycles=12) == []


def test_completed_cycle_windows_caps_to_the_most_recent_max_cycles(shared):
    # 6 full cycles have elapsed but the cap is 2 → only the 2 most-recent are returned
    # (the older leftovers are dropped; the caller advances its anchor past them).
    windows = shared.spend.completed_cycle_windows("2026-02-07", "2026-08-06", 30, max_cycles=2)
    assert windows == [
        ("2026-06-07", "2026-07-06"),
        ("2026-07-07", "2026-08-05"),
    ]


def test_transactions_in_window_filters_inclusive_by_date(shared):
    txns = [
        {"date": "2026-06-06", "id": "before-end"},   # on the end boundary -> kept
        {"date": "2026-06-07", "id": "after-end"},    # past the end -> dropped
        {"date": "2026-05-08", "id": "on-start"},     # on the start boundary -> kept
        {"date": "2026-05-07", "id": "before-start"}, # before the start -> dropped
        {"id": "no-date"},                            # no date -> can't place -> dropped
    ]
    kept = shared.spend.transactions_in_window(txns, "2026-05-08", "2026-06-06")
    assert [t["id"] for t in kept] == ["before-end", "on-start"]
