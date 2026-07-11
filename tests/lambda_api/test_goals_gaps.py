"""WHIT-231 — adversarial gap tests for the goal endpoints and validation.

Independent of the implementer's tests in test_goals.py: these cover the value
BOUNDARIES (exactly-at-limit, leap year), the deliberate design choices the
implementer's happy paths don't lock (negative manual_balance, a float amount,
manual_balance of exactly 0), extra-field stripping, empty-string ids, and a real
GET-after-PUT round trip proving every numeric renders back as a JSON number and
the id is echoed. Reuses the `handler` fixture (conftest.py).
"""

import json
from decimal import Decimal


def _grow_body(**over):
    body = {
        "name": "Holiday fund", "icon": "palm", "direction": "grow",
        "target_amount": 5000, "target_date": "2026-12-01",
        "account_id": "up-spending",
    }
    body.update(over)
    return body


def _manual_paydown_body(**over):
    body = {
        "name": "Car loan", "icon": "car", "direction": "paydown",
        "target_amount": 0, "target_date": "2027-06-01",
        "manual_balance": 8400, "manual_as_of": "2026-07-01",
    }
    body.update(over)
    return body


def _put_event(goal_id="g1", body=None):
    return {
        "rawPath": f"/goals/{goal_id}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"id": goal_id},
        "body": json.dumps(_grow_body() if body is None else body),
        "isBase64Encoded": False,
    }


class FakeGoalsRepo:
    """Records calls; upsert echoes id like the real repo (no persistence)."""

    def __init__(self):
        self.upsert_calls = []

    def upsert_goal(self, goal_id, goal, start_candidate=None):
        self.upsert_calls.append((goal_id, goal))
        return {"id": goal_id, **goal, **(start_candidate or {})}


class FakeBalanceRepo:
    """Stand-in for AccountBalanceRepository (WHIT-252); no polled balances by default."""

    def list_balances(self, account_ids):
        return []


def _put(handler, body, goal_id="g1"):
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(goal_id=goal_id, body=body), repo, FakeBalanceRepo())
    return resp, repo


# --- target_amount ceiling boundary -----------------------------------------


def test_target_amount_exactly_at_ceiling_is_accepted(handler):
    # [G1] 1e9 is the max; `<= high` must let it through (guards a `<` regression).
    resp, repo = _put(handler, _grow_body(target_amount=1_000_000_000))
    assert resp["statusCode"] == 200, json.loads(resp["body"])
    assert repo.upsert_calls[0][1]["target_amount"] == Decimal("1000000000")


def test_target_amount_one_over_ceiling_is_rejected(handler):
    # [G2] just past the ceiling -> 400 (the implementer only tests 2e9).
    resp, repo = _put(handler, _grow_body(target_amount=1_000_000_001))
    assert resp["statusCode"] == 400
    assert repo.upsert_calls == []


def test_target_amount_float_is_accepted_and_stored_as_decimal_string(handler):
    # [G3] a fractional amount is valid and reaches boto3 as Decimal(str(v)), not a float.
    resp, repo = _put(handler, _grow_body(target_amount=5000.5))
    assert resp["statusCode"] == 200
    stored = repo.upsert_calls[0][1]["target_amount"]
    assert stored == Decimal("5000.5")
    assert isinstance(stored, Decimal)


# --- target_date calendar edges ---------------------------------------------


def test_target_date_leap_day_valid_year_accepted(handler):
    # [G4] 2028 is a leap year -> Feb 29 is a real date (regex+fromisoformat both pass).
    resp, _ = _put(handler, _grow_body(target_date="2028-02-29"))
    assert resp["statusCode"] == 200


def test_target_date_leap_day_non_leap_year_rejected(handler):
    # [G5] 2027 is NOT a leap year -> Feb 29 is not a real date; fromisoformat must catch it.
    resp, repo = _put(handler, _grow_body(target_date="2027-02-29"))
    assert resp["statusCode"] == 400
    assert repo.upsert_calls == []


# --- manual balance source edges --------------------------------------------


def test_manual_balance_exactly_zero_is_accepted(handler):
    # [G6] 0 must not read as "no manual source" (the guard uses `is not None`, not truthiness).
    resp, repo = _put(handler, _manual_paydown_body(manual_balance=0))
    assert resp["statusCode"] == 200, json.loads(resp["body"])
    assert repo.upsert_calls[0][1]["manual_balance"] == Decimal("0")


def test_manual_balance_negative_is_accepted_as_a_debt_snapshot(handler):
    # [G7] negative manual_balance is deliberately allowed (low=-1e9). Locks that design
    # choice: a `low=0` regression would redden here.
    resp, repo = _put(handler, _manual_paydown_body(manual_balance=-8400))
    assert resp["statusCode"] == 200, json.loads(resp["body"])
    assert repo.upsert_calls[0][1]["manual_balance"] == Decimal("-8400")


def test_manual_balance_below_negative_ceiling_rejected(handler):
    # [G8] magnitude is still bounded -> a huge negative is a 400.
    resp, repo = _put(handler, _manual_paydown_body(manual_balance=-2_000_000_000))
    assert resp["statusCode"] == 400
    assert repo.upsert_calls == []


# --- baseline edges ----------------------------------------------------------


def test_baseline_zero_is_accepted(handler):
    # [G9] baseline >= 0, so 0 is valid.
    resp, repo = _put(handler, _grow_body(baseline=0))
    assert resp["statusCode"] == 200
    assert repo.upsert_calls[0][1]["baseline"] == Decimal("0")


def test_baseline_negative_is_rejected(handler):
    # [G10] baseline must be >= 0; a negative is a 400 (implementer only tests non-numeric).
    resp, repo = _put(handler, _grow_body(baseline=-1))
    assert resp["statusCode"] == 400
    assert repo.upsert_calls == []


# --- shape hardening ---------------------------------------------------------


def test_unknown_extra_fields_are_dropped_not_stored(handler):
    # [G11] the goal is rebuilt field-by-field, so a stray client field never reaches storage.
    resp, repo = _put(handler, _grow_body(sneaky="DROP TABLE", version=99))
    assert resp["statusCode"] == 200
    _, goal = repo.upsert_calls[0]
    assert "sneaky" not in goal
    assert "version" not in goal


def test_direction_wrong_type_number_is_rejected(handler):
    # [G12] a numeric direction isn't in the enum set -> 400 (not a type crash).
    resp, repo = _put(handler, _grow_body(direction=1))
    assert resp["statusCode"] == 400
    assert repo.upsert_calls == []


def test_put_empty_string_id_is_404(handler):
    # [G13] "" is falsy -> 404 before the repo (an empty map key would 500 at DynamoDB).
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(goal_id="", body=_grow_body()), repo, FakeBalanceRepo())
    assert resp["statusCode"] == 404
    assert repo.upsert_calls == []


def test_delete_empty_string_id_is_404(handler):
    # [G14] DELETE mirrors PUT: an empty id is a 404, no repo call.
    calls = []

    class _Repo:
        def delete_goal(self, gid):
            calls.append(gid)

    resp = handler.delete_goal({"pathParameters": {"id": ""}}, _Repo())
    assert resp["statusCode"] == 404
    assert calls == []


# --- GET-after-PUT round trip through lambda_handler ------------------------


class PersistingGoalsRepo:
    """A repo that actually stores upserts, so GET reflects a prior PUT (real round trip)."""

    def __init__(self):
        self.store = {}

    def list_goals(self):
        return {k: dict(v) for k, v in self.store.items()}

    def upsert_goal(self, goal_id, goal, start_candidate=None):
        merged = {**goal, **(start_candidate or {})}
        self.store[goal_id] = dict(merged)
        return {"id": goal_id, **merged}

    def delete_goal(self, goal_id):
        self.store.pop(goal_id, None)


def test_get_after_put_round_trips_numbers_and_echoes_id(handler, monkeypatch):
    # [G15] PUT a manual paydown carrying BOTH baseline and manual_balance, then GET:
    # every numeric must come back as a JSON number (not a string), the id must be
    # echoed from the map key, and no unknown field survives.
    repo = PersistingGoalsRepo()
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", FakeBalanceRepo)

    body = _manual_paydown_body(manual_balance=8400.25, baseline=100, sneaky="x")
    put = handler.lambda_handler(_put_event(goal_id="car1", body=body), None)
    assert put["statusCode"] == 200

    got = handler.lambda_handler(
        {"rawPath": "/goals", "requestContext": {"http": {"method": "GET"}}}, None)
    assert got["statusCode"] == 200
    goals = json.loads(got["body"])
    saved = {g["id"]: g for g in goals}["car1"]

    assert saved["id"] == "car1"                          # id echoed from the map key
    for field in ("target_amount", "manual_balance", "baseline"):
        assert isinstance(saved[field], (int, float)), (field, saved[field])
    assert saved["manual_balance"] == 8400.25
    assert saved["baseline"] == 100
    assert "sneaky" not in saved                          # extra field never stored


# --- WHIT-252 QA GAP: the API response carries the start pair as JSON ----------


class PolledBalanceRepo:
    """AccountBalanceRepository stand-in that reports a live SIGNED balance for an account."""

    def __init__(self, rows):
        self._rows = rows

    def list_balances(self, account_ids):
        return [r for r in self._rows if r["account_id"] in account_ids]


def test_get_after_put_carries_start_pair_as_json(handler, monkeypatch):
    # [A9] End-to-end API shape: a SYNCED create with a live polled balance stamps a start;
    # a later GET must carry start_date as a JSON STRING and start_balance as a JSON NUMBER
    # (signed) -- i.e. the Decimal start_balance serialises to a number, not a string, and
    # the pair survives the store -> list -> encoder round trip through lambda_handler.
    from datetime import date

    repo = PersistingGoalsRepo()
    balances = PolledBalanceRepo([{"account_id": "up-spending", "amount": Decimal("-3200")}])
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: balances)
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(2026, 7, 11))

    put = handler.lambda_handler(_put_event(goal_id="hol1", body=_grow_body()), None)
    assert put["statusCode"] == 200

    got = handler.lambda_handler(
        {"rawPath": "/goals", "requestContext": {"http": {"method": "GET"}}}, None)
    assert got["statusCode"] == 200
    saved = {g["id"]: g for g in json.loads(got["body"])}["hol1"]

    assert saved["start_date"] == "2026-07-11"
    assert isinstance(saved["start_date"], str)
    # bool is a subclass of int -- exclude it so a stray True can't masquerade as a number.
    assert isinstance(saved["start_balance"], (int, float)) and not isinstance(saved["start_balance"], bool)
    assert saved["start_balance"] == -3200                 # live SIGNED balance, as a number
