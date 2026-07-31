"""Tests for shared/paydown.py — the pure amortization the milestone suggester builds on
(WHIT-370). Two layers: closed-form parity with the client twin (src/context.tsx amortize /
requiredRepayment), and the month-by-month curve's dollar rounding + first-of-month dates.
"""

import math
from datetime import date

import pytest


# --- round_dollars: half-up, NOT banker's (the WHIT-307 trap) -------------------------------

def test_round_dollars_is_half_up_not_bankers(shared):
    r = shared.paydown.round_dollars
    # Python's built-in round() is half-to-even: round(2.5)==2, round(0.5)==0. Half-up must
    # give 3 and 1 — matching the client's Math.round so a pushed figure equals the screen.
    assert r(2.5) == 3
    assert r(0.5) == 1
    assert r(1000.5) == 1001
    assert r(480000.0) == 480000
    assert r(417.1) == 417


# --- add_months: whole months, pinned to the 1st -------------------------------------------

def test_add_months_pins_to_first_and_rolls_years(shared):
    add = shared.paydown.add_months
    assert add(date(2026, 1, 31), 1) == date(2026, 2, 1)   # no "Feb 31" roll into March
    assert add(date(2026, 11, 15), 3) == date(2027, 2, 1)  # crosses the year boundary
    assert add(date(2026, 6, 1), 0) == date(2026, 6, 1)


# --- months_to_payoff / required_monthly_payment: closed-form parity ------------------------

def test_months_to_payoff_matches_the_closed_form(shared):
    balance, i, pmt = 500000.0, 0.0574 / 12, 3000.0
    expected = -math.log(1 - (balance * i) / pmt) / math.log(1 + i)
    assert shared.paydown.months_to_payoff(balance, i, pmt) == pytest.approx(expected)


def test_required_monthly_payment_matches_the_closed_form(shared):
    balance, i, n = 500000.0, 0.0574 / 12, 120.0
    expected = (balance * i) / (1 - (1 + i) ** (-n))
    assert shared.paydown.required_monthly_payment(balance, i, n) == pytest.approx(expected)


def test_payoff_and_required_are_inverses(shared):
    # required_monthly_payment then months_to_payoff round-trips (the invariant the TS twin
    # documents): pay the required amount and you clear the loan in exactly the given months.
    balance, i, n = 500000.0, 0.0574 / 12, 120.0
    pmt = shared.paydown.required_monthly_payment(balance, i, n)
    assert shared.paydown.months_to_payoff(balance, i, pmt) == pytest.approx(n)


def test_months_to_payoff_none_when_loan_never_clears(shared):
    balance, i = 500000.0, 0.0574 / 12
    interest_only = balance * i
    assert shared.paydown.months_to_payoff(balance, i, interest_only) is None  # pmt == interest
    assert shared.paydown.months_to_payoff(balance, i, interest_only - 1) is None
    assert shared.paydown.months_to_payoff(balance, i, 0) is None               # no payment


def test_months_to_payoff_zero_when_already_paid_off(shared):
    # A non-positive balance is already clear -> 0 months, regardless of rate/payment.
    assert shared.paydown.months_to_payoff(0.0, 0.0574 / 12, 3000.0) == 0.0
    assert shared.paydown.months_to_payoff(-100.0, 0.0574 / 12, 3000.0) == 0.0


def test_interest_free_is_straight_line(shared):
    assert shared.paydown.months_to_payoff(1000.0, 0.0, 250.0) == pytest.approx(4.0)
    assert shared.paydown.required_monthly_payment(1000.0, 0.0, 4.0) == pytest.approx(250.0)


def test_required_none_on_degenerate_inputs(shared):
    req = shared.paydown.required_monthly_payment
    assert req(0.0, 0.004, 12.0) is None
    assert req(1000.0, 0.004, 0.0) is None
    assert req(1000.0, float("inf"), 12.0) is None


# --- amortization_curve: real month-by-month schedule --------------------------------------

def test_curve_interest_free_pins_exact_points(shared):
    # i=0: balance falls by exactly pmt each month; the final month clamps to 0 and stops.
    curve = shared.paydown.amortization_curve(
        1000.0, 0.0, 300.0, start_date=date(2026, 1, 1), max_months=12)
    assert [(p["month_offset"], p["balance"], p["date"]) for p in curve] == [
        (1, 700, date(2026, 2, 1)),
        (2, 400, date(2026, 3, 1)),
        (3, 100, date(2026, 4, 1)),
        (4, 0, date(2026, 5, 1)),
    ]


def test_curve_with_interest_pins_rounded_points(shared):
    # balance_{n+1} = balance_n*(1+i) - pmt, balances rounded to whole dollars (half-up).
    curve = shared.paydown.amortization_curve(
        1000.0, 0.01, 300.0, start_date=date(2026, 1, 1), max_months=12)
    assert [p["balance"] for p in curve] == [710, 417, 121, 0]


def test_curve_is_strictly_paid_down(shared):
    # Every step: a strictly LOWER balance and a strictly LATER (first-of-month) date — the
    # ordering set_milestones requires. Excludes the current balance (starts at offset 1).
    curve = shared.paydown.amortization_curve(
        480000.0, 0.0574 / 12, 4000.0, start_date=date(2026, 1, 1), max_months=1200)
    assert curve[0]["month_offset"] == 1
    for prev, cur in zip(curve, curve[1:]):
        assert cur["balance"] < prev["balance"]
        assert cur["date"] > prev["date"]
    assert curve[-1]["balance"] == 0
