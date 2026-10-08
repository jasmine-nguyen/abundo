"""WHIT-830 — the poller has no built-in default plan and no id-less milestone fallback.

  * a failed plan read → no plan this poll: no push, no marker removed, a warning logged;
  * a stored row without a usable id is skipped and logged (MILESTONE_ROW_MALFORMED), the same rule
    as the client read, and every marker no live milestone matches — the old sample plan's bare
    "0".."4" and the pre-id "bal:<amount>" records — is swept.
"""

import logging
from decimal import Decimal

import pytest

from _milestone_fakes import (
    FACTS, FakeDeviceRepo, FakeLoanFactsRepo, FakeMilestoneRepo, notify_repo, recorder,
    removed_markers, stored_markers, unreadable_milestone_repo,
)
from _milestone_row_fakes import _GOOD, _KEEP_MARKER

_ID_LESS = {"label": "Old", "targetBalance": Decimal("480000"), "targetDate": "2030-01-01"}
_SEEDED = {"0", "bal:480000.00", _KEEP_MARKER}
# No "0": the old built-in plan's Kickoff (544000) would fire for it, so a revert shows as a push.
_SEEDED_NO_SPRINT = {"bal:480000.00", _KEEP_MARKER}

_SCENARIOS = [
    # (milestone_repo, seeded markers, old, new, expected removed, expected kept, log level, log text)
    pytest.param(
        unreadable_milestone_repo(), _SEEDED_NO_SPRINT, "545000", "544000",
        set(), _SEEDED_NO_SPRINT, logging.WARNING, "read failed",
        id="read failure: no plan, nothing swept"),
    pytest.param(
        FakeMilestoneRepo(stored=[dict(_GOOD), dict(_ID_LESS)]), _SEEDED, "490000", "470000",
        {"0", "bal:480000.00"}, {_KEEP_MARKER}, logging.ERROR, "MILESTONE_ROW_MALFORMED",
        id="id key missing: row skipped, old markers swept"),
    pytest.param(
        FakeMilestoneRepo(stored=[dict(_GOOD), {**_ID_LESS, "id": None}]), _SEEDED, "490000", "470000",
        {"0", "bal:480000.00"}, {_KEEP_MARKER}, logging.ERROR, "MILESTONE_ROW_MALFORMED",
        id="id null: row skipped, old markers swept"),
]


@pytest.mark.parametrize("milestone_repo, seeded, old, new, removed, kept, level, log_text", _SCENARIOS)
def test_poll_celebrates_only_saved_milestones_with_an_id(
        shared, recorder, caplog, milestone_repo, seeded, old, new, removed, kept, level, log_text):
    notify = notify_repo(seeded)

    with caplog.at_level(logging.WARNING, logger="milestones"):
        sent = shared.milestones.notify_milestone_crossing(
            Decimal(old), Decimal(new),
            loanfacts_repo=FakeLoanFactsRepo(FACTS), device_repo=FakeDeviceRepo(),
            notify_repo=notify, milestone_repo=milestone_repo)

    assert sent == 0
    assert recorder == []
    assert removed_markers(notify) == removed
    assert stored_markers(notify) == kept
    assert any(log_text in r.message and r.levelno == level for r in caplog.records)
