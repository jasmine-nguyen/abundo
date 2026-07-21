"""Tests for the one-time swipe-date backfill (lambda/backfill_swipe_dates.py).

`backfill_swipe_dates(repo, dry_run)` scans every account and rewrites each stored
row's `date` to its `authorized_date` (the swipe day) when the two differ — fixing
rows written before the webhook started anchoring `date` to the swipe day. Rows with
no `authorized_date` keep their booking date. Dry-run by default writes nothing, and
a second pass is a no-op. Backed by the FakeTable `repo` fixture.
"""

from decimal import Decimal

# A real BankSync account id that resolves via ACCOUNT_ID_MAP to an internal id, so the
# stored rows land under an account the sweep actually visits.
_BANK_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _norm(lam, **over):
    row = {
        "id": "x", "date": "2026-06-29", "authorizedDate": "2026-06-22",
        "description": "SQ *KKV INTERNATIONAL PTY", "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": "-42.00", "accountId": _BANK_ACCOUNT_ID, "accountName": "ANZ Rewards Black Visa",
        "category": "FOOD_AND_DRINK", "pending": False, "type": "PAYMENT", "pendingTransactionId": None,
    }
    row.update(over)
    return lam.banksync.BankSyncClient.normalise(row)


def _seed_legacy(lam, repo, txn_id, *, settlement_date, swipe_date, **over):
    """Store a row shaped like one written BEFORE the swipe-date fix: `date` holds the
    settlement day while `authorized_date` holds the swipe day."""
    txn = _norm(lam, id=txn_id, date=settlement_date, authorizedDate=swipe_date, **over)
    txn["date"] = settlement_date  # normalise now anchors to the swipe day — force the legacy shape
    repo.insert_transactions([txn])
    return txn


def _rows(repo):
    """All stored ACCOUNT#/TXN# rows as {transaction_id: item}."""
    return {v["transaction_id"]: v for k, v in repo._table.store.items()
            if k[0].startswith("ACCOUNT#")}


# --- apply mode: the core re-anchor ------------------------------------------


def test_reanchors_settlement_date_to_swipe_date(lam, repo):
    _seed_legacy(lam, repo, "A", settlement_date="2026-06-29", swipe_date="2026-06-22")

    summary = lam.backfill_swipe_dates.backfill_swipe_dates(repo, dry_run=False)

    assert summary["mismatched"] == 1 and summary["updated"] == 1
    assert _rows(repo)["A"]["date"] == "2026-06-22"          # now the swipe day
    assert _rows(repo)["A"]["authorized_date"] == "2026-06-22"


def test_reanchor_preserves_every_other_field(lam, repo):
    # A user note/category/amount must survive the date rewrite — the whole row is
    # re-put, only `date` changes.
    txn = _seed_legacy(lam, repo, "A", settlement_date="2026-06-29", swipe_date="2026-06-22",
                       category="FOOD_AND_DRINK")
    acc = ("ACCOUNT#" + txn["account_id"], "TXN#A")
    repo._table.store[acc]["notes"] = "reimburse from work"
    repo._table.store[acc]["category"] = "groceries"

    lam.backfill_swipe_dates.backfill_swipe_dates(repo, dry_run=False)

    row = _rows(repo)["A"]
    assert row["date"] == "2026-06-22"
    assert row["notes"] == "reimburse from work"    # preserved
    assert row["category"] == "groceries"           # preserved
    assert row["amount"] == Decimal("-42.00")       # preserved


def test_row_already_anchored_is_untouched(lam, repo):
    # date already == authorized_date → nothing to do.
    _seed_legacy(lam, repo, "A", settlement_date="2026-06-22", swipe_date="2026-06-22")

    summary = lam.backfill_swipe_dates.backfill_swipe_dates(repo, dry_run=False)

    assert summary["mismatched"] == 0 and summary["updated"] == 0
    assert _rows(repo)["A"]["date"] == "2026-06-22"


def test_row_without_authorized_date_keeps_booking_date(lam, repo):
    # No swipe date from the bank → the booking date is the correct fallback; leave it.
    _seed_legacy(lam, repo, "A", settlement_date="2026-06-29", swipe_date="")

    summary = lam.backfill_swipe_dates.backfill_swipe_dates(repo, dry_run=False)

    assert summary["mismatched"] == 0 and summary["updated"] == 0
    assert _rows(repo)["A"]["date"] == "2026-06-29"          # unchanged


# --- dry-run & idempotency ---------------------------------------------------


def test_dry_run_reports_but_writes_nothing(lam, repo):
    _seed_legacy(lam, repo, "A", settlement_date="2026-06-29", swipe_date="2026-06-22")

    summary = lam.backfill_swipe_dates.backfill_swipe_dates(repo, dry_run=True)

    assert summary["mismatched"] == 1 and summary["updated"] == 0
    assert _rows(repo)["A"]["date"] == "2026-06-29"          # NOT rewritten under dry-run


def test_second_pass_is_a_noop(lam, repo):
    _seed_legacy(lam, repo, "A", settlement_date="2026-06-29", swipe_date="2026-06-22")

    lam.backfill_swipe_dates.backfill_swipe_dates(repo, dry_run=False)
    second = lam.backfill_swipe_dates.backfill_swipe_dates(repo, dry_run=False)

    assert second["mismatched"] == 0 and second["updated"] == 0
    assert _rows(repo)["A"]["date"] == "2026-06-22"


def test_summary_counts_scanned_and_mixes_across_rows(lam, repo):
    _seed_legacy(lam, repo, "STALE", settlement_date="2026-06-29", swipe_date="2026-06-22")
    _seed_legacy(lam, repo, "OK", settlement_date="2026-06-22", swipe_date="2026-06-22")
    _seed_legacy(lam, repo, "NOSWIPE", settlement_date="2026-06-29", swipe_date="")

    summary = lam.backfill_swipe_dates.backfill_swipe_dates(repo, dry_run=False)

    assert summary["scanned"] == 3
    assert summary["mismatched"] == 1 and summary["updated"] == 1
    assert _rows(repo)["STALE"]["date"] == "2026-06-22"     # only the true mismatch moved
    assert _rows(repo)["OK"]["date"] == "2026-06-22"
    assert _rows(repo)["NOSWIPE"]["date"] == "2026-06-29"
