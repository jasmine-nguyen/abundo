"""The BankSync normaliser: signed amount, swipe date, cleaned merchant and the stored
counts_to_budget flag (its truth table lives with shared spend). Row shapes mirror
real Up payloads."""

from decimal import Decimal

import pytest


def _row(**over):
    """A valid BankSync row (a normal purchase on the Up Spending account)."""
    row = {
        "id": "bank_tx_1", "date": "2026-06-18", "authorizedDate": "2026-06-17",
        "description": "Wellbeing Chiropractic", "merchantName": "Wellbeing Chiropractic",
        "amount": "-151.02", "accountId": "3zVQJ8Btz_IRmqp78VrQnQ",  # up-spending
        "accountName": "Spending", "category": "MEDICAL", "type": "OTHER",
        "pending": False, "pendingTransactionId": None,
    }
    row.update(over)
    return row


def _normalise(lam, **over):
    return lam.banksync.normalise(_row(**over))


@pytest.mark.parametrize("over, counts", [
    ({}, True),                                                     # a purchase
    ({"category": "TRANSFER_OUT", "description": "Transfer to 2Up Spending",
      "amount": "-35"}, False),                                     # own-account transfer
])
def test_normalise_stores_counts_to_budget(lam, over, counts):
    assert _normalise(lam, **over)["counts_to_budget"] is counts


def test_unknown_account_still_raises(lam):
    with pytest.raises(lam.banksync.UnknownAccountError):
        _normalise(lam, accountId="not_a_real_account")


def test_missing_category_key_normalises_and_counts(lam):
    # A row with NO category key must NOT crash (it used to raise KeyError, which
    # dead-lettered the whole transaction and left it stuck forever). It normalises,
    # stores category=None (same as a JSON-null category), and still counts to budget.
    # Asserting BOTH the stored category AND counts_to_budget exercises both former
    # row["category"] reads, so reverting only one of them still reddens this.
    row = _row()
    del row["category"]
    txn = lam.banksync.normalise(row)
    assert txn["category"] is None
    assert txn["counts_to_budget"] is True


# --- merchant_name cleaning (real ANZ payload shapes) ------------------------


def test_pending_row_stores_clean_merchant_and_raw_description(lam):
    # Pending card auth: no merchantName, "POS AUTHORISATION" prefix column.
    raw = "POS AUTHORISATION         COLES 0602               MELBOURNE    AU"
    txn = _normalise(lam, description=raw, merchantName="", pending=True)
    assert txn["merchant_name"] == "COLES"       # cleaned for display
    assert txn["description"] == raw             # description kept byte-for-byte raw


# --- `date` is the swipe day, not the settlement day -------------------------
# A charge is anchored to the day the user actually paid (authorizedDate), NOT the
# day the bank books/settles it (date). Otherwise a charge shows on its swipe day
# while pending, then jumps to the settlement day once it posts. `date` falls back
# to the booking date only when the bank sent no authorizedDate, so it's never empty.


def test_date_anchors_to_swipe_date_not_booking(lam):
    # authorizedDate (swipe day) wins over the later booking date.
    txn = _normalise(lam, date="2026-01-16", authorizedDate="2026-01-15")
    assert txn["date"] == "2026-01-15"          # swipe day, not the booking "2026-01-16"
    assert txn["authorized_date"] == "2026-01-15"


def test_missing_authorized_date_falls_back_to_booking_date(lam):
    # No authorizedDate → `date` falls back to the booking date so it's never empty
    # (the budget window, the date-index GSI and the age-out sweep all rely on that).
    row = _row(date="2026-06-18")
    del row["authorizedDate"]
    txn = lam.banksync.normalise(row)
    assert txn["authorized_date"] == ""
    assert txn["date"] == "2026-06-18"


# --- WHIT-91: date-only enforcement on ingest --------------------------------
# The budget window is a string range compare (Key("date").between(start, today))
# and reconciliation exact-matches authorized_date; both assume bare YYYY-MM-DD.
# normalise must slice any time component off on write so a BankSync format change
# can't silently drop today's charge from the window.


def test_swipe_datetime_is_truncated_to_date_only(lam):
    # `date` sources from authorizedDate now, so the time component must be sliced there.
    txn = _normalise(lam, date="2026-01-16T10:00:00Z", authorizedDate="2026-01-15T23:30:00Z")
    assert txn["date"] == "2026-01-15"
    assert txn["authorized_date"] == "2026-01-15"


# --- Westpac Altitude Qantas Black Card -------------------------------------
# The account reached the webhook before it was mapped, so every row was rejected
# by resolve_account_id and dead-lettered. These lock the mapping and the shape of
# the two rows that were actually stuck, taken verbatim from the FAILED partition.

WESTPAC_BANKSYNC_ID = "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"


def test_westpac_account_resolves_to_its_internal_id(lam):
    assert lam.banksync.resolve_account_id(WESTPAC_BANKSYNC_ID) == "westpac-altitude-qantas-black"


def test_westpac_fee_row_normalises_and_counts_to_budget(lam):
    # The real "QANTAS REWARDS FEE" row. `category` is a raw BankSync enum here
    # (BANK_FEES) — not in NON_BUDGET_CATEGORIES, so a card fee counts as spend.
    txn = _normalise(
        lam,
        id="bank_tx_6d03cf4f45d7ec6ef02b23506a4dc3a69b7e32ba63867a46c02d8b58c76fa20b",
        date="2026-09-02", authorizedDate="2026-09-02",
        description="QANTAS REWARDS FEE", merchantName="QANTAS REWARDS FEE",
        amount="-75", category="BANK_FEES", type="FEE",
        accountId=WESTPAC_BANKSYNC_ID, accountName="Altitude Qantas Black Card",
    )
    assert txn["account_id"] == "westpac-altitude-qantas-black"
    assert txn["category"] == "BANK_FEES"
    assert txn["counts_to_budget"] is True
    assert txn["status"] == "posted"


def test_recovered_rows_keep_the_signed_amount_not_the_positive_debit(lam):
    # Verbatim from the FAILED partition, including the fields normalise ignores. A
    # positive debitAmount sits beside the negative amount: reading the wrong one would
    # store a card charge as income.
    massage_raw = {
        "id": "bank_tx_b220e370899f9a0b0b75a04837f4190e80b7fea137ee7a02e5b11df1f52822a5",
        "date": "2026-09-03", "authorizedDate": "2026-09-02",
        "description": "UNIFLEXREMEDIALMASSAGE ALTONA NORT AUS",
        "merchantName": "UNIFLEXREMEDIALMASSAGE",
        "creditAmount": 0, "debitAmount": 155,
        "category": "health", "providerCategory": "PERSONAL_CARE", "type": "OTHER",
        "bank": "Westpac", "accountName": "Altitude Qantas Black Card",
        "accountNumber": "0908", "accountType": "unknown",
        "accountId": WESTPAC_BANKSYNC_ID, "bankId": "fiskil_77",
        "currency": "AUD", "amount": -155, "pending": False,
    }
    txn = lam.banksync.normalise(massage_raw)
    assert txn["amount"] == Decimal("-155")
    for junk in ("debitAmount", "creditAmount", "providerCategory", "bankId", "accountNumber"):
        assert junk not in txn


