"""Behind-pace goal nudge (WHIT-236).

When a dated goal's deadline is effectively here and it isn't met yet, send ONE Expo push
per (goal, pay-cycle) telling the user what it'd take per payday to still hit the date.
Covers synced goals (live balance from the poller) and manual goals (their manual_balance).

Shaped like ``repayment_alerts.notify_repayments``: short-circuit before any I/O when there
are no goals or no devices, dedupe per (goal, cycle) via ``NotifyRepository``, and mark on
landing (only when the send reached Expo) so an outage re-nudges next sweep rather than
silently dropping.

"Behind" (WHIT-236 option A — no persisted goal start, so no true mid-flight "slipping"
signal): the deadline is within this pay cycle (at most one payday left before it), the goal
is still short, and the deadline hasn't already passed. This fires at most once or twice per
goal as the date approaches, then stops once the date lapses. A true "you've fallen behind
your plan" nudge needs a persisted start (a follow-up card), so the copy is framed as the
final push ("needs $X/payday to hit December"), never an accusation.
"""

import logging
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from goal_pace import goal_pace
from push import send_push
from spend import _melbourne_today

logger = logging.getLogger(__name__)

# Push copy. {name} = the goal's name, {pace} = whole dollars needed per payday,
# {month} = the target month. Currency is "$" to match the app's own formatting (fmt).
_TITLE = "A goal needs a nudge \U0001f3af"
_BODY = "Your {name} needs ${pace}/payday to hit {month}."

_MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


def _month_of(target_date: str) -> str:
    """The month name from an ISO YYYY-MM-DD target date (e.g. '2026-12-01' -> 'December').
    Falls back to 'your target date' if the month can't be read."""
    try:
        return _MONTHS[int(target_date[5:7]) - 1]
    except (ValueError, IndexError):
        return "your target date"


def _format_pace(amount: Decimal) -> str:
    """Whole dollars with thousands separators, rounded HALF-UP to match the client's
    Math.round (fmt in src/theme.ts) so the push figure equals the app's Goal screen.
    (Decimal's default `:,.0f` is banker's rounding, which diverges at exact half-dollars —
    e.g. 120.50 -> '120' there but '121' here / in the app.)"""
    return f"{amount.quantize(Decimal(0), rounding=ROUND_HALF_UP):,}"


def is_behind(goal: dict, pace: dict, today: date) -> bool:
    """True if `goal` should be nudged: the deadline is within this pay cycle (at most one
    payday left before it), the goal is still short (remaining > 0), and the deadline hasn't
    already passed. A met goal (remaining 0/None) or a lapsed deadline is never nudged."""
    remaining = pace["remaining"]
    if remaining is None or remaining <= 0:
        return False
    if pace["paydays_left"] > 1:
        return False
    try:
        if date.fromisoformat(goal.get("target_date", "")) < today:
            return False
    except ValueError:
        return False
    return True


def notify_behind_goals(
    *, goals_repo, balance_repo, paycycle_repo, device_repo, notify_repo, today: Optional[date] = None
) -> int:
    """Send one push per behind goal not already nudged this cycle. Returns the count sent.

    Best-effort throughout. Short-circuits before reading the pay cycle / balances when there
    are no goals or no registered devices. A synced goal whose account hasn't been polled yet
    is skipped (never a false nudge). Mark-on-landing: the (goal, cycle) marker is written
    ONLY when ``send_push`` reached Expo (``ok > 0``), so an Expo outage leaves it unmarked
    for the next daily sweep to retry.
    """
    goals = goals_repo.list_goals()
    if not goals:
        return 0

    tokens = device_repo.list_tokens()
    if not tokens:
        return 0

    if today is None:
        today = _melbourne_today()

    cycle = paycycle_repo.get_paycycle()
    length = cycle["length"]
    last_pay_date = cycle["last_pay_date"]

    synced_account_ids = [g["account_id"] for g in goals.values() if g.get("account_id")]
    balances = {}
    if synced_account_ids:
        balances = {b["account_id"]: b["amount"] for b in balance_repo.list_balances(synced_account_ids)}

    fired = notify_repo.fired_markers(last_pay_date, length)
    sent = 0
    for goal_id, goal in goals.items():
        # Markers share the per-cycle FIRED set with the budget alerts' "<catId>#<pct>"
        # markers; the "GOAL#" prefix namespaces them so the two can't collide.
        marker = f"GOAL#{goal_id}"
        if marker in fired:
            continue

        synced = bool(goal.get("account_id"))
        current_balance = balances.get(goal["account_id"]) if synced else None
        if synced and current_balance is None:
            continue  # not polled yet — never a false nudge

        pace = goal_pace(goal, current_balance, length, last_pay_date, today)
        if not is_behind(goal, pace, today):
            continue

        body = _BODY.format(
            name=goal.get("name") or "goal",
            pace=_format_pace(pace["pace_per_payday"]),
            month=_month_of(goal.get("target_date", "")),
        )
        if send_push(_TITLE, body, tokens)["ok"] > 0:  # mark only when it reached Expo
            notify_repo.mark_fired(last_pay_date, length, marker)
            fired.add(marker)
            sent += 1
        # send failed / no device accepted it → leave unmarked → next sweep retries

    return sent
