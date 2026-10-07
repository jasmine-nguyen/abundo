"""PUT /loanfacts: each loan field is checked once against its own range and a bad value
gets one message naming that field and its range, in the depositTarget style (WHIT-810).
Runs the real LoanFactsRepository over FakeTable, so "nothing saved" is read off the table."""

import json

import pytest

from _dynamo_fakes import FakeTable
from _lambda_api_constants import api_constant

CEILING = api_constant("LOANFACTS_FIELD_MAX")
VALID = {"original": 600000, "homeValue": 770000, "lvr": 0.8, "ratePct": 5.74, "baseRepay": 1240, "extra": 200}
NON_FINITE_ORIGINAL = (
    '{"original": Infinity, "homeValue": 770000, "lvr": 0.8, '
    '"ratePct": 5.74, "baseRepay": 1240, "extra": 200}'
)
AMOUNT = f"must be a number above 0 and up to {CEILING}"


@pytest.mark.parametrize(
    "body, message",
    [
        ({k: v for k, v in VALID.items() if k != "homeValue"}, f"homeValue {AMOUNT}"),  # missing
        ({**VALID, "original": "600000"}, f"original {AMOUNT}"),                        # string
        ({**VALID, "baseRepay": True}, f"baseRepay {AMOUNT}"),                          # bool
        (NON_FINITE_ORIGINAL, f"original {AMOUNT}"),                                    # Infinity
        ({**VALID, "original": 0}, f"original {AMOUNT}"),                               # zero
        ({**VALID, "homeValue": -1}, f"homeValue {AMOUNT}"),                            # negative
        ({**VALID, "baseRepay": CEILING + 1}, f"baseRepay {AMOUNT}"),                   # over the ceiling
        ({**VALID, "extra": -5}, f"extra must be a number between 0 and {CEILING}"),
        ({**VALID, "extra": CEILING + 1}, f"extra must be a number between 0 and {CEILING}"),
        ({**VALID, "lvr": 0}, "lvr must be a number above 0 and up to 1"),
        ({**VALID, "lvr": 1.5}, "lvr must be a number above 0 and up to 1"),
        ({**VALID, "ratePct": 0}, "ratePct must be a number above 0 and up to 100"),
        ({**VALID, "ratePct": 150}, "ratePct must be a number above 0 and up to 100"),
    ],
)
def test_bad_loan_field_gets_one_message_with_its_own_range(handler, body, message):
    repo = handler.LoanFactsRepository()
    repo._table = FakeTable()
    event = {
        "rawPath": "/loanfacts",
        "requestContext": {"http": {"method": "PUT"}},
        "body": body if isinstance(body, str) else json.dumps(body),
        "isBase64Encoded": False,
    }

    resp = handler.set_loanfacts(event, repo)

    assert resp["statusCode"] == 400
    assert json.loads(resp["body"])["error"] == message
    assert repo._table.store == {}
