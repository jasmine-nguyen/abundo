"""WHIT-375 — adversarial edge tests for the milestone endpoints, INDEPENDENT of the
implementer's tests/lambda_api/test_milestones_api.py (no duplication).

Gaps covered here (each verified absent from the implementer's suite first):
  [A-EX]  extra unknown keys on a milestone are silently dropped (whitelist), and a
          smuggled pk/sk never reaches the repo.
  [A-CAPHI] targetBalance exactly at the cap (1_000_000_000) is accepted; cap+1 rejected.
  [A-NAN] targetBalance NaN / Infinity rejected (the math.isfinite guard).
  [A-LBL] label longer than 100 chars rejected; exactly 100 accepted.
  [A-50]  a full 50-row valid plan is accepted (the count-cap boundary; impl only tests 51).
  [A-LASTPAIR] a bad ordering on the LAST pair of a 3-row plan is caught (loop scans all pairs).
  [A-ZERONF] a 0 balance in a NON-final position forces a negative next balance → rejected.
"""

import json
from datetime import date, timedelta

import pytest

VALID0 = {"label": "Kickoff", "targetBalance": 544000, "targetDate": "2026-06-18"}


class FakeMilestoneRepo:
    def __init__(self, milestones=None):
        self._milestones = milestones
        self.set_calls = []

    def get_milestones(self, scope="SHARED"):
        return list(self._milestones) if self._milestones is not None else None

    def set_milestones(self, milestones, scope="SHARED"):
        self.set_calls.append({"milestones": milestones, "scope": scope})
        return [{**m, "targetBalance": float(m["targetBalance"])} for m in milestones]


def _put_event(body):
    return {
        "rawPath": "/milestones",
        "requestContext": {"http": {"method": "PUT"}},
        "body": json.dumps(body) if not isinstance(body, str) else body,
        "isBase64Encoded": False,
    }


def _put_plan(handler, milestones, repo=None):
    repo = repo or FakeMilestoneRepo()
    return handler.set_milestones(_put_event({"milestones": milestones}), repo), repo


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
    resp, repo = _put_plan(handler, [{**VALID0, "targetBalance": 1_000_000_000}])
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["milestones"][0]["targetBalance"] == 1_000_000_000


def test_target_balance_one_over_cap_is_rejected(handler):
    resp, repo = _put_plan(handler, [{**VALID0, "targetBalance": 1_000_000_001}])
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


# --- [A-50] count-cap boundary (impl only tests 51) -------------------------

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
    # Guard against an off-by-one that would let 51 through (impl asserts the message;
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
