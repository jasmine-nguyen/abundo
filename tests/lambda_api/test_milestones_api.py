"""Tests for the milestone endpoints (GET /milestones, PUT /milestones) and the
get_milestones / set_milestones handlers (WHIT-375, user-owned milestone plan).

Handler-level tests inject a FakeMilestoneRepo directly. GET returns the saved list
or [] (unset); PUT validates the list + each field, assigns/preserves ids, enforces
the strictly-paid-down ordering, and stores the whole list.

The adversarial edge tests (whitelist/pk-smuggle, cap + label + count boundaries,
NaN/Inf, id trimming/whitespace) folded in from the former test_milestones_api_edges.py
live under the "adversarial edges" header at the bottom (WHIT-465 Slice 5).
"""

import json
from datetime import date, timedelta
from decimal import Decimal

import pytest

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


# === adversarial edges (WHIT-375, folded in from test_milestones_api_edges.py) ==============
#
# Gaps beyond the happy-path + basic-validation tests above:
#   [A-EX]  extra unknown keys silently dropped (whitelist), a smuggled pk/sk never reaches the repo.
#   [A-CAPHI] targetBalance exactly at the cap accepted; cap+1 rejected.
#   [A-NAN] targetBalance NaN / Infinity rejected (the math.isfinite guard).
#   [A-LBL] label longer than 100 chars rejected; exactly 100 accepted.
#   [A-50]  a full 50-row valid plan accepted (the count-cap boundary; the 51-row test above only
#           checks the message).
#   [A-LASTPAIR] a bad ordering on the LAST pair of a 3-row plan is caught (the loop scans all pairs).
#   [A-ZERONF] a 0 balance in a NON-final position forces a negative next balance → rejected.


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


def test_target_balance_one_over_cap_is_rejected(handler):
    resp, repo = _put_plan(handler, [{**VALID0, "targetBalance": handler._MILESTONE_BALANCE_MAX + 1}])
    assert resp["statusCode"] == 400
    assert "targetBalance" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


# --- [A-NAN] non-finite numbers ---------------------------------------------

@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_target_balance_non_finite_is_rejected(handler, bad):
    # json.dumps emits NaN/Infinity tokens and json.loads reads them back; only the
    # math.isfinite guard stops them reaching DynamoDB (which would 500 on a NaN Decimal).
    resp, repo = _put_plan(handler, [{**VALID0, "targetBalance": bad}])
    assert resp["statusCode"] == 400
    assert "targetBalance" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


# --- [A-LBL] label length boundary ------------------------------------------

def test_label_exactly_100_chars_is_accepted(handler):
    resp, _ = _put_plan(handler, [{**VALID0, "label": "x" * 100}])
    assert resp["statusCode"] == 200


def test_label_over_100_chars_is_rejected(handler):
    resp, repo = _put_plan(handler, [{**VALID0, "label": "x" * 101}])
    assert resp["statusCode"] == 400
    assert "too long" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


def test_label_trimmed_before_length_check(handler):
    # 100 real chars wrapped in whitespace trims to 100 → still accepted (guard uses
    # the trimmed length, not the raw length).
    resp, _ = _put_plan(handler, [{**VALID0, "label": "  " + "x" * 100 + "  "}])
    assert resp["statusCode"] == 200


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


# --- [A-ZERONF] 0 balance is only valid as the FINAL step -------------------

def test_zero_balance_before_another_row_is_rejected(handler):
    # A 0 ("paid off") mid-plan forces the next balance strictly below 0 → negative →
    # rejected at field validation. Proves 0 can only ever be the last milestone.
    plan = [
        {"label": "a", "targetBalance": 100000, "targetDate": "2026-06-18"},
        {"label": "paid", "targetBalance": 0, "targetDate": "2027-06-18"},
        {"label": "impossible", "targetBalance": -1, "targetDate": "2028-06-18"},
    ]
    resp, repo = _put_plan(handler, plan)
    assert resp["statusCode"] == 400
    assert "targetBalance" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


# --- WHIT-383 supplied-id trimming ------------------------------------------

def test_supplied_id_is_stored_trimmed(handler):
    # A client-supplied id with stray whitespace is stored trimmed, mirroring the label.
    resp, repo = _put_plan(handler, [{**VALID0, "id": "  a  "}])
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["milestones"][0]["id"] == "a"


def test_ids_differing_only_by_whitespace_collide_as_duplicate(handler):
    # " a " and "a" are the SAME id once trimmed -> rejected as duplicate. Fail-on-revert:
    # without the .strip() they stay distinct and this plan wrongly returns 200.
    plan = [
        {"label": "A", "targetBalance": 544000, "targetDate": "2026-06-18", "id": " a "},
        {"label": "B", "targetBalance": 400000, "targetDate": "2027-06-18", "id": "a"},
    ]
    resp, repo = _put_plan(handler, plan)
    assert resp["statusCode"] == 400
    assert "unique" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


@pytest.mark.parametrize("blank", ["   ", "\t", "\n", " \t\n "])
def test_whitespace_only_id_is_rejected_not_stripped_to_empty(handler, blank):
    # An ALL-whitespace id must be rejected as non-empty-string, NOT silently stripped to
    # "" then stored/deduped. Guards the elif-before-else ordering.
    resp, repo = _put_plan(handler, [{**VALID0, "id": blank}])
    assert resp["statusCode"] == 400
    assert "non-empty string" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


def test_tab_newline_padded_id_is_stored_trimmed(handler):
    # Trimming covers tabs/newlines, not just spaces.
    resp, repo = _put_plan(handler, [{**VALID0, "id": "\t a1 \n"}])
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["milestones"][0]["id"] == "a1"


def test_internal_whitespace_in_id_is_preserved(handler):
    # strip() only trims the ENDS: an id with internal spaces keeps them, so two genuinely
    # different ids aren't collapsed by over-trimming.
    plan = [
        {**VALID0, "id": "a b"},
        {"label": "B", "targetBalance": 400000, "targetDate": "2027-06-18", "id": "ab"},
    ]
    resp, repo = _put_plan(handler, plan)
    assert resp["statusCode"] == 200
    assert [m["id"] for m in repo.set_calls[0]["milestones"]] == ["a b", "ab"]
