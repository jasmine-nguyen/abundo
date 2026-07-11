"""Server-side port of the client goal pace math for the behind-pace nudge (WHIT-236).

Ports two pure functions from ``src/context.tsx`` — ``paydaysUntil`` and the
remaining/``pacePerPayday`` slice of ``balanceGoalView`` — so the nudge computes pace
identically to the app. Pure over its inputs: the nudge job (``goal_nudge``) supplies the
live balance and "today". Kept dependency-free (no ``constants`` import) so it never trips
the WHIT-136 constants-sync guard.
"""

from datetime import date
from decimal import Decimal
from typing import Optional


def paydays_until(length: int, last_pay_date: str, target_date: str, today: date) -> int:
    """Count the paydays remaining before a target date: the dates ``last_pay_date +
    n*length`` that fall in the half-open window (today, target] — strictly after today,
    on or before target. Whole-day math (date ordinals) so a daylight-saving change can't
    shift the count. Mirrors ``paydaysUntil``: the count is
    ``floor(dTarget/length) - floor(dToday/length)`` (floor handles a future last_pay_date,
    where n<0). Returns 0 for a non-positive length or an unparseable date.
    """
    if length <= 0:
        return 0
    try:
        pay = date.fromisoformat(last_pay_date)
        target = date.fromisoformat(target_date)
    except ValueError:
        return 0
    days_to_today = today.toordinal() - pay.toordinal()
    days_to_target = target.toordinal() - pay.toordinal()
    # `//` is floor division (toward -inf), matching the client's Math.floor.
    return max(0, (days_to_target // length) - (days_to_today // length))


def goal_pace(
    goal: dict, current_balance: Optional[Decimal], length: int, last_pay_date: str, today: date
) -> dict:
    """Per-payday pace to hit a goal, ported from the pace slice of ``balanceGoalView``.

    ``current_balance`` is the live SIGNED balance for a synced goal (a loan is negative),
    or None when it hasn't been polled; it is ignored for a manual goal (whose
    ``manual_balance`` is used). Returns ``{paydays_left, remaining, pace_per_payday}``:
    ``remaining`` is floored at 0 (a met goal is 0, never negative); ``pace_per_payday`` is
    ``remaining / paydays_left``, or the whole remaining when 0 paydays are left (deadline
    reached). ``remaining``/``pace_per_payday`` are None when the balance is unknown (a
    synced goal not yet polled), matching the client's null.
    """
    direction = goal.get("direction")
    target = goal["target_amount"]
    synced = bool(goal.get("account_id"))

    raw = current_balance if synced else goal.get("manual_balance")
    known = raw is not None

    paydays_left = paydays_until(length, last_pay_date, goal.get("target_date", ""), today)

    if not known:
        return {"paydays_left": paydays_left, "remaining": None, "pace_per_payday": None}

    balance = Decimal(raw)
    # Normalise into a non-negative quantity, source-aware (matches balanceGoalView):
    #  grow    -> current savings; an overdrawn synced account clamps to 0, never abs.
    #  paydown -> amount OWED as a positive: synced owed = max(0, -balance) (loan stored
    #             negative); a manual debt is entered positive so owed = max(0, manual_balance).
    if direction == "grow":
        current = max(Decimal(0), balance)
        remaining = max(Decimal(0), target - current)
    else:
        current = max(Decimal(0), -balance if synced else balance)
        remaining = max(Decimal(0), current - target)

    pace_per_payday = remaining / Decimal(paydays_left) if paydays_left > 0 else remaining
    return {"paydays_left": paydays_left, "remaining": remaining, "pace_per_payday": pace_per_payday}
