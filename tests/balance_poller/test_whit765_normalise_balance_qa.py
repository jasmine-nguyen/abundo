"""QA gap tests for WHIT-765: the poller's normalise_balance now wraps the shared
normaliser. Locks the edges the switch could shift: the output shape, the mortgage
guard's interplay with the shared checks, and a non-object payload.
"""

from decimal import Decimal

import pytest


# [A10] (P0) the mortgage reading keeps exactly the three stored fields — none of the
# shared row's extras (available_balance, account_type, signed amount) leak through
def test_normalise_balance_returns_only_balance_as_of_and_currency(handler):
    payload = {"success": True, "data": {
        "amount": -250000.5, "availableBalance": 1000, "date": "2026-10-01", "currency": "NZD",
        "accountType": "mortgage",
    }}

    assert handler.normalise_balance(payload) == {
        "balance": Decimal("250000.5"), "as_of": "2026-10-01", "currency": "NZD",
    }


# [A11] (P1) a non-object payload (an error page's JSON array) is a clean BalanceError
@pytest.mark.parametrize("payload", [[], "oops", None])
def test_normalise_balance_raises_balance_error_on_a_non_object_payload(handler, payload):
    with pytest.raises(handler.BalanceError):
        handler.normalise_balance(payload)


# [A13] (P1) a valid non-mortgage reading is still rejected by the poller's own guard
@pytest.mark.parametrize("account_type", ["transaction", "credit-card", ""])
def test_normalise_balance_rejects_a_good_reading_from_a_non_mortgage_account(handler, account_type):
    payload = {"success": True, "data": {"amount": -5, "date": "2026-10-01", "accountType": account_type}}
    with pytest.raises(handler.BalanceError, match="mortgage"):
        handler.normalise_balance(payload)
