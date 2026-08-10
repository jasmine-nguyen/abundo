"""Tests for the goal endpoints (GET /goals, PUT /goals/{id}, DELETE /goals/{id})
and their validation (WHIT-231).

Handler-level tests inject a FakeGoalsRepo directly (records calls); dispatch tests
drive the real lambda_handler with the repo monkeypatched, to prove the routes reach
the right function and that a repo VersionConflictError becomes the shared 409.

The `handler` fixture (conftest.py) makes lambda_api importable in isolation with
`shared/` on the path and boto3/botocore faked.
"""

import base64
import json
from datetime import date
from decimal import Decimal


# --- handler-level fake ------------------------------------------------------


class FakeGoalsRepo:
    """Handler-level stand-in for GoalsRepository (records calls)."""

    def __init__(self, goals=None, conflict_exc=None):
        self._goals = goals or {}          # {id: goal object}
        self._conflict_exc = conflict_exc
        self.upsert_calls = []
        self.start_candidates = []         # WHIT-252: the start passed per upsert
        self.delete_calls = []
        self.list_calls = 0

    def list_goals(self):
        self.list_calls += 1
        return {k: dict(v) for k, v in self._goals.items()}

    def upsert_goal(self, goal_id, goal, start_candidate=None):
        self.upsert_calls.append((goal_id, goal))
        self.start_candidates.append(start_candidate)
        if self._conflict_exc is not None:
            raise self._conflict_exc("boom")
        # Mimic a CREATE: the real repo carries an existing start forward, but a fresh Fake
        # has none, so it stamps the candidate — enough for handler tests to see the start
        # in the response. (Preserve-on-replace is covered in test_repository_goals.)
        return {"id": goal_id, **goal, **(start_candidate or {})}

    def delete_goal(self, goal_id):
        self.delete_calls.append(goal_id)
        if self._conflict_exc is not None:
            raise self._conflict_exc("boom")


class FakeBalanceRepo:
    """Handler-level stand-in for AccountBalanceRepository (WHIT-252). `rows` is the list
    of stored balances; list_balances filters to the requested ids (empty = not polled)."""

    def __init__(self, rows=None):
        self._rows = rows or []            # [{"account_id": ..., "amount": Decimal}]

    def list_balances(self, account_ids):
        return [r for r in self._rows if r["account_id"] in account_ids]


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


def _put_event(goal_id="g1", body=None, raw=None, is_b64=False):
    if raw is None:
        raw = json.dumps(_grow_body() if body is None else body)
    return {
        "rawPath": f"/goals/{goal_id}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"id": goal_id},
        "body": raw,
        "isBase64Encoded": is_b64,
    }


# --- PUT happy paths ---------------------------------------------------------


def test_upsert_grow_with_account_success(handler):
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(), repo, FakeBalanceRepo())

    assert resp["statusCode"] == 200
    saved = json.loads(resp["body"])
    assert saved["id"] == "g1"
    assert saved["direction"] == "grow"
    assert saved["target_amount"] == 5000            # rendered as a JSON number, not a string
    assert saved["account_id"] == "up-spending"
    assert "manual_balance" not in saved
    # Stored as Decimals (no float reaches boto3).
    goal_id, goal = repo.upsert_calls[0]
    assert goal_id == "g1"
    assert goal["target_amount"] == Decimal("5000")


def test_upsert_paydown_manual_success(handler):
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(body=_manual_paydown_body()), repo, FakeBalanceRepo())

    assert resp["statusCode"] == 200
    saved = json.loads(resp["body"])
    assert saved["direction"] == "paydown"
    assert saved["target_amount"] == 0               # paydown target of 0 = "pay it off"
    assert saved["manual_balance"] == 8400
    assert saved["manual_as_of"] == "2026-07-01"
    assert "account_id" not in saved
    _, goal = repo.upsert_calls[0]
    assert goal["manual_balance"] == Decimal("8400")


def test_upsert_defaults_missing_icon(handler):
    repo = FakeGoalsRepo()
    body = _grow_body()
    del body["icon"]
    resp = handler.upsert_goal(_put_event(body=body), repo, FakeBalanceRepo())

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["icon"] == "tag"   # DEFAULT_CATEGORY_ICON


def test_upsert_optional_baseline_stored_as_number(handler):
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(body=_grow_body(baseline=1000)), repo, FakeBalanceRepo())

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["baseline"] == 1000
    _, goal = repo.upsert_calls[0]
    assert goal["baseline"] == Decimal("1000")


def test_upsert_base64_body_decodes(handler):
    repo = FakeGoalsRepo()
    raw = base64.b64encode(json.dumps(_grow_body()).encode()).decode()
    resp = handler.upsert_goal(_put_event(raw=raw, is_b64=True), repo, FakeBalanceRepo())

    assert resp["statusCode"] == 200
    assert repo.upsert_calls[0][0] == "g1"


# --- WHIT-252: immutable goal start stamped on create ------------------------


def _pin_today(handler, monkeypatch, iso="2026-07-11"):
    y, m, d = map(int, iso.split("-"))
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(y, m, d))


def test_manual_create_stamps_start_from_entered_balance(handler, monkeypatch):
    _pin_today(handler, monkeypatch, "2026-07-11")
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(body=_manual_paydown_body()), repo, FakeBalanceRepo())

    saved = json.loads(resp["body"])
    assert saved["start_date"] == "2026-07-11"
    assert saved["start_balance"] == 8400            # == the entered manual_balance
    # The candidate handed to the repo carries the pair as Decimals.
    candidate = repo.start_candidates[0]
    assert candidate == {"start_date": "2026-07-11", "start_balance": Decimal("8400")}


def test_synced_create_stamps_start_from_live_signed_balance(handler, monkeypatch):
    _pin_today(handler, monkeypatch, "2026-07-11")
    repo = FakeGoalsRepo()
    # _grow_body is synced to "up-spending"; a debt card would be negative, so store SIGNED.
    balances = FakeBalanceRepo([{"account_id": "up-spending", "amount": Decimal("-3200")}])
    resp = handler.upsert_goal(_put_event(), repo, balances)

    saved = json.loads(resp["body"])
    assert saved["start_date"] == "2026-07-11"
    assert saved["start_balance"] == -3200           # the live SIGNED amount
    assert repo.start_candidates[0]["start_balance"] == Decimal("-3200")


def test_synced_create_before_first_poll_stamps_no_start(handler, monkeypatch):
    _pin_today(handler, monkeypatch, "2026-07-11")
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(), repo, FakeBalanceRepo())  # no balance polled yet

    saved = json.loads(resp["body"])
    assert "start_date" not in saved
    assert "start_balance" not in saved
    assert repo.start_candidates[0] == {}            # nothing to stamp; a later poll fills it


def test_client_sent_start_fields_are_ignored(handler, monkeypatch):
    _pin_today(handler, monkeypatch, "2026-07-11")
    repo = FakeGoalsRepo()
    body = _manual_paydown_body(start_date="1999-01-01", start_balance=999999)
    resp = handler.upsert_goal(_put_event(body=body), repo, FakeBalanceRepo())

    saved = json.loads(resp["body"])
    assert saved["start_date"] == "2026-07-11"        # server clock wins, not the client's
    assert saved["start_balance"] == 8400             # from manual_balance, not 999999
    # The validated goal dict never carried the client's start — immutability at the source.
    _, goal = repo.upsert_calls[0]
    assert "start_date" not in goal and "start_balance" not in goal


# --- PUT validation 400s -----------------------------------------------------


def _assert_400(handler, body):
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(body=body), repo, FakeBalanceRepo())
    assert resp["statusCode"] == 400, json.loads(resp["body"])
    assert repo.upsert_calls == []                   # never reached the repo
    return json.loads(resp["body"])


def test_400_missing_name(handler):
    _assert_400(handler, _grow_body(name="  "))


def test_400_bad_direction(handler):
    _assert_400(handler, _grow_body(direction="sideways"))


def test_400_target_amount_not_a_number(handler):
    _assert_400(handler, _grow_body(target_amount="lots"))


def test_400_target_amount_bool(handler):
    _assert_400(handler, _grow_body(target_amount=True))


def test_400_target_amount_negative(handler):
    _assert_400(handler, _grow_body(target_amount=-5))


def test_400_target_amount_too_large(handler):
    _assert_400(handler, _grow_body(target_amount=2_000_000_000))


def test_400_grow_target_amount_zero(handler):
    # A savings goal of 0 is meaningless (paydown 0 is allowed — tested above).
    _assert_400(handler, _grow_body(target_amount=0))


def test_400_target_date_not_iso(handler):
    _assert_400(handler, _grow_body(target_date="Dec 2026"))


def test_400_target_date_not_a_real_calendar_date(handler):
    _assert_400(handler, _grow_body(target_date="2026-02-30"))


def test_400_both_balance_sources(handler):
    _assert_400(handler, _grow_body(manual_balance=100, manual_as_of="2026-07-01"))


def test_400_no_balance_source(handler):
    body = _grow_body()
    del body["account_id"]
    _assert_400(handler, body)


def test_400_partial_manual_balance_only(handler):
    body = _grow_body()
    del body["account_id"]
    body["manual_balance"] = 100
    _assert_400(handler, body)


def test_400_partial_manual_as_of_only(handler):
    body = _grow_body()
    del body["account_id"]
    body["manual_as_of"] = "2026-07-01"
    _assert_400(handler, body)


def test_400_unknown_account_id(handler):
    _assert_400(handler, _grow_body(account_id="not-a-real-account"))


def test_400_manual_as_of_not_a_real_date(handler):
    _assert_400(handler, _manual_paydown_body(manual_as_of="2026-13-01"))


def test_400_baseline_not_a_number(handler):
    _assert_400(handler, _grow_body(baseline="lots"))


def test_400_invalid_json_body(handler):
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(raw="not json"), repo, FakeBalanceRepo())
    assert resp["statusCode"] == 400
    assert repo.upsert_calls == []


def test_upsert_missing_id_404(handler):
    repo = FakeGoalsRepo()
    event = _put_event()
    event["pathParameters"] = {}                     # no id
    resp = handler.upsert_goal(event, repo, FakeBalanceRepo())
    assert resp["statusCode"] == 404
    assert repo.upsert_calls == []


# --- GET ---------------------------------------------------------------------


def test_list_goals_returns_list_with_ids(handler):
    repo = FakeGoalsRepo(goals={
        "g1": {"name": "Holiday", "direction": "grow"},
        "g2": {"name": "Car", "direction": "paydown"},
    })
    result = handler.list_goals(repo)

    assert isinstance(result, list)
    by_id = {g["id"]: g for g in result}
    assert by_id["g1"]["name"] == "Holiday"
    assert by_id["g2"]["direction"] == "paydown"


def test_list_goals_empty(handler):
    assert handler.list_goals(FakeGoalsRepo()) == []


# --- DELETE ------------------------------------------------------------------


def test_delete_goal_success(handler):
    repo = FakeGoalsRepo(goals={"g1": {"name": "Holiday"}})
    resp = handler.delete_goal(
        {"pathParameters": {"id": "g1"}, "requestContext": {"http": {"method": "DELETE"}}}, repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "g1"}
    assert repo.delete_calls == ["g1"]


def test_delete_goal_idempotent_when_absent(handler):
    repo = FakeGoalsRepo()                            # no such goal; repo no-ops
    resp = handler.delete_goal({"pathParameters": {"id": "ghost"}}, repo)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "ghost"}


def test_delete_goal_missing_id_404(handler):
    resp = handler.delete_goal({"pathParameters": {}}, FakeGoalsRepo())
    assert resp["statusCode"] == 404


# --- dispatch through lambda_handler ----------------------------------------


def test_get_goals_dispatch(handler, monkeypatch):
    repo = FakeGoalsRepo(goals={"g1": {"name": "Holiday", "direction": "grow"}})
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)

    resp = handler.lambda_handler(
        {"rawPath": "/goals", "requestContext": {"http": {"method": "GET"}}}, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])[0]["id"] == "g1"
    assert repo.list_calls == 1


def test_put_goal_dispatch(handler, monkeypatch):
    repo = FakeGoalsRepo()
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: FakeBalanceRepo())

    resp = handler.lambda_handler(_put_event(), None)

    assert resp["statusCode"] == 200
    assert repo.upsert_calls[0][0] == "g1"


def test_delete_goal_dispatch(handler, monkeypatch):
    repo = FakeGoalsRepo(goals={"g1": {"name": "Holiday"}})
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)

    resp = handler.lambda_handler(
        {"rawPath": "/goals/g1", "pathParameters": {"id": "g1"},
         "requestContext": {"http": {"method": "DELETE"}}}, None)

    assert resp["statusCode"] == 200
    assert repo.delete_calls == ["g1"]


def test_put_goal_conflict_returns_409(handler, monkeypatch):
    # A repo that exhausts its retry budget raises VersionConflictError; the shared
    # dispatch wrapper maps it to 409 — proves the goals arms sit inside that try.
    repo = FakeGoalsRepo(conflict_exc=handler.VersionConflictError)
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: FakeBalanceRepo())

    resp = handler.lambda_handler(_put_event(), None)
    assert resp["statusCode"] == 409


def test_unknown_goals_method_falls_through_404(handler, monkeypatch):
    monkeypatch.setattr(handler, "GoalsRepository", lambda: FakeGoalsRepo())

    resp = handler.lambda_handler(
        {"rawPath": "/goals", "requestContext": {"http": {"method": "POST"}}}, None)
    assert resp["statusCode"] == 404


# === WHIT-231 adversarial gap tests (folded from test_goals_gaps.py) — value boundaries,
# leap-year dates, signed/zero manual balances, extra-field stripping, empty-string ids, and
# GET-after-PUT round trips. The drifted FakeGoalsRepo/FakeBalanceRepo/_put_event are kept
# renamed with a _gaps suffix (they are stripped variants of the ones above). ===============


def _put_event_gaps(goal_id="g1", body=None):
    return {
        "rawPath": f"/goals/{goal_id}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"id": goal_id},
        "body": json.dumps(_grow_body() if body is None else body),
        "isBase64Encoded": False,
    }


class FakeGoalsRepo_gaps:
    """Records calls; upsert echoes id like the real repo (no persistence)."""

    def __init__(self):
        self.upsert_calls = []

    def upsert_goal(self, goal_id, goal, start_candidate=None):
        self.upsert_calls.append((goal_id, goal))
        return {"id": goal_id, **goal, **(start_candidate or {})}


class FakeBalanceRepo_gaps:
    """Stand-in for AccountBalanceRepository (WHIT-252); no polled balances by default."""

    def list_balances(self, account_ids):
        return []


def _put(handler, body, goal_id="g1"):
    repo = FakeGoalsRepo_gaps()
    resp = handler.upsert_goal(_put_event_gaps(goal_id=goal_id, body=body), repo, FakeBalanceRepo_gaps())
    return resp, repo


# --- target_amount ceiling boundary -----------------------------------------


def test_the_goal_amount_cap_value_is_pinned(handler):
    """[G1] and [G2] now derive from the cap, and it has no client twin to check it
    against, so nothing else asserts its VALUE — lowering it to 1_000_000 by accident
    would leave the suite green while every goal over $1M silently 400'd. Changing the
    cap should cost exactly one honest edit, here.

    If you are deliberately changing the cap, this is the ONE test that should go red."""
    cap = handler._GOAL_AMOUNT_MAX
    assert isinstance(cap, int) and cap == 1_000_000_000, (
        f"the goal amount cap is now {cap!r}, not 1_000_000_000 — if you meant to change it, "
        "update this pin too; if you didn't, this is the typo it exists to catch. It must stay "
        "an int: the 400 message quotes the cap, and a float would read '1000000000.0'."
    )


def test_target_amount_exactly_at_ceiling_is_accepted(handler):
    # [G1] the cap itself; `<= high` must let it through (guards a `<` regression).
    # Read from the handler (WHIT-393) so a cap change needs no edit here.
    cap = handler._GOAL_AMOUNT_MAX
    resp, repo = _put(handler, _grow_body(target_amount=cap))
    assert resp["statusCode"] == 200, json.loads(resp["body"])
    assert repo.upsert_calls[0][1]["target_amount"] == Decimal(str(cap))


def test_target_amount_one_over_ceiling_is_rejected(handler):
    # [G2] just past the ceiling -> 400 (the implementer only tests 2e9).
    resp, repo = _put(handler, _grow_body(target_amount=handler._GOAL_AMOUNT_MAX + 1))
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
    repo = FakeGoalsRepo_gaps()
    resp = handler.upsert_goal(_put_event_gaps(goal_id="", body=_grow_body()), repo, FakeBalanceRepo_gaps())
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
    monkeypatch.setattr(handler, "AccountBalanceRepository", FakeBalanceRepo_gaps)

    body = _manual_paydown_body(manual_balance=8400.25, baseline=100, sneaky="x")
    put = handler.lambda_handler(_put_event_gaps(goal_id="car1", body=body), None)
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
    repo = PersistingGoalsRepo()
    balances = PolledBalanceRepo([{"account_id": "up-spending", "amount": Decimal("-3200")}])
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: balances)
    monkeypatch.setattr(handler, "_melbourne_today", lambda: date(2026, 7, 11))

    put = handler.lambda_handler(_put_event_gaps(goal_id="hol1", body=_grow_body()), None)
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
