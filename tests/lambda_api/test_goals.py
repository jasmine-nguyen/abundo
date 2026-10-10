"""Tests for the goal endpoints (GET /goals, PUT /goals/{id}, DELETE /goals/{id})
and their validation (WHIT-231).

Handler-level tests inject a FakeGoalsRepo directly (records calls); dispatch tests
drive the real lambda_handler with the repo monkeypatched, to prove the routes reach
the right function and that a repo VersionConflictError becomes the shared 409.

The `handler` fixture (conftest.py) makes lambda_api importable in isolation with
`shared/` on the path and boto3/botocore faked.
"""

import json
from datetime import date
from decimal import Decimal

import pytest

from _api_event import api_event
from _dynamo_fakes import FakeTable
from _milestone_fakes import checkpoints_marked, goal_checkpoint_repo


# --- handler-level fake ------------------------------------------------------


class FakeGoalsRepo:
    """Handler-level stand-in for GoalsRepository (records calls)."""

    def __init__(self, goals=None, conflict_exc=None, saved_override=None):
        self._goals = goals or {}          # {id: goal object}
        self._conflict_exc = conflict_exc
        self._saved_override = saved_override   # the SAVED goal the real repo would return
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
        if self._saved_override is not None:
            return dict(self._saved_override)
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
    return api_event("PUT", f"/goals/{goal_id}", raw=raw, path_params={"id": goal_id}, is_base64=is_b64)


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


# --- WHIT-252: immutable goal start stamped on create ------------------------


def _pin_today(handler, monkeypatch, iso="2026-07-11"):
    y, m, d = map(int, iso.split("-"))
    monkeypatch.setattr(handler, "melbourne_today", lambda: date(y, m, d))


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


def _cp(label, amount, **over):
    cp = {"label": label, "amount": amount}
    cp.update(over)
    return cp


def _without(body, *keys):
    return {k: v for k, v in body.items() if k not in keys}


_NAN_CHECKPOINT = ('{"name":"H","icon":"palm","direction":"grow","target_amount":5000,'
                   '"target_date":"2026-12-01","account_id":"up-spending",'
                   '"checkpoints":[{"label":"Some","amount":NaN}]}')
_NAN_MANUAL_BALANCE = ('{"name":"Car loan","icon":"car","direction":"paydown","target_amount":0,'
                       '"target_date":"2027-06-01","manual_balance":NaN,"manual_as_of":"2026-07-01"}')
_FULL_GROW_LADDER_WITH_A_DIP = [_cp(f"Step {n}", 50 if n == 10 else n * 100) for n in range(1, 21)]


@pytest.mark.parametrize("body", [
    _grow_body(name="  "),
    _grow_body(direction="sideways"),
    _grow_body(target_amount="lots"),
    _grow_body(target_amount=True),
    _grow_body(target_amount=-5),
    _grow_body(target_amount=2_000_000_000),
    _grow_body(target_amount=0),                       # grow 0 is meaningless (paydown 0 is fine)
    _grow_body(target_date="Dec 2026"),
    _grow_body(target_date="2026-02-30"),
    _grow_body(manual_balance=100, manual_as_of="2026-07-01"),     # both balance sources
    _without(_grow_body(), "account_id"),                          # no balance source
    {**_without(_grow_body(), "account_id"), "manual_balance": 100},
    {**_without(_grow_body(), "account_id"), "manual_as_of": "2026-07-01"},
    _grow_body(account_id="not-a-real-account"),
    _manual_paydown_body(manual_as_of="2026-13-01"),
    _grow_body(baseline="lots"),
    _grow_body(baseline=-1),
    _manual_paydown_body(manual_balance=-8400),        # WHIT-483: a negative owed false-celebrates
    _manual_paydown_body(manual_balance=1_000_000_001),
    _NAN_MANUAL_BALANCE,
    "not json",
    _grow_body(checkpoints=5),
    _grow_body(checkpoints=["halfway"]),
    _grow_body(checkpoints=[_cp("   ", 1000)]),
    _grow_body(checkpoints=[_cp("x" * 101, 1000)]),
    _grow_body(checkpoints=[_cp("Some", "lots")]),
    _grow_body(checkpoints=[_cp("Some", True)]),
    _grow_body(checkpoints=[_cp("Some", -100)]),
    _NAN_CHECKPOINT,
    _grow_body(checkpoints=[_cp("Nothing", 0)]),
    _grow_body(checkpoints=[_cp("The goal itself", 5000)]),
    _grow_body(checkpoints=[_cp("Past it", 5001)]),
    _manual_paydown_body(checkpoints=[_cp("Cleared", 0)]),        # paydown target is 0
    _grow_body(checkpoints=[_cp("A", 2000), _cp("B", 1000)]),
    _grow_body(checkpoints=[_cp("A", 2000), _cp("B", 2000)]),
    _manual_paydown_body(checkpoints=[_cp("A", 3000), _cp("B", 6000)]),
    _manual_paydown_body(checkpoints=[_cp("A", 3000), _cp("B", 3000)]),
    _grow_body(checkpoints=[_cp("A", 1000, id="dup"), _cp("B", 2000, id="dup")]),
    _grow_body(checkpoints=[_cp("A", 1000, id="dup"), _cp("B", 2000, id="  dup  ")]),
    _grow_body(checkpoints=[_cp("A", 1000, id="   ")]),
    _grow_body(checkpoints=[_cp("A", 1000, id=7)]),
    _grow_body(checkpoints=[_cp(f"Step {n}", n * 100) for n in range(1, 22)]),    # 21 rungs
    _grow_body(checkpoints=_FULL_GROW_LADDER_WITH_A_DIP),          # every adjacent pair is checked
])
def test_upsert_rejects_bad_body(handler, body):
    repo = FakeGoalsRepo()
    if isinstance(body, str):
        event = _put_event(raw=body)
    else:
        event = _put_event(body=body)
    resp = handler.upsert_goal(event, repo, FakeBalanceRepo())
    assert resp["statusCode"] == 400, json.loads(resp["body"])
    assert repo.upsert_calls == []


def test_upsert_missing_id_404(handler):
    repo = FakeGoalsRepo()
    event = _put_event()
    event["pathParameters"] = {}                     # no id
    resp = handler.upsert_goal(event, repo, FakeBalanceRepo())
    assert resp["statusCode"] == 404
    assert repo.upsert_calls == []


# --- DELETE ------------------------------------------------------------------


def test_delete_goal_success(handler):
    repo = FakeGoalsRepo(goals={"g1": {"name": "Holiday"}})
    resp = handler.delete_goal(api_event("DELETE", "/goals/g1", path_params={"id": "g1"}), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "g1"}
    assert repo.delete_calls == ["g1"]


def test_delete_goal_missing_id_404(handler):
    resp = handler.delete_goal({"pathParameters": {}}, FakeGoalsRepo())
    assert resp["statusCode"] == 404


# --- dispatch through lambda_handler ----------------------------------------


def test_delete_goal_dispatch(handler, monkeypatch):
    repo = FakeGoalsRepo(goals={"g1": {"name": "Holiday"}})
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)

    resp = handler.lambda_handler(
        api_event("DELETE", "/goals/g1", path_params={"id": "g1"}), None)

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


# --- WHIT-231 value boundaries and GET-after-PUT round trips ------------------


def _put(handler, body, goal_id="g1"):
    repo = FakeGoalsRepo()
    resp = handler.upsert_goal(_put_event(goal_id=goal_id, body=body), repo, FakeBalanceRepo())
    return resp, repo


def test_target_amount_exactly_at_ceiling_is_accepted(handler):
    # [G1] the cap itself; `<= high` must let it through (guards a `<` regression).
    # Read from the handler (WHIT-393) so a cap change needs no edit here.
    cap = handler._GOAL_AMOUNT_MAX
    resp, repo = _put(handler, _grow_body(target_amount=cap))
    assert resp["statusCode"] == 200, json.loads(resp["body"])
    assert repo.upsert_calls[0][1]["target_amount"] == Decimal(str(cap))


def test_manual_balance_exactly_zero_is_accepted(handler):
    # [G6] 0 must not read as "no manual source" (the guard uses `is not None`, not truthiness).
    resp, repo = _put(handler, _manual_paydown_body(manual_balance=0))
    assert resp["statusCode"] == 200, json.loads(resp["body"])
    assert repo.upsert_calls[0][1]["manual_balance"] == Decimal("0")


def _persisting_goals_repo(handler):
    """The REAL GoalsRepository over a FakeTable, so GET reflects a prior PUT (real round trip)."""
    repo = handler.GoalsRepository()
    repo._table = FakeTable()
    return repo


def _stored_goal(repo, goal_id):
    return repo._table.store[("GOALS", "GOALS")]["items"][goal_id]


def test_get_after_put_round_trips_numbers_and_echoes_id(handler, monkeypatch):
    # [G15] PUT a manual paydown carrying BOTH baseline and manual_balance, then GET:
    # every numeric must come back as a JSON number (not a string), the id must be
    # echoed from the map key, and no unknown field survives.
    repo = _persisting_goals_repo(handler)
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", FakeBalanceRepo)

    body = _manual_paydown_body(manual_balance=8400.25, baseline=100, sneaky="x")
    put = handler.lambda_handler(_put_event(goal_id="car1", body=body), None)
    assert put["statusCode"] == 200

    got = handler.lambda_handler(
        api_event("GET", "/goals"), None)
    assert got["statusCode"] == 200
    goals = json.loads(got["body"])
    saved = {g["id"]: g for g in goals}["car1"]

    assert saved["id"] == "car1"                          # id echoed from the map key
    for field in ("target_amount", "manual_balance", "baseline"):
        assert isinstance(saved[field], (int, float)), (field, saved[field])
    assert saved["manual_balance"] == 8400.25
    assert saved["baseline"] == 100
    assert "sneaky" not in saved                          # extra field never stored


# --- WHIT-476: the optional checkpoint ladder --------------------------------
# A goal may carry `checkpoints` -- {id, label, amount} steps on the way to target_amount,
# ordered in the goal's OWN direction. The id is permanent and kept as sent -- the client
# normally mints it, the server mints only for a row that arrives without -- because the
# once-ever celebration (a later slice) keys on it. Absent stays absent, so goals saved
# before this feature are stored byte-identical.


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


def test_omitted_checkpoints_store_no_key_at_all(handler):
    # Existing-goal compatibility: a goal saved without a ladder is stored exactly as before.
    goal = _saved_goal(handler, _grow_body())
    assert "checkpoints" not in goal


def test_client_supplied_id_is_kept_and_trimmed(handler):
    goal = _saved_goal(handler, _grow_body(
        checkpoints=[_cp("Kept", 1000, id="  cp-1  "), _cp("Minted", 2000)]))

    assert goal["checkpoints"][0]["id"] == "cp-1"     # trimmed, not re-minted
    assert goal["checkpoints"][1]["id"] != "cp-1"     # the id-less row got its own


# --- WHIT-476 QA GAPS: round trip, replace semantics, precision, ordering depth ------
# The implementer's block above locks the validator's own rules (shape, bounds, ordering
# of a 2-rung ladder, ids). These cover what it does NOT: the ladder surviving the real
# store -> list -> JSON encode path, the whole-object REPLACE semantics an edit inherits,
# Decimal precision, unicode, and the deliberate slice-4 deferral.


def _ladder_round_trip(handler, monkeypatch, goal_id, body):
    """PUT `body` through the real lambda_handler into a persisting repo, then GET, and
    return the goal as the CLIENT sees it (post JSON encode)."""
    repo = _persisting_goals_repo(handler)
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", FakeBalanceRepo)
    put = handler.lambda_handler(_put_event(goal_id=goal_id, body=body), None)
    assert put["statusCode"] == 200, json.loads(put["body"])
    got = handler.lambda_handler(
        api_event("GET", "/goals"), None)
    assert got["statusCode"] == 200
    return {g["id"]: g for g in json.loads(got["body"])}[goal_id]


def test_checkpoint_ladder_survives_the_put_get_round_trip_as_json(handler, monkeypatch):
    # [A1] The ladder is a list of nested Decimals -- the one shape nothing else on a goal
    # has. Prove it survives store -> list_goals -> the JSON dump: order kept, amounts are
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


def test_an_edit_that_omits_checkpoints_keeps_the_saved_ladder(handler, monkeypatch):
    # [A3] WHIT-476 option B. A save that does NOT mention checkpoints keeps the stored ladder,
    # so a writer that doesn't know about them (an old app build, a new code path) can't wipe
    # them. Renaming a goal must leave its ladder intact.
    repo = _persisting_goals_repo(handler)
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", FakeBalanceRepo)

    handler.lambda_handler(_put_event(
        goal_id="hol1", body=_grow_body(checkpoints=[_cp("Halfway", 2500)])), None)

    second = handler.lambda_handler(_put_event(
        goal_id="hol1", body=_grow_body(name="Bigger holiday")), None)   # no checkpoints sent
    assert second["statusCode"] == 200
    ladder = _stored_goal(repo, "hol1")["checkpoints"]
    assert [c["label"] for c in ladder] == ["Halfway"]        # kept, not wiped
    assert json.loads(second["body"])["name"] == "Bigger holiday"


def test_an_explicit_empty_list_clears_the_saved_ladder(handler, monkeypatch):
    # [A3b] The one deliberate way to remove a ladder: send [] (the edit UI does this when the
    # user deletes every rung). Unlike an omission, [] is honoured -- the stored ladder goes.
    repo = _persisting_goals_repo(handler)
    monkeypatch.setattr(handler, "GoalsRepository", lambda: repo)
    monkeypatch.setattr(handler, "AccountBalanceRepository", FakeBalanceRepo)

    handler.lambda_handler(_put_event(
        goal_id="hol1", body=_grow_body(checkpoints=[_cp("Halfway", 2500)])), None)

    handler.lambda_handler(_put_event(
        goal_id="hol1", body=_grow_body(checkpoints=[])), None)
    assert "checkpoints" not in _stored_goal(repo, "hol1")            # cleared, stored as no key


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


def test_label_length_counts_characters_not_bytes(handler):
    # [A9] 100 emoji is 100 CHARACTERS but 400 UTF-8 bytes. The cap is a character cap, so
    # the 100 pass and the 101st fails -- a byte-based cap would reject both.
    goal = _saved_goal(handler, _grow_body(checkpoints=[_cp("\U0001F389" * 100, 1000)]))
    assert len(goal["checkpoints"][0]["label"]) == 100
    _assert_400(handler, _grow_body(checkpoints=[_cp("\U0001F389" * 101, 1000)]))


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


def test_manual_save_omitting_checkpoints_celebrates_against_saved_ladder(handler, monkeypatch):
    # The celebration runs against the SAVED (carried-forward) ladder, not the request body: the
    # save OMITS checkpoints, but the stored ladder must still drive the crossing.
    carried = [{"id": "cp1", "label": "Carried", "amount": Decimal("4000")}]
    saved = {"id": "g1", "name": "Holiday", "icon": "palm", "direction": "grow",
             "target_amount": Decimal("10000"), "target_date": "2026-12-01",
             "manual_balance": Decimal("5000"), "manual_as_of": "2026-07-01",
             "checkpoints": carried}
    repo = FakeGoalsRepo(
        goals={"g1": {"direction": "grow", "manual_balance": Decimal("1000"), "checkpoints": carried}},
        saved_override=saved,
    )
    seen = []
    monkeypatch.setattr(handler, "notify_goal_checkpoint_crossing",
                        lambda old, new, **kw: seen.append((old, new, kw["goal"].get("checkpoints"))) or 1)

    resp = handler.upsert_goal(_put_event(body=_without(_grow_manual_body(), "checkpoints")), repo, FakeBalanceRepo())

    assert resp["statusCode"] == 200
    assert seen == [(Decimal("1000"), Decimal("5000"), carried)]


# --- WHIT-483 legacy caveat: an old goal saved NEGATIVE before the fix, on a later valid save

class _FakeDeviceRepo:
    def __init__(self, tokens=("ExpoTok",)):
        self._tokens = list(tokens)

    def list_tokens(self):
        return self._tokens


def _run_manual_crossing(handler, monkeypatch, *, old_goal, new_body):
    """Drive upsert_goal through the REAL notify_goal_checkpoint_crossing with the real notify repo
    over a FakeTable and a fake device repo, capturing any push. Proves the legacy old-balance flows through the real crossing math."""
    import sys
    gc_mod = sys.modules[handler.notify_goal_checkpoint_crossing.__module__]
    sent = []
    monkeypatch.setattr(
        gc_mod, "send_push",
        lambda title, body, toks, data=None: sent.append((title, body, toks, data)) or {"ok": 1})
    repo = FakeGoalsRepo(goals={"g1": dict(old_goal)})
    notify = goal_checkpoint_repo()
    resp = handler.upsert_goal(
        _put_event(body=new_body), repo, FakeBalanceRepo(),
        notify_repo=notify, device_repo=_FakeDeviceRepo())
    return resp, notify, sent


def test_legacy_negative_paydown_later_valid_save_fires_no_burst(handler, monkeypatch):
    # [G16] WHIT-483 legacy caveat (paydown, the burn scenario). A goal saved with a NEGATIVE owed
    # BEFORE the fix, then a later valid (>=0) save. The old owed normalises to £0 (max(0,value)), so
    # a DOWNWARD crossing (old_norm > amount) can never fire against it -> no spurious burst.
    old = {
        "id": "g1", "name": "Car loan", "icon": "car", "direction": "paydown",
        "target_amount": Decimal("0"), "target_date": "2027-06-01",
        "manual_balance": Decimal("-8400"), "manual_as_of": "2026-06-01",
        "checkpoints": [{"id": "cp1", "label": "Under 5k", "amount": Decimal("5000")},
                        {"id": "cp2", "label": "Under 3k", "amount": Decimal("3000")}],
    }
    new = _manual_paydown_body(
        manual_balance=4000,
        checkpoints=[_cp("Under 5k", 5000, id="cp1"), _cp("Under 3k", 3000, id="cp2")])
    resp, notify, sent = _run_manual_crossing(handler, monkeypatch, old_goal=old, new_body=new)
    assert resp["statusCode"] == 200
    assert sent == []             # no push
    assert checkpoints_marked(notify) == []    # no rung burned


def test_legacy_negative_grow_later_valid_save_treats_it_as_zero(handler, monkeypatch):
    # [G17] WHIT-483 legacy caveat (grow, critic-flagged). A grow goal stored NEGATIVE before the fix
    # normalises to £0, so a later valid save crosses ONLY the rungs genuinely between 0 and the new
    # balance (a real crossing) -- the rung ABOVE the new balance stays unfired. NOT an all-rungs burst.
    old = {
        "id": "g1", "name": "Holiday", "icon": "palm", "direction": "grow",
        "target_amount": Decimal("10000"), "target_date": "2026-12-01",
        "manual_balance": Decimal("-3000"), "manual_as_of": "2026-06-01",
        "checkpoints": [{"id": "cp1", "label": "First", "amount": Decimal("2000")},
                        {"id": "cp2", "label": "Halfway", "amount": Decimal("4000")},
                        {"id": "cp3", "label": "Almost", "amount": Decimal("8000")}],
    }
    new = _grow_manual_body(
        manual_balance=5000,
        checkpoints=[_cp("First", 2000, id="cp1"), _cp("Halfway", 4000, id="cp2"),
                     _cp("Almost", 8000, id="cp3")])
    resp, notify, sent = _run_manual_crossing(handler, monkeypatch, old_goal=old, new_body=new)
    assert resp["statusCode"] == 200
    assert len(sent) == 1                         # one push (the furthest GENUINE rung)
    assert "Halfway" in sent[0][0]                # 4000 is furthest crossed (0 -> 5000), not 8000
    assert set(checkpoints_marked(notify)) == {"g:g1:cp:cp1:bal:2000.00", "g:g1:cp:cp2:bal:4000.00"}
    assert "g:g1:cp:cp3:bal:8000.00" not in checkpoints_marked(notify)   # 8000 above new -> not crossed, no burst
