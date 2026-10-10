"""Tests for the loan-facts endpoints (GET /loanfacts, PUT /loanfacts) and the
get_loanfacts / set_loanfacts handlers (Loan facts card).

Handler-level tests inject a FakeLoanFactsRepo directly. GET returns the saved
six fields or an all-null sentinel (unset); PUT validates every field and stores
the whole object.
"""

import json
from decimal import Decimal

import pytest

from _api_event import api_event
from _lambda_api_constants import api_constant

VALID = {"original": 600000, "homeValue": 770000, "lvr": 0.8, "ratePct": 5.74, "baseRepay": 1240, "extra": 200}
_FIELDS = ("original", "homeValue", "lvr", "ratePct", "baseRepay", "extra")
# Read from lambda_api/api_constants.py rather than hand-copied (WHIT-393), bound at import time so the
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
    return api_event(
        "PUT",
        "/loanfacts",
        raw=json.dumps(body) if not isinstance(body, str) else body,
        is_base64=False,
    )


# --- get_loanfacts -----------------------------------------------------------


def test_get_loanfacts_null_sentinel_when_unset(handler):
    out = handler.get_loanfacts(FakeLoanFactsRepo(None))
    # The sentinel carries the optional keys too (payoffGoalDate WHIT-126, depositTarget WHIT-378).
    assert out == {**{f: None for f in _FIELDS}, "payoffGoalDate": None, "depositTarget": None}


def test_route_get_loanfacts(handler, monkeypatch):
    monkeypatch.setattr(handler, "LoanFactsRepository", lambda: FakeLoanFactsRepo(dict(VALID)))
    event = api_event("GET", "/loanfacts")
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


@pytest.mark.parametrize("bad_date", ["June 2035", "2035/06/01", "2035-6-1", "not-a-date", 20350601, "2035-13-45"])
def test_set_loanfacts_rejects_a_malformed_goal_date(handler, bad_date):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, "payoffGoalDate": bad_date}), repo)
    assert resp["statusCode"] == 400
    assert "payoffGoalDate" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []   # nothing persisted on a rejected write


# --- set_loanfacts: deposit target (WHIT-378) --------------------------------


def test_set_loanfacts_accepts_and_forwards_a_valid_deposit_target(handler):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, "depositTarget": 120000}), repo)
    assert resp["statusCode"] == 200
    assert repo.set_calls[0]["depositTarget"] == 120000        # forwarded to the repo
    assert json.loads(resp["body"])["depositTarget"] == 120000.0


def test_handler_preserves_a_fractional_deposit_target_exactly(handler):
    # DynamoDB rejects float, so the target reaches the repo as Decimal(str(x)) — exact, no drift.
    repo = FakeLoanFactsRepo()
    handler.set_loanfacts(_put_event({**VALID, "depositTarget": 120000.5}), repo)
    forwarded = repo.set_calls[0]["depositTarget"]
    assert isinstance(forwarded, Decimal)
    assert forwarded == Decimal("120000.5")


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
        ({k: v for k, v in VALID.items() if k != "homeValue"}, "homeValue must be a number above 0"),  # missing
        ({**VALID, "original": "600000"}, "original must be a number above 0"),                    # string
        ({**VALID, "original": 0}, "original must be a number above 0"),                           # zero
        ({**VALID, "baseRepay": True}, "baseRepay must be a number above 0"),                      # bool
        ({**VALID, "homeValue": -1}, "homeValue must be a number above 0"),                    # negative amount
        ({**VALID, "extra": -5}, "extra must be a number between 0"),                           # negative extra
        ({**VALID, "lvr": 1.5}, "lvr must be a number above 0 and up to 1"),                      # lvr > 1 (percent not divided)
        ({**VALID, "ratePct": 150}, "ratePct must be a number above 0 and up to 100"),            # rate too high
        ({**VALID, "baseRepay": CEILING + 1}, "baseRepay must be a number above 0"),              # over ceiling
        ({**VALID, "extra": CEILING + 1}, "extra must be a number between 0"),                     # extra over ceiling
    ],
)
def test_set_loanfacts_rejects_bad_fields(handler, body, needle):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event(body), repo)
    assert resp["statusCode"] == 400
    assert needle in json.loads(resp["body"])["error"]
    assert repo.set_calls == []   # nothing persisted on a rejected write


# --- boundaries: inclusive upper bounds, deposit target, the math.isfinite gate ---------------


@pytest.mark.parametrize(
    "over",
    [
        {"lvr": 1},                 # inclusive top of (0, 1]
        {"ratePct": 100},           # inclusive top of (0, 100]
        {"original": CEILING},      # exactly at the ceiling (the upper bound is inclusive)
        {"extra": CEILING},         # extra also shares the ceiling
        {"depositTarget": CEILING},
    ],
)
def test_set_loanfacts_accepts_inclusive_upper_bounds(handler, over):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, **over}), repo)
    assert resp["statusCode"] == 200
    assert len(repo.set_calls) == 1


# --- deposit target (WHIT-378) boundaries ------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        True,          # bool is rejected before the numeric check
        0,             # zero is not a real target
        -100,          # negative
        CEILING + 1,
        float("inf"),  # json.dumps writes the bare Infinity token, which json.loads accepts
    ],
)
def test_set_loanfacts_rejects_a_bad_deposit_target(handler, bad):
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, "depositTarget": bad}), repo)
    assert resp["statusCode"] == 400
    assert "depositTarget must be a number" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []   # nothing persisted on a rejected write


@pytest.mark.parametrize("token", ["Infinity", "-Infinity", "NaN"])
def test_set_loanfacts_rejects_non_finite_numbers(handler, token):
    # json.loads accepts these bare tokens; the handler's finite-number check must catch them.
    body = (
        '{"original": %s, "homeValue": 770000, "lvr": 0.8, '
        '"ratePct": 5.74, "baseRepay": 1240, "extra": 200}' % token
    )
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event(body), repo)
    assert resp["statusCode"] == 400
    assert json.loads(resp["body"])["error"] == f"original must be a number above 0 and up to {CEILING}"
    assert repo.set_calls == []
