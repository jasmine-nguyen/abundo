"""WHIT-50 — counts_to_budget in the BankSync normaliser. Implementer's happy-path
+ acceptance tests: a real purchase counts; transfers / loan repayments / home-loan-
account movements don't; income is left counting. Row shapes mirror real Up payloads."""

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
    return lam.banksync.BankSyncClient.normalise(_row(**over))


def test_normal_purchase_counts_to_budget(lam):
    assert _normalise(lam)["counts_to_budget"] is True


def test_home_loan_repayment_debit_is_excluded(lam):
    # "Repayment to Home loan" leaving Spending → LOAN_PAYMENTS. The budget-eater.
    txn = _normalise(lam, category="LOAN_PAYMENTS", description="Repayment to Home loan", amount="-3667")
    assert txn["counts_to_budget"] is False


def test_own_account_transfer_out_is_excluded(lam):
    txn = _normalise(lam, category="TRANSFER_OUT", description="Transfer to 2Up Spending", amount="-35")
    assert txn["counts_to_budget"] is False


def test_transfer_in_is_excluded(lam):
    txn = _normalise(lam, category="TRANSFER_IN", description="Transfer from 2Up Spending", amount="3662.33")
    assert txn["counts_to_budget"] is False


def test_home_loan_account_interest_is_excluded(lam):
    # Interest on the mortgage account → BANK_FEES (NOT a transfer category), so the
    # account rule — not the category rule — is what excludes it.
    txn = _normalise(lam, accountId="T6d8ppsYssBDFCwl1qEb0w", accountName="Home loan",
                     category="BANK_FEES", description="Interest", amount="-2525.82")
    assert txn["counts_to_budget"] is False


def test_income_still_counts(lam):
    # WHIT-50 leaves INCOME alone so the earn-target feature can use it.
    txn = _normalise(lam, category="INCOME", description="$hannahply", amount="3657.93")
    assert txn["counts_to_budget"] is True


def test_unknown_account_still_raises(lam):
    with pytest.raises(lam.banksync.UnknownAccountError):
        _normalise(lam, accountId="not_a_real_account")


# --- gap/adversarial tests (qa) ----------------------------------------------------

ANZ_BANKSYNC_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"  # -> anz-rewards-black-visa
HOMELOAN_BANKSYNC_ID = "T6d8ppsYssBDFCwl1qEb0w"                   # -> up-homeloan


def test_counts_to_budget_home_loan_account_beats_any_category(lam):
    # The account rule dominates: even a would-count category is excluded on the mortgage.
    for category in ("MEDICAL", "INCOME", "TRANSFER_IN"):
        assert lam.banksync.counts_to_budget("up-homeloan", category) is False


@pytest.mark.parametrize("category", ["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"])
def test_counts_to_budget_non_budget_categories_excluded(lam, category):
    assert lam.banksync.counts_to_budget("up-spending", category) is False


@pytest.mark.parametrize("category", ["MEDICAL", "INCOME", "SERVICES", "BANK_FEES"])
def test_counts_to_budget_spend_and_income_count(lam, category):
    assert lam.banksync.counts_to_budget("up-spending", category) is True
    assert lam.banksync.counts_to_budget("anz-rewards-black-visa", category) is True


@pytest.mark.parametrize("txn_type, description", [
    ("DIRECT_DEBIT", "Vanguard Investments"),           # investment debit
    ("TRANSFER_OUTGOING", "Transfer to 2Up Spending"),  # own-account transfer
    ("PAYMENT", "Hannah ANZ Advantage"),                # ANZ card payment
])
def test_transfer_out_excluded_regardless_of_type(lam, txn_type, description):
    txn = _normalise(lam, category="TRANSFER_OUT", type=txn_type,
                     description=description, amount="-500")
    assert txn["counts_to_budget"] is False


def test_loan_payment_positive_credit_excluded(lam):
    # Repayments can post as a POSITIVE credit (Amex +6.25) — sign must not matter,
    # only category. The implementer only exercised the negative debit leg.
    txn = _normalise(lam, category="LOAN_PAYMENTS", type="PAYMENT",
                     description="American Express", amount="6.25")
    assert txn["counts_to_budget"] is False


def test_home_loan_repayment_credit_leg_excluded(lam):
    # The repayment landing IN the mortgage account is TRANSFER_IN / TRANSFER_INCOMING —
    # excluded by BOTH the account and the category rule.
    txn = _normalise(lam, accountId=HOMELOAN_BANKSYNC_ID, accountName="Home loan",
                     category="TRANSFER_IN", type="TRANSFER_INCOMING",
                     description="Transfer from Spending", amount="3667")
    assert txn["account_id"] == "up-homeloan"
    assert txn["counts_to_budget"] is False


def test_income_on_home_loan_account_excluded(lam):
    # INCOME is normally left counting, but the account rule wins on the mortgage.
    txn = _normalise(lam, accountId=HOMELOAN_BANKSYNC_ID, accountName="Home loan",
                     category="INCOME", amount="10.00")
    assert txn["counts_to_budget"] is False


@pytest.mark.parametrize("category",
                         ["MEDICAL", "SERVICES", "RENT_AND_UTILITIES", "ENTERTAINMENT"])
def test_real_purchase_categories_count(lam, category):
    assert _normalise(lam, category=category)["counts_to_budget"] is True


def test_positive_refund_still_counts(lam):
    # Medicare Rebate posts as MEDICAL +98.95 — a refund, not a transfer, still counts.
    txn = _normalise(lam, category="MEDICAL", description="Medicare Benefit", amount="98.95")
    assert txn["counts_to_budget"] is True


def test_purchase_on_anz_card_account_counts(lam):
    # The card account is a spend surface — purchases there must still count.
    txn = _normalise(lam, accountId=ANZ_BANKSYNC_ID, accountName="ANZ Rewards Black",
                     category="ENTERTAINMENT", amount="-42.00")
    assert txn["account_id"] == "anz-rewards-black-visa"
    assert txn["counts_to_budget"] is True


def test_missing_category_key_raises_keyerror(lam):
    # normalise reads row["category"] directly; a MISSING key is a KeyError, which
    # handler.process_transaction catches -> save_failed_transactions.
    row = _row()
    del row["category"]
    with pytest.raises(KeyError):
        lam.banksync.BankSyncClient.normalise(row)


def test_null_category_reaches_helper_and_counts(lam):
    # A JSON-null category is NOT a missing key: it flows through as None ->
    # None not in NON_BUDGET_CATEGORIES -> True, stored as category=None. Documents
    # current behaviour (the reader skips category=None at aggregation).
    txn = _normalise(lam, category=None)
    assert txn["category"] is None
    assert txn["counts_to_budget"] is True


# --- merchant_name cleaning (real ANZ payload shapes) ------------------------


def test_pending_row_stores_clean_merchant_and_raw_description(lam):
    # Pending card auth: no merchantName, "POS AUTHORISATION" prefix column.
    raw = "POS AUTHORISATION         COLES 0602               MELBOURNE    AU"
    txn = _normalise(lam, description=raw, merchantName="", pending=True)
    assert txn["merchant_name"] == "COLES"       # cleaned for display
    assert txn["description"] == raw             # description kept byte-for-byte raw


def test_posted_row_uses_merchant_name_column(lam):
    txn = _normalise(
        lam,
        description="SQ *KKV INTERNATIONAL PTY Sunshine",
        merchantName="SQ *KKV INTERNATIONAL PTY ",
        pending=False,
    )
    assert txn["merchant_name"] == "KKV INTERNATIONAL PTY"
    assert txn["description"] == "SQ *KKV INTERNATIONAL PTY Sunshine"


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
    txn = lam.banksync.BankSyncClient.normalise(row)
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


def test_booking_datetime_is_truncated_on_fallback(lam):
    # No authorizedDate → `date` falls back to the booking date, still time-sliced.
    row = _row(date="2026-01-16T10:00:00Z")
    del row["authorizedDate"]
    txn = lam.banksync.BankSyncClient.normalise(row)
    assert txn["date"] == "2026-01-16"
    assert txn["authorized_date"] == ""


def test_datetime_date_logs_a_warning_naming_the_field(lam, caplog):
    with caplog.at_level("WARNING"):
        _normalise(lam, date="2026-01-16T10:00:00Z", authorizedDate="2026-01-15")
    msgs = [r.getMessage() for r in caplog.records]
    assert any("truncating" in m for m in msgs)
    assert any("date carried" in m for m in msgs)          # the offending field is named


def test_datetime_authorized_date_warning_names_authorized_date(lam, caplog):
    # The warning must name the field that actually carried a time component, so a
    # BankSync format change points at the right field in CloudWatch.
    with caplog.at_level("WARNING"):
        _normalise(lam, date="2026-01-16", authorizedDate="2026-01-15T23:30:00Z")
    assert any("authorizedDate carried" in r.getMessage() for r in caplog.records)


def test_date_only_input_logs_nothing(lam, caplog):
    with caplog.at_level("WARNING"):
        _normalise(lam, date="2026-01-16", authorizedDate="2026-01-15")
    assert caplog.records == []
