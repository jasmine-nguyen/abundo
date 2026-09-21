"""Tests for the loan-facts endpoints (GET /loanfacts, PUT /loanfacts) and the
get_loanfacts / set_loanfacts handlers (Loan facts card).

Handler-level tests inject a FakeLoanFactsRepo directly. GET returns the saved
six fields or an all-null sentinel (unset); PUT validates every field and stores
the whole object.
"""

import json

import pytest

from _lambda_api_constants import api_constant

VALID = {"original": 600000, "homeValue": 770000, "lvr": 0.8, "ratePct": 5.74, "baseRepay": 1240, "extra": 200}
_FIELDS = ("original", "homeValue", "lvr", "ratePct", "baseRepay", "extra")
# Read from lambda_api/constants.py rather than hand-copied (WHIT-393), bound at import time so the
# folded boundary parametrize tables (built at collection time) can use it (WHIT-469).
CEILING = api_constant("LOANFACTS_FIELD_MAX")


class FakeLoanFactsRepo:
    """Handler-level stand-in for LoanFactsRepository."""

    def __init__(self, facts=None):
        self._facts = facts
        self.set_calls = []
        self.get_calls = 0

    def get_loanfacts(self):
        self.get_calls += 1
        return dict(self._facts) if self._facts is not None else None

    def set_loanfacts(self, payoffGoalDate=None, depositTarget=None, **kwargs):
        # depositTarget is a NAMED param (like payoffGoalDate) so None never reaches float().
        self.set_calls.append({**kwargs, "payoffGoalDate": payoffGoalDate, "depositTarget": depositTarget})
        return {
            **{k: float(v) for k, v in kwargs.items()},
            "payoffGoalDate": payoffGoalDate,
            "depositTarget": float(depositTarget) if depositTarget is not None else None,
        }


def _put_event(body):
    return {
        "rawPath": "/loanfacts",
        "requestContext": {"http": {"method": "PUT"}},
        "body": json.dumps(body) if not isinstance(body, str) else body,
        "isBase64Encoded": False,
    }


# --- get_loanfacts -----------------------------------------------------------


def test_get_loanfacts_null_sentinel_when_unset(handler):
    out = handler.get_loanfacts(FakeLoanFactsRepo(None))
    # The sentinel carries the optional keys too (payoffGoalDate WHIT-126, depositTarget WHIT-378).
    assert out == {**{f: None for f in _FIELDS}, "payoffGoalDate": None, "depositTarget": None}


def test_get_loanfacts_returns_saved_facts(handler):
    out = handler.get_loanfacts(FakeLoanFactsRepo(dict(VALID)))
    assert out == VALID


def test_route_get_loanfacts(handler, monkeypatch):
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: FakeLoanFactsRepo(dict(VALID)))
    event = {"rawPath": "/loanfacts", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == VALID


# --- set_loanfacts: success --------------------------------------------------


def test_set_loanfacts_success_persists_all_six(handler):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event(VALID), repo)
    assert resp["statusCode"] == 200
    # No optional fields in the body → both forwarded + returned as None.
    assert json.loads(resp["body"]) == {**{k: float(v) for k, v in VALID.items()}, "payoffGoalDate": None, "depositTarget": None}
    assert set(repo.set_calls[0]) == set(_FIELDS) | {"payoffGoalDate", "depositTarget"}
    assert repo.set_calls[0]["payoffGoalDate"] is None
    assert repo.set_calls[0]["depositTarget"] is None


# --- set_loanfacts: payoff goal date (WHIT-126) ------------------------------


def test_set_loanfacts_accepts_and_forwards_a_valid_goal_date(handler):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, "payoffGoalDate": "2035-06-01"}), repo)
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["payoffGoalDate"] == "2035-06-01"
    assert json.loads(resp["body"])["payoffGoalDate"] == "2035-06-01"


def test_set_loanfacts_accepts_explicit_null_goal_date(handler):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, "payoffGoalDate": None}), repo)
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["payoffGoalDate"] is None


@pytest.mark.parametrize("bad_date", ["June 2035", "2035/06/01", "2035-6-1", "not-a-date", 20350601])
def test_set_loanfacts_rejects_a_malformed_goal_date(handler, bad_date):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, "payoffGoalDate": bad_date}), repo)
    assert resp["statusCode"] == 400
    assert "payoffGoalDate" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []   # nothing persisted on a rejected write


def test_set_loanfacts_rejects_an_impossible_calendar_date(handler):
    # Passes the shape regex but isn't a real date — date.fromisoformat rejects it.
    resp = handler.set_loanfacts(_put_event({**VALID, "payoffGoalDate": "2035-13-45"}), FakeLoanFactsRepo())
    assert resp["statusCode"] == 400
    assert "real calendar date" in json.loads(resp["body"])["error"]


# --- set_loanfacts: deposit target (WHIT-378) --------------------------------


def test_set_loanfacts_accepts_and_forwards_a_valid_deposit_target(handler):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, "depositTarget": 120000}), repo)
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["depositTarget"] == 120000        # forwarded to the repo
    assert json.loads(resp["body"])["depositTarget"] == 120000.0


def test_set_loanfacts_accepts_explicit_null_deposit_target(handler):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, "depositTarget": None}), repo)
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["depositTarget"] is None


def test_set_loanfacts_extra_zero_is_allowed(handler):
    # extra is an optional top-up, so 0 is valid (unlike the other amounts).
    resp = handler.set_loanfacts(_put_event({**VALID, "extra": 0}), FakeLoanFactsRepo())
    assert resp["statusCode"] == 200


def test_route_put_loanfacts_dispatch(handler, monkeypatch):
    repo = FakeLoanFactsRepo()
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: repo)
    resp = handler.lambda_handler(_put_event(VALID), None)
    assert resp["statusCode"] == 200
    assert len(repo.set_calls) == 1


# --- set_loanfacts: validation -----------------------------------------------


@pytest.mark.parametrize(
    "body, needle",
    [
        ({k: v for k, v in VALID.items() if k != "homeValue"}, "homeValue must be a number"),  # missing
        ({**VALID, "original": "600000"}, "original must be a number"),                          # string
        ({**VALID, "baseRepay": True}, "baseRepay must be a number"),                            # bool
        ({**VALID, "original": 0}, "original must be > 0"),                                       # zero amount
        ({**VALID, "homeValue": -1}, "homeValue must be > 0"),                                    # negative amount
        ({**VALID, "extra": -5}, "extra must be >= 0"),                                           # negative extra
        ({**VALID, "lvr": 0}, "lvr must be a fraction"),                                          # lvr too low
        ({**VALID, "lvr": 1.5}, "lvr must be a fraction"),                                        # lvr > 1 (percent not divided)
        ({**VALID, "ratePct": 0}, "ratePct must be between"),                                     # rate too low
        ({**VALID, "ratePct": 150}, "ratePct must be between"),                                   # rate too high
        ({**VALID, "original": 2_000_000_000}, "original too large"),                             # over ceiling
    ],
)
def test_set_loanfacts_rejects_bad_fields(handler, body, needle):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event(body), repo)
    assert resp["statusCode"] == 400
    assert needle in json.loads(resp["body"])["error"]
    assert repo.set_calls == []   # nothing persisted on a rejected write


def test_set_loanfacts_rejects_invalid_json(handler):
    resp = handler.set_loanfacts(_put_event("{not json"), FakeLoanFactsRepo())
    assert resp["statusCode"] == 400


# === boundary + non-finite gaps (folded from test_loanfacts_edges.py) — inclusive upper
# bounds accepted, deposit-target boundaries, and the math.isfinite gate. The drifted repo
# is kept renamed (FakeLoanFactsRepo_edges: a set_calls variant vs the get_calls one above). =


class FakeLoanFactsRepo_edges:
    def __init__(self, facts=None):
        self._facts = facts
        self.set_calls = []

    def get_loanfacts(self):
        return dict(self._facts) if self._facts is not None else None

    def set_loanfacts(self, payoffGoalDate=None, depositTarget=None, **kwargs):
        self.set_calls.append({**kwargs, "payoffGoalDate": payoffGoalDate, "depositTarget": depositTarget})
        return {
            **{k: float(v) for k, v in kwargs.items()},
            "payoffGoalDate": payoffGoalDate,
            "depositTarget": float(depositTarget) if depositTarget is not None else None,
        }


@pytest.mark.parametrize(
    "over",
    [
        {"lvr": 1},                 # inclusive top of (0, 1]
        {"ratePct": 100},           # inclusive top of (0, 100]
        {"original": CEILING},      # exactly at the ceiling (guard is strict >)
        {"extra": CEILING},         # extra also shares the ceiling
    ],
)
def test_set_loanfacts_accepts_inclusive_upper_bounds(handler, over):
    repo = FakeLoanFactsRepo_edges()
    resp = handler.set_loanfacts(_put_event({**VALID, **over}), repo)
    assert resp["statusCode"] == 200
    assert len(repo.set_calls) == 1


# --- deposit target (WHIT-378) boundaries ------------------------------------


def test_set_loanfacts_accepts_deposit_target_at_the_ceiling(handler):
    # Shares the dollar ceiling with the other amounts; the guard is strict >, so == is fine.
    repo = FakeLoanFactsRepo_edges()
    resp = handler.set_loanfacts(_put_event({**VALID, "depositTarget": CEILING}), repo)
    assert resp["statusCode"] == 200
    assert len(repo.set_calls) == 1


@pytest.mark.parametrize(
    "bad, needle",
    [
        (True, "number"),          # bool is rejected before the numeric check
        (0, "> 0"),                # zero is not a real target
        (-100, "> 0"),             # negative
        (CEILING + 1, "too large"),
    ],
)
def test_set_loanfacts_rejects_a_bad_deposit_target(handler, bad, needle):
    repo = FakeLoanFactsRepo_edges()
    resp = handler.set_loanfacts(_put_event({**VALID, "depositTarget": bad}), repo)
    assert resp["statusCode"] == 400
    assert needle in json.loads(resp["body"])["error"]
    assert repo.set_calls == []   # nothing persisted on a rejected write


def test_set_loanfacts_rejects_non_finite_deposit_target(handler):
    body = (
        '{"original": 600000, "homeValue": 770000, "lvr": 0.8, "ratePct": 5.74, '
        '"baseRepay": 1240, "extra": 200, "depositTarget": Infinity}'
    )
    repo = FakeLoanFactsRepo_edges()
    resp = handler.set_loanfacts(_put_event(body), repo)
    assert resp["statusCode"] == 400
    assert "finite" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []


@pytest.mark.parametrize("token", ["Infinity", "-Infinity", "NaN"])
def test_set_loanfacts_rejects_non_finite_numbers(handler, token):
    # json.loads accepts these bare tokens; the handler's math.isfinite gate must catch them.
    body = (
        '{"original": %s, "homeValue": 770000, "lvr": 0.8, '
        '"ratePct": 5.74, "baseRepay": 1240, "extra": 200}' % token
    )
    repo = FakeLoanFactsRepo_edges()
    resp = handler.set_loanfacts(_put_event(body), repo)
    assert resp["statusCode"] == 400
    assert "finite" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []
