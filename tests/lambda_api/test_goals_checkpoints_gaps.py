"""WHIT-479 slice 4a — gap tests for the MANUAL-goal checkpoint celebration on PUT /goals/{id}.

Complements the four manual-save tests in tests/lambda_api/test_goals.py. Adds: manual PAYDOWN
crossing, the skip-the-extra-read guard for synced saves, and the load-bearing detail that the
celebration runs against the SAVED (carried-forward) goal — not the request body — so a save that
omits `checkpoints` still celebrates against the stored ladder. notify_goal_checkpoint_crossing is
a recorder; the crossing math is unit-tested in tests/shared/test_goal_checkpoints.py.
"""

import json
from decimal import Decimal


class _FakeGoalsRepo:
    """Records list/upsert. `saved_override` lets a test force the SAVED goal shape the real repo
    would return (e.g. checkpoints carried forward when the request omitted them)."""

    def __init__(self, goals=None, saved_override=None):
        self._goals = goals or {}
        self._saved_override = saved_override
        self.list_calls = 0
        self.upsert_calls = []

    def list_goals(self):
        self.list_calls += 1
        return {k: dict(v) for k, v in self._goals.items()}

    def upsert_goal(self, goal_id, goal, start_candidate=None):
        self.upsert_calls.append((goal_id, goal))
        if self._saved_override is not None:
            return dict(self._saved_override)
        return {"id": goal_id, **goal, **(start_candidate or {})}


class _FakeBalanceRepo:
    def list_balances(self, account_ids):
        return []


def _put_event(goal_id="g1", body=None):
    return {
        "rawPath": f"/goals/{goal_id}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"id": goal_id},
        "body": json.dumps(body),
        "isBase64Encoded": False,
    }


def _manual_grow_body(**over):
    body = {"name": "Holiday", "icon": "palm", "direction": "grow",
            "target_amount": 10000, "target_date": "2026-12-01",
            "manual_balance": 5000, "manual_as_of": "2026-07-01",
            "checkpoints": [{"label": "Halfway", "amount": 4000}]}
    body.update(over)
    return body


def _manual_paydown_body(**over):
    body = {"name": "Car loan", "icon": "car", "direction": "paydown",
            "target_amount": 0, "target_date": "2027-06-01",
            "manual_balance": 3000, "manual_as_of": "2026-07-01",
            "checkpoints": [{"label": "Under 4k", "amount": 4000}]}
    body.update(over)
    return body


def _synced_body(**over):
    body = {"name": "Holiday", "icon": "palm", "direction": "grow",
            "target_amount": 10000, "target_date": "2026-12-01",
            "account_id": "up-spending",
            "checkpoints": [{"label": "Halfway", "amount": 4000}]}
    body.update(over)
    return body


_STORED_PAYDOWN = {
    "id": "g1", "name": "Car loan", "icon": "car", "direction": "paydown",
    "target_amount": Decimal("0"), "target_date": "2027-06-01",
    "manual_balance": Decimal("5000"), "manual_as_of": "2026-07-01",
    "checkpoints": [{"id": "cp1", "label": "Under 4k", "amount": Decimal("4000")}],
}


def _record(handler, monkeypatch):
    seen = []
    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing",
                        lambda old, new, **kw: seen.append((old, new, kw["goal_id"], kw["synced"],
                                                            kw["goal"].get("checkpoints"))) or 1)
    return seen


# [A40] a MANUAL paydown whose entered owed drops through a rung celebrates (owed 5000 -> 3000).
def test_manual_paydown_save_fires_with_old_then_new_owed(handler, monkeypatch):
    repo = _FakeGoalsRepo(goals={"g1": dict(_STORED_PAYDOWN)})
    seen = _record(handler, monkeypatch)
    resp = handler.upsert_goal(_put_event(body=_manual_paydown_body(manual_balance=3000)),
                               repo, _FakeBalanceRepo())
    assert resp["statusCode"] == 200
    assert seen[0][:4] == (Decimal("5000"), Decimal("3000"), "g1", False)


# [A41] a SYNCED save skips the extra stored-goal read entirely (the poller owns synced crossings).
def test_synced_save_does_not_read_the_old_goal(handler, monkeypatch):
    repo = _FakeGoalsRepo()
    seen = _record(handler, monkeypatch)
    resp = handler.upsert_goal(_put_event(body=_synced_body()), repo, _FakeBalanceRepo())
    assert resp["statusCode"] == 200
    assert seen == []                 # never fires on a synced save
    assert repo.list_calls == 0       # and never pays for the old-balance read


# [A42] a manual save fires exactly ONE old-goal read (needed to compute the crossing).
def test_manual_save_reads_the_old_goal_once(handler, monkeypatch):
    repo = _FakeGoalsRepo(goals={"g1": dict(_STORED_PAYDOWN)})
    _record(handler, monkeypatch)
    handler.upsert_goal(_put_event(body=_manual_grow_body()), repo, _FakeBalanceRepo())
    assert repo.list_calls == 1


# [A43] celebration runs against the SAVED (carried-forward) ladder, not the request body:
# the save OMITS checkpoints, but the stored ladder must still drive the crossing.
def test_manual_save_omitting_checkpoints_celebrates_against_saved_ladder(handler, monkeypatch):
    carried = [{"id": "cp1", "label": "Carried", "amount": Decimal("4000")}]
    saved = {"id": "g1", "name": "Holiday", "icon": "palm", "direction": "grow",
             "target_amount": Decimal("10000"), "target_date": "2026-12-01",
             "manual_balance": Decimal("5000"), "manual_as_of": "2026-07-01",
             "checkpoints": carried}
    repo = _FakeGoalsRepo(
        goals={"g1": {"direction": "grow", "manual_balance": Decimal("1000"), "checkpoints": carried}},
        saved_override=saved,
    )
    seen = _record(handler, monkeypatch)
    # Body omits `checkpoints` entirely.
    body = _manual_grow_body(manual_balance=5000)
    del body["checkpoints"]
    resp = handler.upsert_goal(_put_event(body=body), repo, _FakeBalanceRepo())
    assert resp["statusCode"] == 200
    # old=stored 1000, new=saved 5000, and the ladder passed is the SAVED carried one.
    assert seen[0][0] == Decimal("1000")
    assert seen[0][1] == Decimal("5000")
    assert seen[0][4] == carried
