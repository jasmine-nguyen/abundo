"""WHIT-490 — adversarial QA gaps for the Altitude Qantas Black Card feed.

Covers what tests/lambda/test_banksync.py's three new tests do NOT: the dead-letter
RECOVERY sweep driven over the two rows actually stuck in the FAILED partition
(each dead-lettered twice by two sync runs), the stored shape after that replay,
the age-out sweep now visiting a fourth account, and the swipe-vs-booking date
edge at a pay-cycle boundary.

The two raw rows below are copied VERBATIM from the FAILED partition, including the
fields our normaliser ignores (`debitAmount`, `providerCategory`, `bankId`, ...) —
the point is that a real row round-trips, not a trimmed fixture.
"""

from datetime import date
from decimal import Decimal

_WESTPAC_AID = "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"

_MASSAGE_ID = "bank_tx_b220e370899f9a0b0b75a04837f4190e80b7fea137ee7a02e5b11df1f52822a5"
_FEE_ID = "bank_tx_6d03cf4f45d7ec6ef02b23506a4dc3a69b7e32ba63867a46c02d8b58c76fa20b"

# --- the two rows verbatim from the FAILED partition ------------------------
_MASSAGE_RAW = {
    "id": _MASSAGE_ID,
    "date": "2026-09-03", "authorizedDate": "2026-09-02",
    "description": "UNIFLEXREMEDIALMASSAGE ALTONA NORT AUS",
    "merchantName": "UNIFLEXREMEDIALMASSAGE",
    "creditAmount": 0, "debitAmount": 155,
    "category": "health", "providerCategory": "PERSONAL_CARE", "type": "OTHER",
    "bank": "Westpac", "accountName": "Altitude Qantas Black Card",
    "accountNumber": "0908", "accountType": "unknown",
    "accountId": _WESTPAC_AID, "bankId": "fiskil_77",
    "currency": "AUD", "amount": -155, "pending": False,
}
_FEE_RAW = {
    "id": _FEE_ID,
    "date": "2026-09-02", "authorizedDate": "2026-09-02",
    "description": "QANTAS REWARDS FEE", "merchantName": "QANTAS REWARDS FEE",
    "creditAmount": 0, "debitAmount": 75,
    "category": "BANK_FEES", "providerCategory": "BANK_FEES", "type": "FEE",
    "bank": "Westpac", "accountName": "Altitude Qantas Black Card",
    "accountNumber": "0908", "accountType": "unknown",
    "accountId": _WESTPAC_AID, "bankId": "fiskil_77",
    "currency": "AUD", "amount": -75, "pending": False,
}


def _failed_keys(repo):
    return [k for k in repo._table.store if k[0] == "FAILED"]


def _txn_rows(repo):
    """Stored ACCOUNT#/TXN# rows as {sk: item}."""
    return {k[1]: v for k, v in repo._table.store.items() if k[0].startswith("ACCOUNT#")}


def _dead_letter_the_real_backlog(repo):
    """Recreate the live backlog: two sync runs each dead-lettered BOTH rows, so the
    FAILED partition holds FOUR rows over TWO distinct transaction ids (each
    save_failed_transactions call mints its own timestamp#uuid sk)."""
    repo.save_failed_transactions([_MASSAGE_RAW, _FEE_RAW])
    repo.save_failed_transactions([_MASSAGE_RAW, _FEE_RAW])


# --- the recovery sweep over the REAL backlog --------------------------------


def test_recovery_sweep_replays_the_duplicated_backlog_into_exactly_two_rows(lam, repo):
    # Four dead-letter rows, two distinct transactions. Every row must be replayed
    # and deleted, and the duplicate copy must re-sync onto the SAME item rather than
    # minting a second row (the sk is the transaction id, so a duplicate would be a
    # silent overwrite — but a changed key scheme would show up as 3+ rows here).
    _dead_letter_the_real_backlog(repo)
    assert len(_failed_keys(repo)) == 4

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 4, "skipped": 0, "errors": 0}
    assert _failed_keys(repo) == []                       # backlog fully drained
    stored = _txn_rows(repo)
    assert set(stored) == {f"TXN#{_MASSAGE_ID}", f"TXN#{_FEE_ID}"}   # exactly two rows
    assert {v["pk"] for v in stored.values()} == {"ACCOUNT#westpac-altitude-qantas-black"}


def test_recovered_rows_keep_the_signed_amount_not_the_positive_debit(lam, repo):
    # Both raw rows carry a POSITIVE `debitAmount` beside the negative `amount`.
    # Reading the wrong field (or abs()-ing) would store a credit-card charge as income:
    # it would flip the Accounts-tab colour and subtract from, instead of adding to,
    # budget spend. Assert the stored signed values and the budget flags together.
    _dead_letter_the_real_backlog(repo)
    lam.reprocess.reprocess_failed(repo)

    stored = _txn_rows(repo)
    massage = stored[f"TXN#{_MASSAGE_ID}"]
    fee = stored[f"TXN#{_FEE_ID}"]

    assert massage["amount"] == Decimal("-155")
    assert fee["amount"] == Decimal("-75")               # the two rows are NOT equal amounts
    for row in (massage, fee):
        assert row["account_id"] == "westpac-altitude-qantas-black"
        assert row["account_name"] == "Altitude Qantas Black Card"
        assert row["status"] == "posted"
        assert row["counts_to_budget"] is True
    # `date` is the SWIPE day for the massage (booking was 2026-09-03), and the fee's
    # two dates already agree.
    assert massage["date"] == "2026-09-02"
    assert fee["date"] == "2026-09-02"
    # Fields our normaliser does not map must not leak into the stored item.
    for junk in ("debitAmount", "creditAmount", "providerCategory", "bankId", "accountNumber"):
        assert junk not in massage


# --- the age-out sweep now visits a fourth account ---------------------------


def test_age_out_reaps_a_stale_ghost_on_the_westpac_account(lam, repo):
    # The repaired count assertion in test_age_out.py derives its expected number
    # from ACCOUNT_ID_MAP itself, so it can no longer tell whether the WESTPAC account is
    # in the sweep. This asserts the BEHAVIOUR: a 21-day-old pending sitting on the new
    # account is actually reaped. today is injected, so no ambient clock.
    ghost = lam.banksync.BankSyncClient.normalise({
        **_MASSAGE_RAW, "id": "westpac_ghost", "pending": True,
        "date": "2026-06-10", "authorizedDate": "2026-06-10",
    })
    repo.insert_transactions([ghost])

    summary = lam.age_out.age_out_stale_pendings(repo, today=date(2026, 7, 1), dry_run=False)

    assert summary["stale"] == 1 and summary["reaped"] == 1 and summary["failed"] == 0
    assert "TXN#westpac_ghost" not in _txn_rows(repo)


# --- the swipe-date rule at a pay-cycle boundary -----------------------------


def test_massage_charge_is_bucketed_by_its_swipe_day_not_its_booking_day(lam):
    # The massage row is BOOKED 2026-09-03 but SWIPED 2026-09-02, and normalise
    # keys `date` off the swipe. A pay cycle that starts on the 3rd therefore does NOT
    # contain it, while one starting on the 2nd does. Pinned deliberately: it is the
    # difference between the charge landing in this fortnight's budget or the last one,
    # and it is invisible until a cycle boundary falls between the two dates.
    import spend

    txn = lam.banksync.BankSyncClient.normalise(_MASSAGE_RAW)
    assert txn["date"] == "2026-09-02" and txn["authorized_date"] == "2026-09-02"

    start_2nd, end = spend.current_cycle_window("2026-08-19", 14, today=date(2026, 9, 5))
    assert start_2nd == "2026-09-02"                       # payday lands on the swipe day
    assert spend.transactions_in_window([txn], start_2nd, end) == [txn]

    start_3rd, _ = spend.current_cycle_window("2026-08-20", 14, today=date(2026, 9, 5))
    assert start_3rd == "2026-09-03"                       # payday one day later
    assert spend.transactions_in_window([txn], start_3rd, end) == []


def test_westpac_charge_counts_to_the_budget_while_the_home_loan_twin_does_not(lam):
    # The fourth account contributes to budget spend like any other card, and the
    # home-loan exclusion is unchanged: the SAME row on the mortgage account is excluded.
    # Runs the real summariser over the real normalise output, so unmapping the account
    # (UnknownAccountError) or widening the home-loan exclusion both redden this.
    import spend

    card = lam.banksync.BankSyncClient.normalise({**_MASSAGE_RAW, "category": "health"})
    loan = lam.banksync.BankSyncClient.normalise({
        **_MASSAGE_RAW, "id": "loan_row", "category": "health",
        "accountId": "T6d8ppsYssBDFCwl1qEb0w", "accountName": "Up Homeloan",
    })
    assert card["counts_to_budget"] is True
    assert loan["counts_to_budget"] is False

    totals = spend.summarise_transactions([card, loan], {"health"})
    assert totals == {"health": {"posted": Decimal("155"), "pending": Decimal(0)}}
