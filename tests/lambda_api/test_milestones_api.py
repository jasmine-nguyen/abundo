"""Tests for the milestone endpoints (GET /milestones, PUT /milestones) and the
get_milestones / set_milestones handlers (WHIT-375, user-owned milestone plan).

Handler-level tests inject a FakeMilestoneRepo directly. GET returns the saved list
or [] (unset); PUT validates the list + each field, assigns/preserves ids, enforces
the strictly-paid-down ordering, and stores the whole list.
"""

import json
from decimal import Decimal

import pytest

# A valid strictly-paid-down 3-row plan (decreasing balance, increasing date).
VALID = [
    {"label": "Kickoff", "targetBalance": 544000, "targetDate": "2026-06-18"},
    {"label": "Halfway", "targetBalance": 295000, "targetDate": "2027-12-18"},
    {"label": "Target", "targetBalance": 55000, "targetDate": "2029-06-18"},
]


class FakeMilestoneRepo:
    """Handler-level stand-in for MilestoneRepository."""

    def __init__(self, milestones=None):
        self._milestones = milestones
        self.set_calls = []

    def get_milestones(self, scope="SHARED"):
        return list(self._milestones) if self._milestones is not None else None

    def set_milestones(self, milestones, scope="SHARED"):
        self.set_calls.append({"milestones": milestones, "scope": scope})
        # Echo the list with targetBalance as float, mirroring the real repo.
        return [{**m, "targetBalance": float(m["targetBalance"])} for m in milestones]


class FakeNotifyRepo:
    """Handler-level stand-in for NotifyRepository (WHIT-447). Records every migrate call and
    applies the same only-if-celebrated rename the real repo does, so a test can assert the
    mint-migration. Empty fired set by default → migration is a no-op for the existing tests."""

    def __init__(self, fired=None):
        self.fired = set(fired or set())
        self.migrate_calls = []

    def fired_milestones(self, scope=None):
        return set(self.fired)

    def migrate_milestone_markers(self, migrations, scope=None):
        self.migrate_calls.append({"migrations": list(migrations), "scope": scope})
        for old, new in migrations:
            if old in self.fired:
                self.fired.add(new)
                self.fired.discard(old)


def _put_event(body):
    return {
        "rawPath": "/milestones",
        "requestContext": {"http": {"method": "PUT"}},
        "body": json.dumps(body) if not isinstance(body, str) else body,
        "isBase64Encoded": False,
    }


def _put(handler, body, repo=None, notify_repo=None):
    repo = repo or FakeMilestoneRepo()
    notify_repo = notify_repo or FakeNotifyRepo()
    return handler.set_milestones(_put_event(body), repo, notify_repo), repo


def _put_plan(handler, milestones, repo=None):
    # Wrap a milestone list into the request body ({"milestones": [...]}) the endpoint expects.
    return _put(handler, {"milestones": milestones}, repo)


# --- get_milestones ----------------------------------------------------------


def test_get_milestones_empty_list_when_unset(handler):
    assert handler.get_milestones({}, FakeMilestoneRepo(None)) == []


def test_get_milestones_returns_saved_list(handler):
    saved = [{"id": "a", "label": "Kickoff", "targetBalance": 544000.0, "targetDate": "2026-06-18"}]
    assert handler.get_milestones({}, FakeMilestoneRepo(saved)) == saved


def test_route_get_milestones(handler, monkeypatch):
    saved = [{"id": "a", "label": "Kickoff", "targetBalance": 544000.0, "targetDate": "2026-06-18"}]
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: FakeMilestoneRepo(saved))
    event = {"rawPath": "/milestones", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == saved


# --- set_milestones: success -------------------------------------------------


def test_set_milestones_success_assigns_ids_and_persists(handler):
    resp, repo = _put_plan(handler, VALID)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert [m["label"] for m in body] == ["Kickoff", "Halfway", "Target"]
    # Every returned milestone has a non-empty id (the server minted them).
    assert all(isinstance(m["id"], str) and m["id"] for m in body)
    # The repo received a Decimal, not a raw float — boto3's DynamoDB client raises on a
    # float, so a float regression would 500 every PUT. isinstance is the real guard;
    # `== Decimal(...)` alone is a tautology a float also satisfies.
    stored_balance = repo.set_calls[0]["milestones"][0]["targetBalance"]
    assert isinstance(stored_balance, Decimal)
    assert stored_balance == Decimal("544000")


def test_set_milestones_stores_cents_exactly(handler):
    # A cents value must round-trip exactly via Decimal(str(...)); a float() conversion
    # would drift (595413.43 -> 595413.4299999…), so this reddens if storage goes float.
    resp, repo = _put_plan(handler, [{**VALID[0], "targetBalance": 595413.43}])
    assert resp["statusCode"] == 200
    stored = repo.set_calls[0]["milestones"][0]["targetBalance"]
    assert isinstance(stored, Decimal)
    assert stored == Decimal("595413.43")


def test_set_milestones_preserves_supplied_ids(handler):
    with_ids = [{**m, "id": f"m{i}"} for i, m in enumerate(VALID)]
    resp, _ = _put_plan(handler, with_ids)
    assert resp["statusCode"] == 200
    assert [m["id"] for m in json.loads(resp["body"])] == ["m0", "m1", "m2"]


def test_set_milestones_mixed_ids_stay_unique(handler):
    # Some rows carry ids, some don't; assigned ids must not collide with supplied ones.
    mixed = [{**VALID[0], "id": "keep"}, {**VALID[1]}, {**VALID[2], "id": "keep2"}]
    resp, _ = _put_plan(handler, mixed)
    assert resp["statusCode"] == 200
    ids = [m["id"] for m in json.loads(resp["body"])]
    assert ids[0] == "keep" and ids[2] == "keep2"
    assert len(set(ids)) == 3


def test_set_milestones_single_milestone_is_valid(handler):
    # A one-row plan has no consecutive pairs, so the ordering rule trivially passes.
    resp, _ = _put_plan(handler, [VALID[0]])
    assert resp["statusCode"] == 200


def test_set_milestones_zero_balance_is_allowed(handler):
    # A $0 target = "paid off" is a legitimate final milestone.
    plan = [
        {"label": "a", "targetBalance": 100000, "targetDate": "2026-06-18"},
        {"label": "Paid off", "targetBalance": 0, "targetDate": "2027-06-18"},
    ]
    resp, _ = _put_plan(handler, plan)
    assert resp["statusCode"] == 200


def test_set_milestones_label_is_trimmed(handler):
    resp, repo = _put_plan(handler, [{**VALID[0], "label": "  Kickoff  "}])
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["milestones"][0]["label"] == "Kickoff"


def test_route_put_milestones_dispatch(handler, monkeypatch):
    repo = FakeMilestoneRepo()
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: repo)
    monkeypatch.setattr(handler, "NotifyRepository", FakeNotifyRepo)
    resp = handler.lambda_handler(_put_event({"milestones": VALID}), None)
    assert resp["statusCode"] == 200
    assert len(repo.set_calls) == 1


# --- set_milestones: validation ----------------------------------------------


@pytest.mark.parametrize(
    "body, needle",
    [
        ({"milestones": "nope"}, "non-empty list"),                                    # not a list
        ({"milestones": []}, "non-empty list"),                                        # empty list
        ({}, "non-empty list"),                                                        # missing key
        ({"milestones": ["x"]}, "must be an object"),                                  # item not a dict
        ({"milestones": [{**VALID[0], "label": ""}]}, "non-empty label"),              # blank label
        ({"milestones": [{**VALID[0], "label": "   "}]}, "non-empty label"),           # whitespace label
        ({"milestones": [{"targetBalance": 1, "targetDate": "2026-06-18"}]}, "label"), # missing label
        ({"milestones": [{**VALID[0], "targetBalance": True}]}, "targetBalance"),       # bool
        ({"milestones": [{**VALID[0], "targetBalance": "1"}]}, "targetBalance"),        # string
        ({"milestones": [{**VALID[0], "targetBalance": -1}]}, "targetBalance"),         # negative
        ({"milestones": [{**VALID[0], "targetBalance": 2_000_000_000}]}, "targetBalance"),  # over cap
        ({"milestones": [{**VALID[0], "targetDate": "2026/06/18"}]}, "targetDate"),     # wrong format
        ({"milestones": [{**VALID[0], "targetDate": "2026-02-30"}]}, "targetDate"),     # impossible date
        ({"milestones": [{**VALID[0], "id": ""}]}, "id must be"),                       # blank id
    ],
)
def test_set_milestones_rejects_bad_fields(handler, body, needle):
    resp, repo = _put(handler, body)
    assert resp["statusCode"] == 400
    assert needle in json.loads(resp["body"])["error"]
    assert repo.set_calls == []   # nothing persisted on a rejected write


def test_set_milestones_rejects_over_max_count(handler):
    # 51 rows exceed the 50-milestone cap (checked before ordering, so order is irrelevant).
    too_many = {"milestones": [{"label": f"m{i}", "targetBalance": 1, "targetDate": "2026-06-18"} for i in range(51)]}
    resp, repo = _put(handler, too_many)
    assert resp["statusCode"] == 400
    assert "at most" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


def test_set_milestones_rejects_duplicate_ids(handler):
    dup = [{**VALID[0], "id": "same"}, {**VALID[1], "id": "same"}]
    resp, repo = _put_plan(handler, dup)
    assert resp["statusCode"] == 400
    assert "unique" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


def test_set_milestones_rejects_equal_balance(handler):
    # Dates strictly increase but two balances are equal → not strictly paid-down.
    plan = [
        {"label": "a", "targetBalance": 300000, "targetDate": "2026-06-18"},
        {"label": "b", "targetBalance": 300000, "targetDate": "2027-06-18"},
    ]
    resp, repo = _put_plan(handler, plan)
    assert resp["statusCode"] == 400
    assert "decreasing targetBalance" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


def test_set_milestones_rejects_equal_date(handler):
    # Balances strictly decrease but two dates are equal → not strictly increasing.
    plan = [
        {"label": "a", "targetBalance": 300000, "targetDate": "2026-06-18"},
        {"label": "b", "targetBalance": 200000, "targetDate": "2026-06-18"},
    ]
    resp, repo = _put_plan(handler, plan)
    assert resp["statusCode"] == 400
    assert "increasing targetDate" in json.loads(resp["body"])["error"]


def test_set_milestones_rejects_wrong_direction(handler):
    # An increasing balance (a loan going UP) is rejected.
    plan = [
        {"label": "a", "targetBalance": 200000, "targetDate": "2026-06-18"},
        {"label": "b", "targetBalance": 300000, "targetDate": "2027-06-18"},
    ]
    resp, _ = _put_plan(handler, plan)
    assert resp["statusCode"] == 400


def test_set_milestones_rejects_invalid_json(handler):
    resp, _ = _put(handler, "{not json")
    assert resp["statusCode"] == 400
