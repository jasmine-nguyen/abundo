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

    def list_goals(self):
        return {}  # non-persisting: no prior goal → no crossing (WHIT-479)

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
        existing = self.store.get(goal_id)
        # Mirror the real repo's WHIT-476 carry-forward: an omitted ladder keeps the stored
        # one, an explicit list replaces, an explicit empty list clears.
        if "checkpoints" in goal:
            ladder = goal["checkpoints"]
        elif existing:
            ladder = existing.get("checkpoints")
        else:
            ladder = None
        merged = {**goal, **(start_candidate or {})}
        merged.pop("checkpoints", None)
        if ladder:
            merged["checkpoints"] = ladder
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


# --- WHIT-476: the optional checkpoint ladder --------------------------------
# A goal may carry `checkpoints` -- {id, label, amount} steps on the way to target_amount,
# ordered in the goal's OWN direction. The id is permanent and kept as sent -- the client
# normally mints it, the server mints only for a row that arrives without -- because the
# once-ever celebration (a later slice) keys on it. Absent stays absent, so goals saved
# before this feature are stored byte-identical.


def _cp(label, amount, **over):
    cp = {"label": label, "amount": amount}
    cp.update(over)
    return cp


def _saved_goal(handler, body):
    """PUT the body, assert 200, return the goal dict handed to the repo."""
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(body=body), repo, FakeBalanceRepo())
    assert resp["statusCode"] == 200, json.loads(resp["body"])
    return repo.upsert_calls[0][1]


def test_grow_checkpoints_saved_in_order_with_minted_ids(handler):
    goal = _saved_goal(handler, _grow_body(
        checkpoints=[_cp("First £1k", 1000), _cp("Halfway", 2500), _cp("Nearly", 4000)]))

    assert [c["label"] for c in goal["checkpoints"]] == ["First £1k", "Halfway", "Nearly"]
    # Stored as Decimals (no float reaches boto3), like every other goal number.
    assert [c["amount"] for c in goal["checkpoints"]] == [Decimal("1000"), Decimal("2500"), Decimal("4000")]
    ids = [c["id"] for c in goal["checkpoints"]]
    assert all(isinstance(i, str) and i for i in ids)
    assert len(set(ids)) == 3                        # minted ids are unique


def test_paydown_checkpoints_descend_toward_the_target(handler):
    goal = _saved_goal(handler, _manual_paydown_body(
        checkpoints=[_cp("Under 6k", 6000), _cp("Under 3k", 3000), _cp("Nearly clear", 500)]))

    assert [c["amount"] for c in goal["checkpoints"]] == [Decimal("6000"), Decimal("3000"), Decimal("500")]


def test_a_single_checkpoint_is_fine(handler):
    goal = _saved_goal(handler, _grow_body(checkpoints=[_cp("Halfway", 2500)]))
    assert len(goal["checkpoints"]) == 1


def test_omitted_checkpoints_store_no_key_at_all(handler):
    # Existing-goal compatibility: a goal saved without a ladder is stored exactly as before.
    goal = _saved_goal(handler, _grow_body())
    assert "checkpoints" not in goal


def test_empty_checkpoint_list_is_the_explicit_clear_signal(handler):
    # WHIT-476 option B: an omitted field keeps the stored ladder, so [] is the ONLY way to
    # ask for it gone. The handler keeps the key (as []) so the repo can tell "clear me" from
    # "I didn't mention it".
    goal = _saved_goal(handler, _grow_body(checkpoints=[]))
    assert goal["checkpoints"] == []


def test_client_supplied_id_is_kept_and_trimmed(handler):
    goal = _saved_goal(handler, _grow_body(
        checkpoints=[_cp("Kept", 1000, id="  cp-1  "), _cp("Minted", 2000)]))

    assert goal["checkpoints"][0]["id"] == "cp-1"     # trimmed, not re-minted
    assert goal["checkpoints"][1]["id"] != "cp-1"     # the id-less row got its own


def test_label_is_trimmed_and_max_length_is_allowed(handler):
    goal = _saved_goal(handler, _grow_body(
        checkpoints=[_cp("  Trim me  ", 1000), _cp("x" * 100, 2000)]))

    assert goal["checkpoints"][0]["label"] == "Trim me"
    assert len(goal["checkpoints"][1]["label"]) == 100


def test_exactly_the_max_number_of_checkpoints_is_allowed(handler):
    ladder = [_cp(f"Step {n}", n * 100) for n in range(1, 21)]      # 20 rungs, all under 5000
    goal = _saved_goal(handler, _grow_body(checkpoints=ladder))
    assert len(goal["checkpoints"]) == 20


# --- WHIT-476 rejections -----------------------------------------------------


def test_400_checkpoints_not_a_list(handler):
    # A scalar, not a dict: iterating a dict yields its keys, which the per-item object check
    # would reject with a DIFFERENT 400 -- so a dict here can't tell the two rules apart. A
    # scalar reaches len() instead, which without this rule is a 500, and the message pins
    # which rule fired.
    body = _assert_400(handler, _grow_body(checkpoints=5))
    assert body["error"] == "checkpoints must be a list"


def test_400_checkpoint_not_an_object(handler):
    _assert_400(handler, _grow_body(checkpoints=["halfway"]))


def test_400_checkpoint_blank_label(handler):
    _assert_400(handler, _grow_body(checkpoints=[_cp("   ", 1000)]))


def test_400_checkpoint_label_too_long(handler):
    _assert_400(handler, _grow_body(checkpoints=[_cp("x" * 101, 1000)]))


def test_400_checkpoint_amount_not_a_number(handler):
    _assert_400(handler, _grow_body(checkpoints=[_cp("Some", "lots")]))


def test_400_checkpoint_amount_bool(handler):
    # bool is an int subclass -- True must not sneak through as 1.
    _assert_400(handler, _grow_body(checkpoints=[_cp("Some", True)]))


def test_400_checkpoint_amount_negative(handler):
    _assert_400(handler, _grow_body(checkpoints=[_cp("Some", -100)]))


def test_400_checkpoint_amount_not_finite(handler):
    repo = FakeGoalsRepo()
    raw = '{"name":"H","icon":"palm","direction":"grow","target_amount":5000,' \
          '"target_date":"2026-12-01","account_id":"up-spending",' \
          '"checkpoints":[{"label":"Some","amount":NaN}]}'
    resp = handler.upsert_goal(_put_event(raw=raw), repo, FakeBalanceRepo())
    assert resp["statusCode"] == 400
    assert repo.upsert_calls == []


def test_400_grow_checkpoint_of_zero(handler):
    # 0 isn't a step toward a positive target.
    _assert_400(handler, _grow_body(checkpoints=[_cp("Nothing", 0)]))


def test_400_grow_checkpoint_at_or_past_the_target(handler):
    _assert_400(handler, _grow_body(checkpoints=[_cp("The goal itself", 5000)]))
    _assert_400(handler, _grow_body(checkpoints=[_cp("Past it", 5001)]))


def test_400_paydown_checkpoint_at_or_below_the_target(handler):
    # target_amount is 0 here, so a 0 rung IS the goal, not a step toward it.
    _assert_400(handler, _manual_paydown_body(checkpoints=[_cp("Cleared", 0)]))


def test_400_grow_checkpoints_not_increasing(handler):
    _assert_400(handler, _grow_body(checkpoints=[_cp("A", 2000), _cp("B", 1000)]))
    _assert_400(handler, _grow_body(checkpoints=[_cp("A", 2000), _cp("B", 2000)]))


def test_400_paydown_checkpoints_not_decreasing(handler):
    _assert_400(handler, _manual_paydown_body(checkpoints=[_cp("A", 3000), _cp("B", 6000)]))
    _assert_400(handler, _manual_paydown_body(checkpoints=[_cp("A", 3000), _cp("B", 3000)]))


def test_400_duplicate_checkpoint_ids(handler):
    _assert_400(handler, _grow_body(
        checkpoints=[_cp("A", 1000, id="dup"), _cp("B", 2000, id="dup")]))


def test_400_duplicate_ids_that_differ_only_by_whitespace(handler):
    _assert_400(handler, _grow_body(
        checkpoints=[_cp("A", 1000, id="dup"), _cp("B", 2000, id="  dup  ")]))


def test_400_blank_or_non_string_checkpoint_id(handler):
    # A supplied-but-empty id is a bug, not a request to mint one.
    _assert_400(handler, _grow_body(checkpoints=[_cp("A", 1000, id="   ")]))
    _assert_400(handler, _grow_body(checkpoints=[_cp("A", 1000, id=7)]))


def test_400_too_many_checkpoints(handler):
    ladder = [_cp(f"Step {n}", n * 100) for n in range(1, 22)]      # 21 rungs
    _assert_400(handler, _grow_body(checkpoints=ladder))


# --- WHIT-476 QA GAPS: round trip, replace semantics, precision, ordering depth ------
# The implementer's block above locks the validator's own rules (shape, bounds, ordering
# of a 2-rung ladder, ids). These cover what it does NOT: the ladder surviving the real
# store -> list -> JSON encode path, the whole-object REPLACE semantics an edit inherits,
# Decimal precision, unicode, and the deliberate slice-4 deferral.


def _ladder_round_trip(handler, monkeypatch, goal_id, body):
    """PUT `body` through the real lambda_handler into a persisting repo, then GET, and
    return the goal as the CLIENT sees it (post JSON encode)."""
    repo = PersistingGoalsRepo()
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", FakeBalanceRepo_gaps)
    put = handler.lambda_handler(_put_event_gaps(goal_id=goal_id, body=body), None)
    assert put["statusCode"] == 200, json.loads(put["body"])
    got = handler.lambda_handler(
        {"rawPath": "/goals", "requestContext": {"http": {"method": "GET"}}}, None)
    assert got["statusCode"] == 200
    return {g["id"]: g for g in json.loads(got["body"])}[goal_id]


def test_checkpoint_ladder_survives_the_put_get_round_trip_as_json(handler, monkeypatch):
    # [A1] The ladder is a list of nested Decimals -- the one shape nothing else on a goal
    # has. Prove it survives store -> list_goals -> DecimalEncoder: order kept, amounts are
    # JSON NUMBERS (a Decimal that leaked as a string would fail the client's `amount: number`),
    # ids are non-empty strings, and no extra key rides along.
    saved = _ladder_round_trip(handler, monkeypatch, "hol1", _grow_body(
        checkpoints=[_cp("First $1k", 1000), _cp("Halfway", 2500.5), _cp("Nearly", 4000)]))

    ladder = saved["checkpoints"]
    assert [c["label"] for c in ladder] == ["First $1k", "Halfway", "Nearly"]
    for c in ladder:
        assert set(c) == {"id", "label", "amount"}
        assert isinstance(c["amount"], (int, float)) and not isinstance(c["amount"], bool)
        assert isinstance(c["id"], str) and c["id"].strip()
    assert [c["amount"] for c in ladder] == [1000, 2500.5, 4000]   # cents intact, order intact
    assert len({c["id"] for c in ladder}) == 3


def test_a_goal_without_checkpoints_reads_back_with_no_checkpoints_key(handler, monkeypatch):
    # [A2] Existing goals must be untouched by this slice: no backfill, no `checkpoints: null`
    # (the client's field is OPTIONAL, and a null would make "has a ladder" ambiguous).
    saved = _ladder_round_trip(handler, monkeypatch, "old1", _grow_body())
    assert "checkpoints" not in saved


def test_an_edit_that_omits_checkpoints_keeps_the_saved_ladder(handler, monkeypatch):
    # [A3] WHIT-476 option B. A save that does NOT mention checkpoints keeps the stored ladder,
    # so a writer that doesn't know about them (an old app build, a new code path) can't wipe
    # them. Renaming a goal must leave its ladder intact.
    repo = PersistingGoalsRepo()
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", FakeBalanceRepo_gaps)

    handler.lambda_handler(_put_event_gaps(
        goal_id="hol1", body=_grow_body(checkpoints=[_cp("Halfway", 2500)])), None)

    second = handler.lambda_handler(_put_event_gaps(
        goal_id="hol1", body=_grow_body(name="Bigger holiday")), None)   # no checkpoints sent
    assert second["statusCode"] == 200
    ladder = repo.store["hol1"]["checkpoints"]
    assert [c["label"] for c in ladder] == ["Halfway"]        # kept, not wiped
    assert json.loads(second["body"])["name"] == "Bigger holiday"


def test_an_explicit_empty_list_clears_the_saved_ladder(handler, monkeypatch):
    # [A3b] The one deliberate way to remove a ladder: send [] (the edit UI does this when the
    # user deletes every rung). Unlike an omission, [] is honoured -- the stored ladder goes.
    repo = PersistingGoalsRepo()
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", FakeBalanceRepo_gaps)

    handler.lambda_handler(_put_event_gaps(
        goal_id="hol1", body=_grow_body(checkpoints=[_cp("Halfway", 2500)])), None)

    handler.lambda_handler(_put_event_gaps(
        goal_id="hol1", body=_grow_body(checkpoints=[])), None)
    assert "checkpoints" not in repo.store["hol1"]            # cleared, stored as no key


def test_explicit_null_checkpoints_is_accepted_and_stores_no_key(handler):
    # [A4] A client that always sends the field will send `null` for "no ladder" (the
    # GoalRecord type allows `checkpoints?: GoalCheckpoint[] | null`). Null must mean absent,
    # not a 400 and not a stored null.
    goal = _saved_goal(handler, _grow_body(checkpoints=None))
    assert "checkpoints" not in goal


def test_checkpoint_amount_keeps_its_cents_exactly(handler):
    # [A5] Every goal number goes through Decimal(str(x)) so no binary float reaches boto3.
    # Decimal(1234.56) would store 1234.5599999999999454...; assert the exact string.
    goal = _saved_goal(handler, _grow_body(checkpoints=[_cp("Cents", 1234.56)]))
    amount = goal["checkpoints"][0]["amount"]
    assert isinstance(amount, Decimal)
    assert str(amount) == "1234.56"


def test_unknown_checkpoint_fields_are_stripped(handler):
    # [A6] The validator rebuilds each rung from scratch, so a client-invented field can't be
    # stored. Matters most for `reached`/`celebrated`: the once-ever marker is SERVER-owned in
    # a later slice, and a client-supplied one would let the phone mark its own celebration done.
    goal = _saved_goal(handler, _grow_body(
        checkpoints=[_cp("Halfway", 2500, reached=True, celebrated_at="2026-01-01", sneaky="x")]))
    assert set(goal["checkpoints"][0]) == {"id", "label", "amount"}


def test_explicit_null_checkpoint_id_is_minted_not_rejected(handler):
    # [A7] JSON has no "absent" for a client that always serialises the key: `"id": null` must
    # mint (like an omitted id), while a blank STRING id stays a 400 (locked above).
    goal = _saved_goal(handler, _grow_body(checkpoints=[_cp("Halfway", 2500, id=None)]))
    minted = goal["checkpoints"][0]["id"]
    assert isinstance(minted, str) and minted.strip()


def test_unicode_and_emoji_labels_survive_intact(handler, monkeypatch):
    # [A8] Labels are free text. An emoji/accented label must round-trip byte-for-byte through
    # the JSON body and the response encoder -- not be mangled or rejected by the length rule.
    saved = _ladder_round_trip(handler, monkeypatch, "hol1", _grow_body(
        checkpoints=[_cp("Halfway \U0001F389", 1000), _cp("Caf\u00e9 fund \u2014 \u00be there", 2500)]))
    assert [c["label"] for c in saved["checkpoints"]] == ["Halfway \U0001F389", "Caf\u00e9 fund \u2014 \u00be there"]


def test_label_length_counts_characters_not_bytes(handler):
    # [A9] 100 emoji is 100 CHARACTERS but 400 UTF-8 bytes. The cap is a character cap, so
    # the 100 pass and the 101st fails -- a byte-based cap would reject both.
    goal = _saved_goal(handler, _grow_body(checkpoints=[_cp("\U0001F389" * 100, 1000)]))
    assert len(goal["checkpoints"][0]["label"]) == 100
    _assert_400(handler, _grow_body(checkpoints=[_cp("\U0001F389" * 101, 1000)]))


def test_a_middle_rung_out_of_order_in_a_full_ladder_is_rejected(handler):
    # [A10] The ordering rule is checked on every ADJACENT pair, not just the first two and not
    # just first-vs-last: a 20-rung ladder that dips at rung 10 and recovers must still 400.
    ladder = [_cp(f"Step {n}", n * 100) for n in range(1, 21)]
    ladder[9]["amount"] = 50                       # rung 10 dips below rung 9, then rung 11 recovers
    _assert_400(handler, _grow_body(checkpoints=ladder))


def test_a_middle_rung_out_of_order_in_a_full_paydown_ladder_is_rejected(handler):
    ladder = [_cp(f"Step {n}", 10000 - n * 100) for n in range(1, 21)]
    ladder[9]["amount"] = 9999                     # rung 10 jumps back up
    _assert_400(handler, _manual_paydown_body(checkpoints=ladder))


def test_a_tiny_grow_target_leaves_only_fractional_room(handler):
    # [A11] target_amount 1: the open interval (0, 1) has no whole dollar in it, so the only
    # legal rung is fractional. Proves the bound is strict-open on BOTH ends, not rounded.
    _assert_400(handler, _grow_body(target_amount=1, checkpoints=[_cp("At the target", 1)]))
    goal = _saved_goal(handler, _grow_body(target_amount=1, checkpoints=[_cp("Halfway", 0.5)]))
    assert goal["checkpoints"][0]["amount"] == Decimal("0.5")


def test_checkpoints_below_the_baseline_are_accepted_today(handler):
    # [A12] TRIPWIRE for a DELIBERATE deferral. Nothing bounds a rung against the goal's
    # baseline/start yet (slice 4 owns "can it still fire?"), so a grow goal that counts from
    # $3,000 can store a $1,000 rung the balance has ALREADY passed -- it can never celebrate.
    # If you add that bound, this is the one test that should go red; update it honestly.
    goal = _saved_goal(handler, _grow_body(
        baseline=3000, checkpoints=[_cp("Already behind us", 1000), _cp("Real step", 4000)]))
    assert [c["amount"] for c in goal["checkpoints"]] == [Decimal("1000"), Decimal("4000")]


def test_the_checkpoint_caps_are_pinned(handler):
    """[A13] The count/label caps have no client twin, so nothing else asserts their VALUES:
    quietly lowering the max to 5 would leave every test above green while a 6-rung ladder
    400'd in the user's face. Changing a cap should cost exactly one honest edit, here.

    If you are deliberately changing a cap, this is the ONE test that should go red."""
    assert handler._GOAL_CHECKPOINT_MAX_COUNT == 20, "checkpoint count cap changed -- update this pin on purpose"
    assert handler._GOAL_CHECKPOINT_LABEL_MAX_LEN == 100, "checkpoint label cap changed -- update this pin on purpose"


# --- WHIT-479: a manual goal's saved balance crossing a checkpoint celebrates -----------------
# upsert_goal reads the OLD stored balance, saves, then fires the crossing check for MANUAL goals
# (synced goals cross on the daily poll). notify_goal_checkpoint_crossing is monkeypatched to a
# recorder — the crossing math is unit-tested in tests/shared/test_goal_checkpoints.py.

def _grow_manual_body(**over):
    body = {
        "name": "Holiday", "icon": "palm", "direction": "grow",
        "target_amount": 10000, "target_date": "2026-12-01",
        "manual_balance": 5000, "manual_as_of": "2026-07-01",
        "checkpoints": [{"label": "Halfway", "amount": 4000}],
    }
    body.update(over)
    return body


_MANUAL_G1 = {
    "id": "g1", "name": "Holiday", "icon": "palm", "direction": "grow",
    "target_amount": 10000, "target_date": "2026-12-01",
    "manual_balance": Decimal("1000"), "manual_as_of": "2026-07-01",
    "checkpoints": [{"id": "cp1", "label": "Halfway", "amount": Decimal("4000")}],
}


def test_manual_save_fires_the_crossing_check_with_old_then_new(handler, monkeypatch):
    repo = FakeGoalsRepo(goals={"g1": dict(_MANUAL_G1)})
    seen = []
    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing",
                        lambda old, new, **kw: seen.append((old, new, kw["goal_id"], kw["synced"])) or 1)

    resp = handler.upsert_goal(_put_event(body=_grow_manual_body(manual_balance=5000)), repo, FakeBalanceRepo())
    assert resp["statusCode"] == 200
    assert seen == [(Decimal("1000"), Decimal("5000"), "g1", False)]   # old vs new, manual (synced=False)


def test_synced_save_does_NOT_fire_the_manual_crossing_check(handler, monkeypatch):
    # A synced goal (account_id) is the poller's job — the save path must not double-fire.
    repo = FakeGoalsRepo()
    seen = []
    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing", lambda *a, **k: seen.append(1) or 1)

    resp = handler.upsert_goal(_put_event(body=_grow_body(checkpoints=[_cp("Halfway", 4000)])), repo, FakeBalanceRepo())
    assert resp["statusCode"] == 200
    assert seen == []


def test_manual_save_push_failure_never_fails_the_save(handler, monkeypatch):
    repo = FakeGoalsRepo(goals={"g1": dict(_MANUAL_G1)})

    def boom(*a, **k):
        raise RuntimeError("expo down")

    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing", boom)
    resp = handler.upsert_goal(_put_event(body=_grow_manual_body(manual_balance=5000)), repo, FakeBalanceRepo())
    assert resp["statusCode"] == 200   # saved despite the push blowing up


def test_a_brand_new_manual_goal_first_save_passes_none_as_old(handler, monkeypatch):
    # No existing goal → old balance is None → the seed guard (no retroactive burst).
    repo = FakeGoalsRepo()  # empty
    seen = []
    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing",
                        lambda old, new, **kw: seen.append(old) or 0)

    resp = handler.upsert_goal(_put_event(body=_grow_manual_body(manual_balance=5000)), repo, FakeBalanceRepo())
    assert resp["statusCode"] == 200
    assert seen == [None]
