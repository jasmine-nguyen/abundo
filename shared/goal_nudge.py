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

# Stale manual-balance nudge (WHIT-259 Part 2). {name} = goal name, {days} = how old.
_STALE_TITLE = "Time to update a goal \U0001f504"
_STALE_BODY = "Your {name} balance is {days} days old — tap to update."

# A manual goal's balance only changes when the user updates it, so it goes stale silently.
# 30 days matches the client's own "haven't updated in a while" tag (STALE_DAYS in
# app/(tabs)/goals.tsx) so the push and the on-screen tag agree. Kept a plain module constant
# (not in shared/constants.py) so goal_nudge stays clear of the WHIT-136 constants-sync guard,
# like goal_pace.
STALE_DAYS = 30

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


def is_stale(goal: dict, today: date, stale_days: int = STALE_DAYS) -> bool:
    """True if a MANUAL goal's hand-entered balance is older than `stale_days`. Synced goals
    refresh from the poller, so they're never stale. A missing/blank/unparseable manual_as_of
    is never stale (no false nudge)."""
    if goal.get("account_id"):
        return False  # synced — refreshes itself
    as_of = goal.get("manual_as_of")
    if not as_of:
        return False
    try:
        as_of_date = date.fromisoformat(as_of)
    except (ValueError, TypeError):
        # TypeError guards a non-string legacy/raw-DB value — an uncaught raise here would kill
        # the whole best-effort sweep, not just this goal. Matches the docstring's "never stale".
        return False
    return today.toordinal() - as_of_date.toordinal() > stale_days


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

    def send_and_mark(title: str, body: str, marker: str) -> int:
        """Send one push; mark the (goal, cycle) marker ONLY when it reached Expo (ok > 0) so an
        outage leaves it unmarked for the next sweep to retry. Returns 1 if sent, else 0."""
        if send_push(title, body, tokens)["ok"] <= 0:
            return 0
        notify_repo.mark_fired(last_pay_date, length, marker)
        fired.add(marker)
        return 1

    sent = 0
    for goal_id, goal in goals.items():
        # The behind and stale triggers each have their OWN per-cycle marker, so they fire
        # independently — a goal can get a stale nudge even after its behind nudge already fired
        # this cycle, and vice versa. Both share the FIRED set with the budget alerts'
        # "<catId>#<pct>" markers; the "GOAL#" prefix namespaces them so none collide.

        # Stale manual-balance nudge (age, not shortfall) — needs no pace/balance read.
        stale_marker = f"GOAL#{goal_id}#stale"
        if is_stale(goal, today) and stale_marker not in fired:
            days = today.toordinal() - date.fromisoformat(goal["manual_as_of"]).toordinal()
            body = _STALE_BODY.format(name=goal.get("name") or "goal", days=days)
            sent += send_and_mark(_STALE_TITLE, body, stale_marker)

        # Behind-pace nudge (deadline-slip) — unchanged from WHIT-236.
        behind_marker = f"GOAL#{goal_id}"
        if behind_marker in fired:
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
        sent += send_and_mark(_TITLE, body, behind_marker)

    return sent
