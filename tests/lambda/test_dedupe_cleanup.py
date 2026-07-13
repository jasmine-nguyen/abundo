"""Tests for the one-time pre-reconciliation dedupe sweep (WHIT-80,
lambda/dedupe_cleanup.py).

`dedupe_pre_reconciliation(repo, dry_run)` scans each account for an exact
pending/posted twin (same authorized_date + EXACT amount), carries the pending's
category onto the posted (via the repo's own _with_carried_category), and deletes
the stale pending. Dry-run by default writes nothing. Tip-adjusted twins are NOT
merged (exact only). Backed by the FakeTable `repo` fixture.
"""

from decimal import Decimal

# A real BankSync account id that resolves via ACCOUNT_ID_MAP to an internal id.
_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _raw_row(txn_id, amount=-5.50, pending=False, category="FOOD_AND_DRINK",
             authorized_date="2026-06-29"):
    return {
        "id": txn_id,
        "date": "2026-06-29",
        "authorizedDate": authorized_date,
        "description": "SQ *KKV INTERNATIONAL PTY",
        "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": amount,
        "accountId": _MAPPED_ACCOUNT,
        "accountName": "ANZ Rewards Black Visa",
        "category": category,
        "pending": pending,
        "type": "PAYMENT",
        "pendingTransactionId": None,
    }


def _store(lam, repo, *raw_rows):
    """Normalise + store each raw row directly (mimics a row already in DynamoDB)."""
    txns = [lam.banksync.BankSyncClient.normalise(r) for r in raw_rows]
    repo.insert_transactions(txns)


def _rows(repo):
    """All stored ACCOUNT#/TXN# rows as {transaction_id: item}."""
    return {v["transaction_id"]: v for k, v in repo._table.store.items()
            if k[0].startswith("ACCOUNT#")}


def _pending_count(repo):
    return sum(1 for v in _rows(repo).values() if v.get("status") == "pending")


# --- apply mode: the core dedup ---------------------------------------------


def test_dedupe_carries_category_and_deletes_pending(lam, repo):
    # Categorized stale pending + uncategorized posted twin (same auth_date + amount).
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="FOOD_AND_DRINK"))

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["pairs"] == 1 and summary["deduped"] == 1
    rows = _rows(repo)
    assert "pend1" not in rows                       # stale pending deleted
    assert rows["post1"]["category"] == "groceries"  # category carried onto posted


def test_dedupe_carries_a_note_on_a_same_category_twin(lam, repo):
    # WHIT-275: the OLD gate re-put ONLY when the category changed, so a note on a
    # SAME-category pending twin was deleted with the pending and never written to
    # the posted. The whole-row gate re-puts, carrying the note. notes aren't bank
    # fields (normalise strips them), so inject onto the stored pending directly.
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="groceries"))
    for item in repo._table.store.values():
        if item.get("transaction_id") == "pend1":
            item["notes"] = "reimburse me"
            item["tags"] = ["work"]

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["deduped"] == 1
    rows = _rows(repo)
    assert "pend1" not in rows                       # stale pending deleted
    assert rows["post1"]["notes"] == "reimburse me"  # note carried onto posted
    assert rows["post1"]["tags"] == ["work"]         # tags carried onto posted


def test_dedupe_identical_twin_skips_the_reput(lam, repo, monkeypatch):
    # Same category, no note/tag difference → nothing to carry → skip the re-put
    # (still delete the pending). Guards against re-putting on every dedupe.
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="groceries"))
    reputs = []
    original_insert = repo.insert_transactions
    monkeypatch.setattr(
        repo, "insert_transactions",
        lambda txns: reputs.append(txns) or original_insert(txns),
    )

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["deduped"] == 1
    assert "pend1" not in _rows(repo)   # pending still deleted
    assert reputs == []                 # but no needless re-put issued


def test_uncategorized_pending_twin_is_still_deleted(lam, repo):
    # Even when the pending has no user category to carry, the twin is a duplicate:
    # delete the stale pending, leave the posted's own category untouched.
    _store(lam, repo,
           _raw_row("pend1", pending=True, category=None),
           _raw_row("post1", pending=False, category="groceries"))

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["deduped"] == 1
    rows = _rows(repo)
    assert "pend1" not in rows
    assert rows["post1"]["category"] == "groceries"  # unchanged


# --- dry-run: the load-bearing safety ---------------------------------------


def test_dry_run_reports_but_writes_nothing(lam, repo):
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="FOOD_AND_DRINK"))

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=True)

    assert summary["pairs"] == 1 and summary["deduped"] == 0   # found, not applied
    rows = _rows(repo)
    assert "pend1" in rows                                     # nothing deleted
    assert rows["post1"]["category"] == "FOOD_AND_DRINK"       # nothing rewritten


# --- exact-only: tip-adjusted twins are NOT merged --------------------------


def test_tip_adjusted_twin_is_not_merged(lam, repo):
    # Settled amount grew by a tip (-5.50 -> -6.00): live reconcile would tip-match,
    # but the cleanup is exact-only, so these must be left alone.
    _store(lam, repo,
           _raw_row("pend1", pending=True, amount=-5.50, category="groceries"),
           _raw_row("post1", pending=False, amount=-6.00, category="FOOD_AND_DRINK"))

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["pairs"] == 0 and summary["deduped"] == 0
    rows = _rows(repo)
    assert "pend1" in rows                                     # not deleted
    assert rows["post1"]["category"] == "FOOD_AND_DRINK"


# --- no twin / missing key / consume-on-match -------------------------------


def test_posted_with_no_pending_twin_is_untouched(lam, repo):
    _store(lam, repo, _raw_row("post1", pending=False, category="FOOD_AND_DRINK"))

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["pairs"] == 0
    assert _rows(repo)["post1"]["category"] == "FOOD_AND_DRINK"


def test_missing_authorized_date_is_not_matched(lam, repo):
    # authorized_date is the match key; a blank one must not match on amount alone.
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries", authorized_date=""),
           _raw_row("post1", pending=False, category="FOOD_AND_DRINK", authorized_date=""))

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["pairs"] == 0
    assert _pending_count(repo) == 1                           # pending survives


def test_two_posteds_one_pending_consumes_exactly_one(lam, repo):
    # Consume-on-match: two identical posteds, one pending twin -> only one dedups;
    # the other posted finds no pending left and is untouched.
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="FOOD_AND_DRINK"),
           _raw_row("post2", pending=False, category="FOOD_AND_DRINK"))

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["pairs"] == 1 and summary["deduped"] == 1
    assert _pending_count(repo) == 0                           # the one pending consumed
    carried = [v for v in _rows(repo).values() if v["category"] == "groceries"]
    assert len(carried) == 1                                   # exactly one posted carried


# --- idempotency + pagination -----------------------------------------------


def test_rerun_is_a_noop(lam, repo):
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="FOOD_AND_DRINK"))

    first = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)
    second = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert first["deduped"] == 1
    assert second["pairs"] == 0 and second["deduped"] == 0     # nothing left to do


def test_reads_twins_across_pages(lam, repo):
    # The pending sits on a later query page. If get_all_transactions_for_account
    # didn't paginate, the pool would miss it and the twin would go undeduped.
    _store(lam, repo,
           _raw_row("post1", pending=False, category="FOOD_AND_DRINK"),
           _raw_row("filler", pending=False, amount=-99.00, category="X"),
           _raw_row("pend1", pending=True, category="groceries"))
    repo._table.page_size = 2

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["pairs"] == 1 and summary["deduped"] == 1
    assert _rows(repo)["post1"]["category"] == "groceries"


# --- lambda_handler wiring: dry-run by default ------------------------------


def test_lambda_handler_defaults_to_dry_run(lam, repo, monkeypatch):
    # An empty/accidental invoke must NOT mutate.
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="FOOD_AND_DRINK"))
    monkeypatch.setattr(lam.dedupe_cleanup, "TransactionRepository", lambda: repo)

    resp = lam.dedupe_cleanup.lambda_handler({}, None)

    import json
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["dry_run"] is True and body["deduped"] == 0
    assert "pend1" in _rows(repo)                              # untouched


def test_lambda_handler_applies_when_dry_run_false(lam, repo, monkeypatch):
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="FOOD_AND_DRINK"))
    monkeypatch.setattr(lam.dedupe_cleanup, "TransactionRepository", lambda: repo)

    import json
    resp = lam.dedupe_cleanup.lambda_handler({"dry_run": False}, None)
    body = json.loads(resp["body"])

    assert body["dry_run"] is False and body["deduped"] == 1
    assert "pend1" not in _rows(repo)
    assert _rows(repo)["post1"]["category"] == "groceries"
