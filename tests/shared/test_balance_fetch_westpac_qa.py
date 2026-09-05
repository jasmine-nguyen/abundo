"""WHIT-490 — normalise_account_balance against the REAL credit-card payload.

tests/shared/test_balance_fetch.py covers the mortgage/checking shapes. The Westpac
getBalance payload is the first one that carries fields no other account sends
(`creditLimit`, `pendingBalance`, `balanceAsOf`, `retrievedAt`, `accountNumber`, ...)
AND the first with a NEGATIVE amount beside a POSITIVE availableBalance. Both are
ways a normaliser can quietly go wrong: leak an unknown key into the stored row, or
mix the two money fields up.
"""

from decimal import Decimal


# Copied verbatim from the live getBalance response, wrapped in the success envelope.
_WESTPAC_DATA = {
    "date": "2026-09-05T03:58:13.856Z",
    "retrievedAt": "2026-09-05T03:58:13.856Z",
    "balanceAsOf": None,
    "bank": "Westpac",
    "account": "0908 (unknown)",
    "accountName": "Altitude Qantas Black Card",
    "accountNumber": "0908",
    "accountType": "unknown",
    "accountId": "A3AC9195-9E8D-48B8-86D0-46D130D7F64A",
    "bankId": "fiskil_77",
    "amount": -230,
    "availableBalance": 5770,
    "pendingBalance": 0,
    "creditLimit": 6000,
    "currency": "AUD",
}
_WESTPAC_PAYLOAD = {"success": True, "data": _WESTPAC_DATA}


def test_real_westpac_payload_normalises_to_exactly_the_five_stored_fields(shared):
    # The whole row, asserted as an EXACT dict: the negative amount stays negative,
    # the positive availableBalance stays positive next to it (they are not swapped or
    # sign-linked), and every extra field the card sends is dropped rather than written
    # into the balances table under a name the app never reads.
    out = shared.balance_fetch.normalise_account_balance(_WESTPAC_PAYLOAD)

    assert out == {
        "amount": Decimal("-230"),
        "available_balance": Decimal("5770"),
        "currency": "AUD",
        "as_of": "2026-09-05T03:58:13.856Z",
        "account_type": "unknown",
    }


def test_null_balance_as_of_never_displaces_the_date_field(shared):
    # The card is the first account to send `balanceAsOf`, and it sends it NULL.
    # `as_of` must keep coming from `date`. Pinned with a DIFFERENT balanceAsOf value
    # too, so a change that starts preferring balanceAsOf reddens here rather than
    # silently back-dating every credit-card reading on the Accounts tab.
    null_as_of = shared.balance_fetch.normalise_account_balance(_WESTPAC_PAYLOAD)
    assert null_as_of["as_of"] == "2026-09-05T03:58:13.856Z"

    decoy = {"success": True, "data": {**_WESTPAC_DATA, "balanceAsOf": "1999-01-01T00:00:00Z"}}
    assert shared.balance_fetch.normalise_account_balance(decoy)["as_of"] == "2026-09-05T03:58:13.856Z"


def test_a_card_paid_off_to_zero_keeps_a_signed_zero_amount(shared):
    # The other boundary: a fully paid card reports amount 0. It must normalise to
    # Decimal("0") and NOT raise — the `is None` guard exists precisely so a falsy-but-
    # present amount survives. A truthiness guard would raise BalanceError and the card
    # would keep showing yesterday's debt forever.
    zeroed = {"success": True, "data": {**_WESTPAC_DATA, "amount": 0}}

    out = shared.balance_fetch.normalise_account_balance(zeroed)

    assert out["amount"] == Decimal("0")


