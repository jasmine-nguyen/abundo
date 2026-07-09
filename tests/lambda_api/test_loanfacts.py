"""Tests for the loan-facts endpoints (GET /loanfacts, PUT /loanfacts) and the
get_loanfacts / set_loanfacts handlers (Loan facts card).

Handler-level tests inject a FakeLoanFactsRepo directly. GET returns the saved
six fields or an all-null sentinel (unset); PUT validates every field and stores
the whole object.
"""

import json

import pytest

VALID = {"original": 600000, "homeValue": 770000, "lvr": 0.8, "ratePct": 5.74, "baseRepay": 1240, "extra": 200}
_FIELDS = ("original", "homeValue", "lvr", "ratePct", "baseRepay", "extra")


class FakeLoanFactsRepo:
    """Handler-level stand-in for LoanFactsRepository."""

    def __init__(self, facts=None):
        self._facts = facts
        self.set_calls = []
        self.get_calls = 0

    def get_loanfacts(self):
        self.get_calls += 1
        return dict(self._facts) if self._facts is not None else None

    def set_loanfacts(self, payoffGoalDate=None, **kwargs):
        self.set_calls.append({**kwargs, "payoffGoalDate": payoffGoalDate})
        return {**{k: float(v) for k, v in kwargs.items()}, "payoffGoalDate": payoffGoalDate}


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
    # The sentinel carries the optional payoffGoalDate key too (WHIT-126).
    assert out == {**{f: None for f in _FIELDS}, "payoffGoalDate": None}


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
    # No goal date in the body → payoffGoalDate forwarded + returned as None.
    assert json.loads(resp["body"]) == {**{k: float(v) for k, v in VALID.items()}, "payoffGoalDate": None}
    assert set(repo.set_calls[0]) == set(_FIELDS) | {"payoffGoalDate"}
    assert repo.set_calls[0]["payoffGoalDate"] is None


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
