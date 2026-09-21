"""Goal-checkpoint crossing celebration (WHIT-479 slice 4a).

When a goal's balance passes one of its checkpoints — UPWARD for a savings (grow) goal, DOWNWARD
for a debt (paydown) goal — send ONE Expo push, once ever per checkpoint. Reuses the
mortgage-milestone marker SHAPE (repository_notify's NOTIFY#GOALCHECKPOINT set) without touching
the mortgage feature (shared/milestones.py, NOTIFY#MILESTONE) — the crossing predicate is net-new
because crossed_milestones is downward-only and structurally can't detect an upward crossing.

A flat top-level module (staged by `cp shared/*.py`, terraform/layers.tf). Imports no name from
`constants` at load, so it never crosses the lambda_api/constants.py shadow (WHIT-136).
"""

import logging
from decimal import Decimal

from push import send_push

logger = logging.getLogger(__name__)

_TITLE = "\U0001f389 Checkpoint reached — {label}!"
_BODY = "You hit {label} on your {name}. Keep going! \U0001f4aa"


def normalise_goal_balance(value: Decimal, direction: str, synced: bool) -> Decimal:
    """Collapse a signed balance into the same non-negative quantity the checkpoint amounts and
    the goal card's "N of M reached" count (src/context.tsx normaliseBalance) live in — its exact
    Python twin. grow -> the savings amount (an overdrawn account clamps to 0); paydown -> the
    amount OWED as a positive (a synced loan is stored negative, a manual debt entered positive)."""
    if direction == "grow":
        return max(Decimal(0), value)
    return max(Decimal(0), -value if synced else value)


def _checkpoint_marker(goal_id: str, checkpoint: dict) -> str:
    """The once-ever dedup marker for a crossed checkpoint: the goal id + the checkpoint's
    permanent id + its cent-quantized amount (mirrors shared/milestones.py _plan_marker). Keying
    on the id survives rename/reorder; including the amount means re-pointing a checkpoint re-arms
    its celebration; the cent quantize keeps the marker byte-stable across polls regardless of how
    the stored Decimal formats (5000 / 5000.0 / 5000.00 all -> the same "...:bal:5000.00")."""
    amount = Decimal(str(checkpoint["amount"])).quantize(Decimal("0.01"))
    return f"g:{goal_id}:cp:{checkpoint['id']}:bal:{amount}"


def crossed_checkpoints(goal: dict, old_norm, new_norm) -> list:
    """The checkpoints the balance crossed on this tick, in stored-ladder order (furthest-along
    last). Direction-aware and net-new: grow crosses UPWARD (old < amount <= new), paydown
    DOWNWARD (old > amount >= new). The inclusive `new` edge matches the goal card's reached rule
    (balance >= amount / <= amount) so the card and the celebration never disagree.

    Empty when old_norm is None (the first-ever balance — the seed guard, so a brand-new goal
    doesn't fire a burst) or nothing was crossed. A checkpoint at/below the start never fires: old
    was already past it, so there's no crossing (baseline tolerance falls out here for free)."""
    if old_norm is None:
        return []
    grow = goal.get("direction") == "grow"
    crossed = []
    for checkpoint in goal.get("checkpoints") or []:
        amount = Decimal(str(checkpoint["amount"]))
        reached = old_norm < amount <= new_norm if grow else old_norm > amount >= new_norm
        if reached:
            crossed.append(checkpoint)
    return crossed


def notify_goal_checkpoint_crossing(
    old_signed, new_signed, *, goal, goal_id, synced, device_repo, notify_repo, scope=None
) -> int:
    """Send one push when a goal's balance crosses a checkpoint. Fires the furthest-along freshly
    crossed checkpoint and marks EVERY freshly-crossed one — regardless of send outcome, because
    the stored prior balance means a crossing is never re-detected, so "mark only on send" would
    lose the push forever on a transient failure. Short-circuits before any I/O when nothing was
    crossed, and before sending when no device is registered. Returns 1 if a push was sent, else 0.
    Best-effort: the caller swallows.

    `scope` is the multi-tenant seam (mirrors milestones): None is the single shared tenant today.
    """
    direction = goal.get("direction")
    old_norm = None if old_signed is None else normalise_goal_balance(Decimal(str(old_signed)), direction, synced)
    new_norm = normalise_goal_balance(Decimal(str(new_signed)), direction, synced)

    crossed = crossed_checkpoints(goal, old_norm, new_norm)
    if not crossed:
        return 0

    fired = notify_repo.fired_goal_checkpoints(scope)
    fresh = [cp for cp in crossed if _checkpoint_marker(goal_id, cp) not in fired]
    if not fresh:
        return 0

    tokens = device_repo.list_tokens()
    if not tokens:
        # No device registered yet: send nothing AND mark nothing, so the marker isn't burned on a
        # push no one could receive. NB this only re-fires if the balance genuinely crosses the rung
        # AGAIN later — for a synced goal the poller stores `new`, so next poll old==new (already
        # past) and this exact crossing is not re-detected. A crossing while push is disabled is
        # therefore forgone, not deferred; that's acceptable (the user wasn't going to receive it).
        return 0

    # fresh[-1] is the furthest-along freshly-crossed rung — last in stored-ladder order. Safe ONLY
    # because the writer (_validate_goal_checkpoints in lambda_api) enforces a strictly increasing
    # ladder for grow / strictly decreasing for paydown, so stored order == monotonic in direction
    # (grow -> highest last, paydown -> lowest-owed last). If a future write path stored an unordered
    # ladder this would name the wrong rung; the ordering invariant lives at write time, not here.
    furthest = fresh[-1]
    send_push(
        _TITLE.format(label=furthest["label"]),
        _BODY.format(label=furthest["label"], name=goal.get("name") or "goal"),
        tokens,
        data={"type": "goalcheckpoint", "goalId": goal_id},  # deep-link a tap to the goals screen
    )
    for checkpoint in fresh:  # mark regardless of send outcome (see docstring)
        notify_repo.mark_goal_checkpoint_fired(_checkpoint_marker(goal_id, checkpoint), scope)
    return 1
