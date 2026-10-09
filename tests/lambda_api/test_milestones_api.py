"""Tests for the milestone endpoints (GET /milestones, PUT /milestones) and the
get_milestones / set_milestones handlers (WHIT-375, user-owned milestone plan).

Handler-level tests inject a FakeMilestoneRepo directly. GET returns the saved list
or [] (unset); PUT validates the list + each field, requires/preserves ids, enforces
the strictly-paid-down ordering, and stores the whole list.

The adversarial edge tests (whitelist/pk-smuggle, cap + label + count boundaries,
NaN/Inf, id trimming/whitespace) folded in from the former test_milestones_api_edges.py
live under the "adversarial edges" header at the bottom (WHIT-465 Slice 5).
"""

import json
from datetime import date, timedelta
from decimal import Decimal

import pytest

from _api_event import api_event

# A valid strictly-paid-down 3-row plan (decreasing balance, increasing date).
VALID = [
    {"label": "Kickoff", "targetBalance": 544000, "targetDate": "2026-06-18"},
    {"label": "Halfway", "targetBalance": 295000, "targetDate": "2027-12-18"},
    {"label": "Target", "targetBalance": 55000, "targetDate": "2029-06-18"},
]
# Single-row shorthand for the adversarial edge tests below (WHIT-375).
VALID0 = VALID[0]


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


def _put_event(body):
    return api_event(
        "PUT",
        "/milestones",
        raw=json.dumps(body) if not isinstance(body, str) else body,
        is_base64=False,
    )


def _put(handler, body, repo=None):
    repo = repo or FakeMilestoneRepo()
    return handler.set_milestones(_put_event(body), repo), repo


def _with_ids(milestones):
    # Every saved row needs an id (WHIT-830); fill one in where a test doesn't care which.
    return [{"id": f"m{i}", **m} for i, m in enumerate(milestones)]


def _put_plan(handler, milestones, repo=None):
    # Wrap a milestone list into the request body ({"milestones": [...]}) the endpoint expects.
    return _put(handler, {"milestones": _with_ids(milestones)}, repo)


# --- get_milestones ----------------------------------------------------------


def test_get_milestones_empty_list_when_unset(handler):
    assert handler.get_milestones({}, FakeMilestoneRepo(None)) == []


def test_route_get_milestones(handler, monkeypatch):
    saved = [{"id": "a", "label": "Kickoff", "targetBalance": 544000.0, "targetDate": "2026-06-18"}]
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: FakeMilestoneRepo(saved))
    event = api_event("GET", "/milestones")
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == saved


# --- set_milestones: success -------------------------------------------------


def test_set_milestones_success_persists(handler):
    resp, repo = _put_plan(handler, VALID)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert [m["label"] for m in body] == ["Kickoff", "Halfway", "Target"]
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


def test_set_milestones_zero_balance_is_allowed(handler):
    # A $0 target = "paid off" is a legitimate final milestone.
    plan = [
        {"label": "a", "targetBalance": 100000, "targetDate": "2026-06-18"},
        {"label": "Paid off", "targetBalance": 0, "targetDate": "2027-06-18"},
    ]
    resp, _ = _put_plan(handler, plan)
    assert resp["statusCode"] == 200


def test_route_put_milestones_dispatch(handler, monkeypatch):
    repo = FakeMilestoneRepo()
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: repo)
    resp = handler.lambda_handler(_put_event({"milestones": _with_ids(VALID)}), None)
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


# === adversarial edges (WHIT-375, folded in from test_milestones_api_edges.py) ==============
#
# Gaps beyond the happy-path + basic-validation tests above:
#   [A-EX]  extra unknown keys silently dropped (whitelist), a smuggled pk/sk never reaches the repo.
#   [A-CAPHI] targetBalance exactly at the cap accepted.
#   [A-NAN] targetBalance NaN / Infinity rejected (the math.isfinite guard).
#   [A-50]  a full 50-row valid plan accepted; 51 rejected (the count-cap boundary).
#   [A-LASTPAIR] a bad ordering on the LAST pair of a 3-row plan is caught (the loop scans all pairs).


# --- [A-EX] extra keys whitelisted away -------------------------------------

def test_extra_unknown_keys_are_dropped_and_pk_not_smuggled(handler):
    # A client sends junk + a forged pk/sk. Only the 4 known fields must survive; the
    # forged internal keys must never reach the repo (they would corrupt the row key).
    poisoned = {**VALID0, "id": "keep", "foo": "bar", "pk": "HACK", "sk": "HACK",
                "targetBalance": 544000, "isAdmin": True}
    resp, repo = _put_plan(handler, [poisoned])
    assert resp["statusCode"] == 200
    stored = repo.set_calls[0]["milestones"][0]
    assert set(stored) == {"id", "label", "targetBalance", "targetDate"}
    assert "pk" not in stored and "sk" not in stored and "foo" not in stored


# --- [A-CAPHI] balance cap boundary -----------------------------------------

def test_target_balance_exactly_at_cap_is_accepted(handler):
    # Read from the handler (WHIT-393) so a cap change needs no edit here.
    cap = handler._MILESTONE_BALANCE_MAX
    resp, repo = _put_plan(handler, [{**VALID0, "targetBalance": cap}])
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["milestones"][0]["targetBalance"] == cap


# --- [A-NAN] non-finite numbers ---------------------------------------------

@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_target_balance_non_finite_is_rejected(handler, bad):
    # json.dumps emits NaN/Infinity tokens and json.loads reads them back; only the
    # math.isfinite guard stops them reaching DynamoDB (which would 500 on a NaN Decimal).
    resp, repo = _put_plan(handler, [{**VALID0, "targetBalance": bad}])
    assert resp["statusCode"] == 400
    assert "targetBalance" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


# --- [A-50] count-cap boundary (the 51-row test above only checks the message) --

def _valid_plan(n):
    # n rows, strictly decreasing balance and strictly increasing date.
    start = date(2026, 1, 1)
    return [
        {"label": f"m{i}", "targetBalance": 1_000_000 - i * 1000,
         "targetDate": (start + timedelta(days=i)).isoformat()}
        for i in range(n)
    ]


def test_exactly_50_milestones_accepted(handler):
    resp, repo = _put_plan(handler, _valid_plan(50))
    assert resp["statusCode"] == 200
    assert len(repo.set_calls[0]["milestones"]) == 50


def test_51_milestones_rejected(handler):
    # Guard against an off-by-one that would let 51 through (the test above asserts the message;
    # this locks the boundary sits between 50 and 51).
    resp, repo = _put_plan(handler, _valid_plan(51))
    assert resp["statusCode"] == 400
    assert repo.set_calls == []


# --- [A-LASTPAIR] ordering loop scans EVERY pair, not just the first --------

def test_bad_ordering_on_last_pair_is_caught(handler):
    # First two rows fine; the LAST pair has an equal date. A loop that only checked the
    # first pair would wrongly accept this.
    plan = [
        {"label": "a", "targetBalance": 300000, "targetDate": "2026-06-18"},
        {"label": "b", "targetBalance": 200000, "targetDate": "2027-06-18"},
        {"label": "c", "targetBalance": 100000, "targetDate": "2027-06-18"},  # equal date vs prev
    ]
    resp, repo = _put_plan(handler, plan)
    assert resp["statusCode"] == 400
    assert "increasing targetDate" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


def test_seen_ids_is_per_request_not_shared_across_calls(handler):
    # WHIT-480: two independent saves reusing the same id must both succeed; a leaked
    # module-level seen-id set would 400 the second as a duplicate.
    resp1, repo1 = _put_plan(handler, [{**VALID0, "id": "dup"}])
    resp2, repo2 = _put_plan(handler, [{**VALID0, "id": "dup"}])
    assert resp1["statusCode"] == 200 and resp2["statusCode"] == 200
    assert repo1.set_calls[0]["milestones"][0]["id"] == "dup"
    assert repo2.set_calls[0]["milestones"][0]["id"] == "dup"
