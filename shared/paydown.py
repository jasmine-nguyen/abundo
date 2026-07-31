"""Pure home-loan amortization for the milestone suggester (WHIT-370).

Ports the client's amortize / requiredRepayment (src/context.tsx) to Python so the SERVER
owns every number the AI plan is built from — the AI only chooses which of these real points
to surface, never invents a figure.

Constant-free by design (rate / payment / horizon / start date are all args): this is a shared
flat module bundled into the API Lambda, and importing any `constants` name here would trip the
lambda_api constants shadow (WHIT-136). Dollar amounts round half-up with math.floor(x + 0.5) to
match the client's Math.round (the WHIT-307 banker's-rounding trap), and dates pin to the 1st of
the month like the client's addMonths, so a milestone list is strictly decreasing in balance and
strictly increasing in date.
"""

import math
from datetime import date


def round_dollars(amount) -> int:
    """Whole dollars, half-up (toward +inf) — matches the client's Math.round, NOT Python's
    banker's round() which would disagree by $1 on a half-dollar (WHIT-307)."""
    return math.floor(amount + 0.5)


def add_months(start: date, months: int) -> date:
    """`start` advanced by whole calendar months, pinned to the 1st — mirrors the client's
    addMonths (src/context.tsx). Pinning to day 1 keeps a 31st + n months from rolling into the
    wrong month, and matches the month-year granularity the app shows."""
    month_index = start.month - 1 + months
    year = start.year + month_index // 12
    month = month_index % 12 + 1
    return date(year, month, 1)


def months_to_payoff(balance, monthly_rate, monthly_payment):
    """Months to clear `balance` paying `monthly_payment` each month at monthly rate
    `monthly_rate` (a fraction, e.g. 0.0574/12). Closed form n = -ln(1 - B*i/pmt)/ln(1+i), the
    inverse of the annuity identity — mirrors the client's amortize. Returns None when the loan
    never pays off: the payment must be positive and, once interest accrues (i>0), strictly
    exceed the monthly interest B*i, or the balance can't fall. A non-positive balance is 0
    months; i<=0 is the interest-free straight line."""
    if not monthly_payment > 0:
        return None
    if balance <= 0:
        return 0.0
    if monthly_rate <= 0:
        return balance / monthly_payment
    if monthly_payment <= balance * monthly_rate:
        return None
    return -math.log(1 - (balance * monthly_rate) / monthly_payment) / math.log(1 + monthly_rate)


def required_monthly_payment(balance, monthly_rate, periods):
    """The payment needed to clear `balance` in exactly `periods` months at rate `monthly_rate`
    — the algebraic inverse of months_to_payoff (the client's requiredRepayment). Returns None
    when the inputs can't define a payment (non-positive balance/periods, or non-finite rate).
    The i<=0 straight-line case is B/n (the general form is 0/0 there)."""
    if not balance > 0 or not periods > 0 or not math.isfinite(monthly_rate):
        return None
    if monthly_rate <= 0:
        return balance / periods
    return (balance * monthly_rate) / (1 - (1 + monthly_rate) ** (-periods))


def amortization_curve(balance, monthly_rate, monthly_payment, *, start_date, max_months):
    """The real month-by-month paydown: a list of {month_offset, balance, date} from the FIRST
    month (offset 1) until the balance clears or `max_months` is reached. Each step is
    balance_{n+1} = balance_n*(1+i) - pmt; balances are whole dollars (half-up), dates pinned to
    the 1st `month_offset` months after `start_date`. The current balance (offset 0) is
    deliberately omitted — a milestone AT the current balance is degenerate. Assumes a paying-down
    loan (caller checks months_to_payoff is not None first); returns [] if the balance never falls.
    """
    points = []
    running = float(balance)
    for offset in range(1, max_months + 1):
        running = running * (1 + monthly_rate) - monthly_payment
        if running <= 0:
            points.append({"month_offset": offset, "balance": 0, "date": add_months(start_date, offset)})
            break
        points.append({"month_offset": offset, "balance": round_dollars(running), "date": add_months(start_date, offset)})
    return points
