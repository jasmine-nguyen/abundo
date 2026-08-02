"""WHIT-394 — [A1]-[A8] the API READ paths end-to-end over the REAL MilestoneRepository.

The implementer's tests/shared/test_milestone_rows.py stops at the repository: it proves
_to_client drops a corrupt row. Nothing proves what the card is actually FOR — that the
endpoints downstream of that read stop falling over. POST /milestones/review is the sharp
one: lambda_api/handler.py:2420-2428 calls float(), math.ceil() and date.fromisoformat()
on every row _to_client hands back, OUTSIDE any per-row guard, and lambda_handler only
catches VersionConflictError (handler.py:293) — so one corrupt stored row was an uncaught
Lambda error, i.e. a hard 500 on "Review my plan".

Every test here drives the REAL repository (real _to_client) behind an in-memory table, and
several go through lambda_handler so the asserted body is the literal JSON the app receives.

  [A1] review: a NULL stored targetDate -> 200, not a 500 (date.fromisoformat(None)).
  [A2] review: a blank / unparsable stored targetDate -> 200, not a 500.
  [A3] review: a NaN stored target -> 200 and the healthy row is still reviewed
       (math.ceil(nan) raised ValueError before).
  [A4] review: a -Infinity stored target never reaches the model blob, which must stay
       strict-JSON encodable (a bare -Infinity token is not JSON).
  [A5] review: EVERY stored row corrupt -> 409 "save a plan first", and NO AI call
       (no spend, no 502, no 500).
  [A6] GET /milestones: the response body is strict-parsable JSON with no NaN/Infinity
       token, and the corrupt row is absent.
  [A7] over-rejection guard: every row PUT /milestones ACCEPTS must survive GET
       /milestones — the new read validation must not silently eat a legitimately
       saved row (cap balance, 0 balance, 100-char label, unicode label, leap day).
  [A8] GET /milestones with every row corrupt -> 200 [], never null and never a 500.
"""

import datetime
import json
from decimal import Decimal

import pytest


# --- harness ----------------------------------------------------------------

class FakeConfigTable:
    """The single-config-item slice of DynamoDB MilestoneRepository uses: get_item/put_item
    on pk=MILESTONES, sk=<scope>. Injected as repo._table so the real _read_milestones /
    _to_client run unmodified."""

    def __init__(self):
        self.store = {}

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        self.store[(Item["pk"], Item["sk"])] = dict(Item)


@pytest.fixture
def milestone_repo(handler):
    repo = handler.MilestoneRepository()
    repo._table = FakeConfigTable()
    return repo


def _store_raw(repo, rows, scope="SHARED"):
    """Inject stored rows directly, bypassing set_milestones' validation — a legacy or
    directly-written row (mirrors tests/shared/test_repository_milestone_edges.py)."""
    repo._table.store[("MILESTONES", scope)] = {
        "pk": "MILESTONES", "sk": scope, "milestones": rows,
    }


GOOD = {"id": "good", "label": "Quarter down", "targetBalance": Decimal("400000"),
        "targetDate": "2030-01-01"}


def _row(**overrides):
    return {**GOOD, **overrides}


class FixedDate(datetime.date):
    @classmethod
    def today(cls):
        return datetime.date(2026, 1, 15)


FACTS = {"original": 550000, "homeValue": 800000, "lvr": 68,
         "ratePct": 5.74, "baseRepay": 3000, "extra": 0}


class FakeLoanFactsRepo:
    def get_loanfacts(self):
        return dict(FACTS)


class FakeHomeLoanRepo:
    def get_balance(self, account_id):
        return {"balance": Decimal("500000"), "as_at": "2026-01-10"}


def _review_event():
    return {"rawPath": "/milestones/review",
            "requestContext": {"http": {"method": "POST"}}, "body": ""}


def _get_event():
    return {"rawPath": "/milestones",
            "requestContext": {"http": {"method": "GET"}}, "body": ""}


def _put_event(rows):
    return {"rawPath": "/milestones", "requestContext": {"http": {"method": "PUT"}},
            "body": json.dumps({"milestones": rows}), "isBase64Encoded": False}


@pytest.fixture
def review(handler, monkeypatch):
    """Drive review_milestones against the REAL repository, with the model call captured.
    Returns (response, captured_model_inputs)."""
    monkeypatch.setattr(handler, "date", FixedDate)
    captured = []

    def fake_review_pacing(model_input):
        captured.append(model_input)
        return [{"index": 0, "reason": "running behind your plan"}]

    monkeypatch.setattr(handler, "review_pacing", fake_review_pacing)

    def run(repo):
        resp = handler.review_milestones(
            _review_event(), repo, FakeHomeLoanRepo(), FakeLoanFactsRepo())
        return resp, captured

    return run


# --- [A1]/[A2] a corrupt stored targetDate no longer 500s "Review my plan" ---

def test_null_target_date_no_longer_crashes_the_review_endpoint(milestone_repo, review):
    # [A1] date.fromisoformat(None) raises TypeError at handler.py:2428, OUTSIDE any guard,
    # and lambda_handler catches only VersionConflictError -> an uncaught Lambda error.
    # Fail-on-revert: put `"targetDate": m["targetDate"]` back in _to_client -> TypeError.
    _store_raw(milestone_repo, [_row(id="bad", targetDate=None), GOOD])
    resp, captured = review(milestone_repo)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert [a["milestoneId"] for a in body["adjustments"]] == ["good"]
    assert captured, "the healthy row still reached the model"


@pytest.mark.parametrize("bad_date", ["", "   ", "not-a-date", "2026-02-30", "01/01/2030", 20300101])
def test_unparsable_stored_target_date_no_longer_crashes_the_review_endpoint(
        milestone_repo, review, bad_date):
    # [A2] Same crash, ValueError flavour (and TypeError for the int). 2026-02-30 has the
    # right SHAPE but isn't a real calendar day — the shape-only check the save endpoint's
    # regex does would let it through; only date.fromisoformat catches it.
    _store_raw(milestone_repo, [_row(id="bad", targetDate=bad_date), GOOD])
    resp, _ = review(milestone_repo)
    assert resp["statusCode"] == 200
    assert [a["milestoneId"] for a in json.loads(resp["body"])["adjustments"]] == ["good"]


# --- [A3]/[A4] a non-finite stored target through the review maths ----------

def test_nan_target_no_longer_crashes_the_review_endpoint(milestone_repo, review):
    # [A3] float(Decimal("NaN")) is nan; `nan >= balance` is False so the row was NOT
    # skipped at handler.py:2421, months_to_payoff returned nan, and math.ceil(nan) raised
    # "cannot convert float NaN to integer" (handler.py:2426) -> 500.
    # Fail-on-revert: put `float(m["targetBalance"])` back in _to_client.
    _store_raw(milestone_repo, [_row(id="bad", targetBalance=Decimal("NaN")), GOOD])
    resp, _ = review(milestone_repo)
    assert resp["statusCode"] == 200
    assert [a["milestoneId"] for a in json.loads(resp["body"])["adjustments"]] == ["good"]


def test_negative_infinity_target_never_reaches_the_model_blob(milestone_repo, review):
    # [A4] -inf does NOT crash review: it sails past both guards (-inf < balance, and
    # months_to_payoff treats a <=0 balance as 0 months), so it became a real CANDIDATE and
    # rode into _review_model_input -> the Anthropic request body. json.dumps emits a bare
    # `-Infinity` token there, which is not valid JSON. Silent corruption, not a crash — the
    # nastiest of the four. Fail-on-revert: restore float(m["targetBalance"]) in _to_client.
    _store_raw(milestone_repo, [_row(id="bad", targetBalance=Decimal("-Infinity")), GOOD])
    resp, captured = review(milestone_repo)
    assert resp["statusCode"] == 200
    assert captured, "the model was called"
    json.dumps(captured[0], allow_nan=False)   # raises ValueError if any inf/nan leaked
    assert [m["targetBalance"] for m in captured[0]["milestones"]] == [400000.0]


# --- [A5] a wholly-corrupt plan is a clean 409, not a 500 and not AI spend ---

def test_every_row_corrupt_is_a_clean_409_with_no_ai_call(milestone_repo, review):
    # [A5] _to_client drops them all -> `stored` is [] -> the falsy check at handler.py:2500
    # returns 409 "save a plan first". Must never 500, and must never pay for an AI call on
    # an empty candidate set.
    _store_raw(milestone_repo, [
        _row(id="a", targetDate=None),
        _row(id="b", targetBalance=Decimal("NaN")),
        _row(id="c", label="   "),
        "a bare string row",
    ])
    resp, captured = review(milestone_repo)
    assert resp["statusCode"] == 409
    assert json.loads(resp["body"])["error"] == "save a plan first"
    assert captured == [], "no AI call for a plan with nothing usable in it"


# --- [A6]/[A8] GET /milestones through lambda_handler ------------------------

@pytest.mark.parametrize("bad_target", [Decimal("NaN"), Decimal("Infinity"), Decimal("-Infinity")])
def test_get_milestones_body_is_strict_json_without_the_corrupt_row(
        handler, milestone_repo, monkeypatch, bad_target):
    # [A6] The literal HTTP body, not the repo return value. json.dumps defaults to
    # allow_nan=True and emits bare NaN/Infinity tokens, which no JSON parser outside
    # Python accepts — so ONE corrupt row made the whole plan unreadable to the app, not
    # just that row. json.loads is deliberately given parse_constant, because Python's own
    # json.loads happily reads those tokens back and would hide the bug.
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: milestone_repo)
    _store_raw(milestone_repo, [GOOD, _row(id="bad", targetBalance=bad_target)])

    resp = handler.lambda_handler(_get_event(), None)
    assert resp["statusCode"] == 200
    def _reject(token):
        raise AssertionError(f"non-JSON token {token!r} in the milestones body")
    parsed = json.loads(resp["body"], parse_constant=_reject)
    assert parsed == [{"id": "good", "label": "Quarter down",
                       "targetBalance": 400000.0, "targetDate": "2030-01-01"}]


def test_get_milestones_with_every_row_corrupt_is_an_empty_list_not_null(
        handler, milestone_repo, monkeypatch):
    # [A8] All rows unusable -> 200 [] (the app falls back to its built-in default plan),
    # never a literal null and never a 500.
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: milestone_repo)
    _store_raw(milestone_repo, [_row(id="a", label=""), _row(id="b", targetDate="nope"), 42])

    resp = handler.lambda_handler(_get_event(), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


# --- [A7] the over-rejection guard: a saved row must never vanish on read ----

_ROUND_TRIP = [
    {"label": "x" * 100, "targetBalance": 1_000_000_000, "targetDate": "2027-02-28"},
    {"label": "Ünïcödé 🎉 目標", "targetBalance": 595413.43, "targetDate": "2028-02-29"},
    {"label": "Paid off", "targetBalance": 0, "targetDate": "2030-12-31"},
]


def test_every_row_the_save_endpoint_accepts_survives_the_read(
        handler, milestone_repo, monkeypatch):
    # [A7] The risk WHIT-394 introduces is the mirror of the bug it fixes: a read rule
    # STRICTER than the write rule silently deletes rows from a user's saved plan on the
    # way back. Boundary rows on purpose — the balance cap, a 0 balance, a 100-char label,
    # a non-ASCII label, and a leap day (which date.fromisoformat only accepts in a leap
    # year). PUT then GET through lambda_handler, one repository, no fakes in between.
    monkeypatch.setattr(handler, "MilestoneRepository", lambda: milestone_repo)

    put = handler.lambda_handler(_put_event(_ROUND_TRIP), None)
    assert put["statusCode"] == 200, put["body"]
    assert len(json.loads(put["body"])) == 3, "set_milestones' own return dropped a row"

    got = json.loads(handler.lambda_handler(_get_event(), None)["body"])
    assert [m["label"] for m in got] == [r["label"] for r in _ROUND_TRIP]
    assert [m["targetBalance"] for m in got] == [1_000_000_000.0, 595413.43, 0.0]
    assert [m["targetDate"] for m in got] == [r["targetDate"] for r in _ROUND_TRIP]
