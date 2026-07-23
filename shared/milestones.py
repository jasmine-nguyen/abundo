"""Home-loan payoff milestone celebration push (WHIT-301).

When the daily balance poll shows the mortgage balance has crossed a named payoff
milestone, send one bigger celebratory Expo push — once ever per milestone. The
milestone plan is transcribed from the Notion "IP1 Equity Milestones" db and kept
in lockstep with the client twin (src/milestones.ts); the drift-pin test asserts the
exact rows so a transcription slip fails loudly.

Detection lives in the balance poller, NOT the webhook: the webhook only sees the
gross repayment credit, never the outstanding balance. It is edge-triggered
(old > target >= new from the poll's before/after) and marks the milestone fired
REGARDLESS of send outcome. The stored prior balance is the natural high-water mark,
so shipping the feature never retroactively celebrates already-crossed milestones,
and a milestone can't double-fire. The trade-off — a transient Expo outage at the one
crossing poll loses that celebration — is acceptable for a feel-good push (the balance
only moves down, so the crossing is never re-detected to retry).
"""

import logging
import math
from dataclasses import dataclass

from push import send_push

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Milestone:
    sprint: int
    label: str
    target_balance: int


# The payoff plan, transcribed from the Notion "IP1 Equity Milestones" db and kept in
# lockstep with src/milestones.ts (targetBalance/label). targetDate is not needed here —
# this trigger is balance-based, not date-based. If the plan in Notion changes, update
# BOTH this table and src/milestones.ts; the drift-pin test pins the exact rows.
MILESTONES = (
    Milestone(0, "Kickoff", 544000),
    Milestone(1, "Quarter way", 420000),
    Milestone(2, "Halfway", 295000),
    Milestone(3, "Three-quarters", 170000),
    Milestone(4, "Target", 55000),
)

def _assert_strictly_paid_down(milestones) -> None:
    """Each later milestone must be a lower balance (mirrors src/milestones.ts), or "first
    target below the balance" and the crossing check would silently pick the wrong one.
    Fails loud at import so a transcription typo trips immediately."""
    for prev, cur in zip(milestones, milestones[1:]):
        if not (cur.target_balance < prev.target_balance):
            raise ValueError(f"MILESTONES must have strictly decreasing target_balance (sprint {cur.sprint})")


_assert_strictly_paid_down(MILESTONES)

_TITLE = "\U0001f389 Milestone reached — {label}!"
_BODY_FULL = "You're ${paid} down on your mortgage, with ${equity} in equity unlocked. Keep building! \U0001f4aa"
_BODY_BARE = "Another mortgage milestone in the bag. Keep building! \U0001f4aa"


def usable_equity(home_value: float, balance: float, lvr: float) -> int:
    """Usable equity toward a deposit: property value × LVR − balance, clamped at 0,
    whole dollars. Mirrors src/milestones.ts usableEquity — INCLUDING its Math.round, which
    rounds a half-dollar UP (toward +∞). Python's built-in round() is half-to-even (banker's),
    so it would disagree with the in-app screen by exactly $1 on a half-dollar; math.floor(x +
    0.5) reproduces Math.round so the push figure always matches the screen (WHIT-307)."""
    return max(0, math.floor(home_value * lvr - balance + 0.5))


def crossed_milestones(old_balance, new_balance) -> list:
    """The milestones the balance crossed on this poll (old > target >= new), furthest-
    along first (lowest target). Empty when old_balance is None (the first-ever poll —
    the seed guard), the balance rose, or nothing was crossed."""
    if old_balance is None:
        return []
    crossed = [m for m in MILESTONES if old_balance > m.target_balance >= new_balance]
    return sorted(crossed, key=lambda m: m.target_balance)


def _dollars(amount) -> str:
    """Whole dollars with thousands separators, e.g. 305000 -> '305,000'."""
    return f"{amount:,.0f}"


def _body(new_balance, loanfacts_repo) -> str:
    """The celebratory body: paid-down + usable-equity figures when the user's loan
    facts are set, else a number-free line. new_balance is a Decimal; loan facts are
    floats, so cast to float before the arithmetic (avoids a float/Decimal TypeError)."""
    facts = loanfacts_repo.get_loanfacts()
    if not facts:
        return _BODY_BARE
    # Clamp at 0 (like usable_equity) so misconfigured facts (original < balance) never render a
    # negative "$-N down" in a celebration.
    paid = max(0.0, facts["original"] - float(new_balance))
    equity = usable_equity(facts["homeValue"], float(new_balance), facts["lvr"])
    return _BODY_FULL.format(paid=_dollars(paid), equity=_dollars(equity))


def notify_milestone_crossing(old_balance, new_balance, *, loanfacts_repo, device_repo, notify_repo) -> int:
    """Send one celebratory push when the balance crosses a payoff milestone.

    Fires the furthest-along newly-crossed milestone and marks EVERY freshly-crossed one
    fired (so a lump-sum jump past several doesn't nag later) — marking REGARDLESS of send
    outcome, because the stored prior balance means a crossing is never re-detected, so
    "mark only on send" would lose the push forever on a transient failure. Short-circuits
    before any I/O when nothing new was crossed, and before sending when no device is
    registered. Returns 1 if a push was sent, else 0. Best-effort: the caller swallows."""
    crossed = crossed_milestones(old_balance, new_balance)
    if not crossed:
        return 0

    fired = notify_repo.fired_milestones()
    fresh = [m for m in crossed if str(m.sprint) not in fired]
    if not fresh:
        return 0

    tokens = device_repo.list_tokens()
    if not tokens:
        return 0

    furthest = fresh[0]  # sorted asc by target → lowest balance = furthest paid down
    send_push(
        _TITLE.format(label=furthest.label),
        _body(new_balance, loanfacts_repo),
        tokens,
        data={"type": "milestone"},  # deep-link a tap to the mortgage screen (WHIT-322)
    )
    for milestone in fresh:  # mark regardless of send outcome (see docstring)
        notify_repo.mark_milestone_fired(str(milestone.sprint))
    return 1
