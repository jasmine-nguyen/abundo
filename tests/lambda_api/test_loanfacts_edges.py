"""Boundary + non-finite gaps for PUT /loanfacts (Loan facts card).

Complements tests/lambda_api/test_loanfacts.py, which locks the REJECT side of
lvr/ratePct/ceiling. Here: the inclusive upper bounds must be ACCEPTED (lvr == 1,
ratePct == 100, a dollar field at exactly LOANFACTS_FIELD_MAX), and the
math.isfinite branch — Infinity / NaN parse fine from JSON but must 400.
"""

import json

import pytest

VALID = {"original": 600000, "homeValue": 770000, "lvr": 0.8, "ratePct": 5.74, "baseRepay": 1240, "extra": 200}
CEILING = 1_000_000_000  # LOANFACTS_FIELD_MAX


class FakeLoanFactsRepo:
    def __init__(self, facts=None):
        self._facts = facts
        self.set_calls = []

    def get_loanfacts(self):
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
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event({**VALID, **over}), repo)
    assert resp["statusCode"] == 200
    assert len(repo.set_calls) == 1


@pytest.mark.parametrize("token", ["Infinity", "-Infinity", "NaN"])
def test_set_loanfacts_rejects_non_finite_numbers(handler, token):
    # json.loads accepts these bare tokens; the handler's math.isfinite gate must catch them.
    body = (
        '{"original": %s, "homeValue": 770000, "lvr": 0.8, '
        '"ratePct": 5.74, "baseRepay": 1240, "extra": 200}' % token
    )
    repo = FakeLoanFactsRepo()
    resp = handler.set_loanfacts(_put_event(body), repo)
    assert resp["statusCode"] == 400
    assert "finite" in json.loads(resp["body"])["error"]
    assert repo.set_calls == []
