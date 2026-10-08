"""WHIT-830 — saving a milestone plan requires an id on every row; the server no longer makes one up.

Drives set_milestones(event, repo) over the REAL MilestoneRepository on a FakeTable, so "nothing
saved" is read back from the store rather than from a spy.
"""

import json

import pytest

from _dynamo_fakes import FakeTable
from _milestone_fakes import milestones_put_event

_KICKOFF = {"label": "Kickoff", "targetBalance": 544000, "targetDate": "2026-06-18"}
_HALFWAY = {"id": "half", "label": "Halfway", "targetBalance": 295000, "targetDate": "2027-12-18"}


@pytest.mark.parametrize("first_row, status", [
    pytest.param(_KICKOFF, 400, id="id key missing"),
    pytest.param({**_KICKOFF, "id": None}, 400, id="id explicitly null"),
    pytest.param({**_KICKOFF, "id": "kick"}, 200, id="id supplied"),
])
def test_user_can_save_a_plan_only_when_every_milestone_has_an_id(handler, first_row, status):
    repo = handler.MilestoneRepository()
    repo._table = FakeTable()

    resp = handler.set_milestones(milestones_put_event([first_row, _HALFWAY]), repo)

    assert resp["statusCode"] == status
    body = json.loads(resp["body"])
    if status == 400:
        assert body == {"error": "milestone id is required"}
        assert repo.get_milestones() is None
        return
    assert [m["id"] for m in body] == ["kick", "half"]
    assert [m["id"] for m in repo.get_milestones()] == ["kick", "half"]
