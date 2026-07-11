"""Scheduled Lambda that sends the behind-pace goal nudge (WHIT-236).

EventBridge Scheduler (terraform/scheduler.tf, daily) -> this lambda -> sweep every goal,
send one Expo push per goal whose deadline is within this pay cycle and still short, deduped
per (goal, cycle) so a daily run fires at most once per goal per cycle.

Invoked only by EventBridge Scheduler, never by API Gateway. ``goal_nudge``, ``repository``,
and ``repository_notify`` are provided by the shared Lambda layer. Best-effort: any failure
is logged and swallowed so the invocation never errors — an unset marker just re-nudges on
the next sweep.
"""

import logging

from goal_nudge import notify_behind_goals
from repository import (
    AccountBalanceRepository,
    DeviceRepository,
    GoalsRepository,
    PayCycleRepository,
)
from repository_notify import NotifyRepository

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def lambda_handler(event, context):
    """Run the behind-pace nudge sweep. Returns the number of nudges sent."""
    try:
        sent = notify_behind_goals(
            goals_repo=GoalsRepository(),
            balance_repo=AccountBalanceRepository(),
            paycycle_repo=PayCycleRepository(),
            device_repo=DeviceRepository(),
            notify_repo=NotifyRepository(),
        )
    except Exception as e:
        logger.error("goal-nudge sweep failed: %s", e)
        return {"nudged": 0}

    logger.info("goal-nudge sweep: %d nudge(s) sent", sent)
    return {"nudged": sent}
