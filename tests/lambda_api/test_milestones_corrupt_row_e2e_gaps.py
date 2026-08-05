"""WHIT-394 — the milestones READ/SAVE paths end-to-end over the REAL MilestoneRepository.

The implementer's tests/shared/test_milestone_rows.py stops at the repository: it proves
_to_client drops a corrupt row. These prove the endpoints downstream of that read stay
strict-JSON and don't over-reject a legitimately saved row.

(WHIT-450 removed the AI review endpoint, so this suite's original [A1]-[A5] review cases —
which drove POST /milestones/review — went with it. The GET/PUT cases below cover the kept
read + save paths.)

Every test drives the REAL repository (real _to_client) behind an in-memory table, and goes
through lambda_handler so the asserted body is the literal JSON the app receives.

  [A6] GET /milestones: the response body is strict-parsable JSON with no NaN/Infinity
       token, and the corrupt row is absent.
  [A7] over-rejection guard: every row PUT /milestones ACCEPTS must survive GET
       /milestones — the read validation must not silently eat a legitimately
       saved row (cap balance, 0 balance, 100-char label, unicode label, leap day).
  [A8] GET /milestones with every row corrupt -> 200 [], never null and never a 500.
"""

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
    directly-written row (mirrors tests/shared/test_repository_milestone.py)."""
    repo._table.store[("MILESTONES", scope)] = {
        "pk": "MILESTONES", "sk": scope, "milestones": rows,
    }


GOOD = {"id": "good", "label": "Quarter down", "targetBalance": Decimal("400000"),
        "targetDate": "2030-01-01"}


def _row(**overrides):
    return {**GOOD, **overrides}


def _get_event():
    return {"rawPath": "/milestones",
            "requestContext": {"http": {"method": "GET"}}, "body": ""}


def _put_event(rows):
    return {"rawPath": "/milestones", "requestContext": {"http": {"method": "PUT"}},
            "body": json.dumps({"milestones": rows}), "isBase64Encoded": False}


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
