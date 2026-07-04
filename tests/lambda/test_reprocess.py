"""Tests for the dead-letter recovery sweep (WHIT-55, lambda/reprocess.py).

`reprocess_failed(repo)` re-drives every FAILED# row through normalise +
insert_or_reconcile and deletes it ONLY after a durable insert. A poison row is
skipped (left in place), never crashing the sweep. Rows are built through the real
`save_failed_transactions` write path (or written directly for malformed cases) and
run against the FakeTable-backed `repo` fixture.
"""

import json

import pytest

# A real BankSync account id that resolves via ACCOUNT_ID_MAP to an internal id.
_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _raw_row(txn_id="r1", account_id=_MAPPED_ACCOUNT, amount=-5.50, pending=False,
             category="FOOD_AND_DRINK"):
    """A raw BankSync row (pre-normalise) — the shape stored inside a FAILED row's
    `raw` blob."""
    return {
        "id": txn_id,
        "date": "2026-06-29",
        "authorizedDate": "2026-06-29",
        "description": "SQ *KKV INTERNATIONAL PTY",
        "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": amount,
        "accountId": account_id,
        "accountName": "ANZ Rewards Black Visa",
        "category": category,
        "pending": pending,
        "type": "PAYMENT",
        "pendingTransactionId": None,
    }


def _failed_keys(repo):
    return [k for k in repo._table.store if k[0] == "FAILED"]


def _txn_keys(repo):
    return [k for k in repo._table.store if k[0].startswith("ACCOUNT#")]


# --- happy path -------------------------------------------------------------


def test_reprocess_recovers_and_deletes_the_failed_row(lam, repo):
    repo.save_failed_transactions([_raw_row(txn_id="r1")])
    assert len(_failed_keys(repo)) == 1

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 1, "skipped": 0, "errors": 0}
    # The transaction is now stored under its ACCOUNT#/TXN# keys...
    assert any(k[1] == "TXN#r1" for k in _txn_keys(repo))
    # ...and the dead-letter row is gone.
    assert _failed_keys(repo) == []


# --- rows that still cannot process are LEFT in place ------------------------


def test_still_unmapped_account_is_skipped_and_survives(lam, repo):
    # accountId not in ACCOUNT_ID_MAP -> normalise raises UnknownAccountError -> skip.
    repo.save_failed_transactions([_raw_row(account_id="not-a-real-account")])

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 0, "skipped": 1, "errors": 0}
    assert len(_failed_keys(repo)) == 1          # survives for a later run
    assert _txn_keys(repo) == []                 # nothing inserted


def test_malformed_raw_json_is_skipped_not_deleted(lam, repo):
    # A FAILED row whose `raw` isn't valid JSON can never be recovered -> skip, keep.
    repo._table.store[("FAILED", "bad-json")] = {"pk": "FAILED", "sk": "bad-json", "raw": "{not json"}

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 0, "skipped": 1, "errors": 0}
    assert ("FAILED", "bad-json") in repo._table.store


def test_poison_raw_bad_amount_is_skipped_not_a_crash(lam, repo):
    # A row that parses fine but breaks normalise DEEP (a null amount -> Decimal(str(None))
    # raises decimal.InvalidOperation, which is neither UnknownAccountError nor KeyError).
    # It must be skipped, NOT abort the sweep — the account is mapped, so the failure
    # is only reached now, on re-normalise.
    repo.save_failed_transactions([_raw_row(amount=None)])

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 0, "skipped": 1, "errors": 0}
    assert len(_failed_keys(repo)) == 1
    assert _txn_keys(repo) == []


def test_raw_that_parses_to_non_dict_is_skipped(lam, repo):
    # `raw` is valid JSON but a string, not a row dict -> normalise indexing raises
    # TypeError -> broad catch skips it, sweep continues.
    repo._table.store[("FAILED", "not-a-dict")] = {"pk": "FAILED", "sk": "not-a-dict", "raw": json.dumps("hello")}

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 0, "skipped": 1, "errors": 0}
    assert ("FAILED", "not-a-dict") in repo._table.store


# --- empty / pagination / idempotency ---------------------------------------


def test_empty_failed_partition_is_a_noop(lam, repo):
    summary = lam.reprocess.reprocess_failed(repo)
    assert summary == {"reprocessed": 0, "skipped": 0, "errors": 0}
    assert repo._table.store == {}


def test_reprocess_reads_across_pages(lam, repo):
    # Three FAILED rows with the FakeTable forced to 2-per-page: all three must be
    # read + reprocessed (a single-page read would leave the third behind).
    for i in range(3):
        repo.save_failed_transactions([_raw_row(txn_id=f"r{i}")])
    repo._table.page_size = 2

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 3, "skipped": 0, "errors": 0}
    assert _failed_keys(repo) == []
    assert {k[1] for k in _txn_keys(repo)} == {"TXN#r0", "TXN#r1", "TXN#r2"}


def test_reprocess_is_idempotent_on_rerun(lam, repo):
    repo.save_failed_transactions([_raw_row(txn_id="r1")])

    first = lam.reprocess.reprocess_failed(repo)
    second = lam.reprocess.reprocess_failed(repo)

    assert first == {"reprocessed": 1, "skipped": 0, "errors": 0}
    assert second == {"reprocessed": 0, "skipped": 0, "errors": 0}   # nothing left to do
    # The transaction still exists exactly once; no duplicate, no error.
    assert len([k for k in _txn_keys(repo) if k[1] == "TXN#r1"]) == 1


# --- mixed batch + counters sum ---------------------------------------------


def test_mixed_batch_only_recoverable_row_is_deleted(lam, repo):
    repo.save_failed_transactions([_raw_row(txn_id="ok")])                       # recoverable
    repo.save_failed_transactions([_raw_row(account_id="nope")])                 # still unmapped
    repo._table.store[("FAILED", "junk")] = {"pk": "FAILED", "sk": "junk", "raw": "{"}  # malformed

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 1, "skipped": 2, "errors": 0}
    # counters account for every scanned row
    assert summary["reprocessed"] + summary["skipped"] + summary["errors"] == 3
    assert len(_failed_keys(repo)) == 2                 # the two un-recoverable rows remain
    assert any(k[1] == "TXN#ok" for k in _txn_keys(repo))


# --- delete only after a durable insert -------------------------------------


def test_insert_failure_leaves_failed_row_and_counts_error(lam, repo, monkeypatch):
    # If the insert raises (a DB error), the FAILED row must NOT be deleted — recovery
    # is retried next run — and it's counted as an error, not reprocessed.
    repo.save_failed_transactions([_raw_row(txn_id="r1")])

    def boom(_txns):
        raise RuntimeError("dynamo down")

    monkeypatch.setattr(repo, "insert_or_reconcile", boom)

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 0, "skipped": 0, "errors": 1}
    assert len(_failed_keys(repo)) == 1                 # NOT deleted
    assert _txn_keys(repo) == []


# --- lambda_handler wiring ---------------------------------------------------


def test_lambda_handler_runs_the_sweep_and_returns_the_summary(lam, monkeypatch):
    monkeypatch.setattr(lam.reprocess, "TransactionRepository", lambda: object())
    monkeypatch.setattr(lam.reprocess, "reprocess_failed",
                        lambda repo: {"reprocessed": 2, "skipped": 1, "errors": 0})

    resp = lam.reprocess.lambda_handler({}, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"reprocessed": 2, "skipped": 1, "errors": 0}


# --- WHIT-55 adversarial gaps (QA) ------------------------------------------
# Edges beyond the happy/skip/error cases above: the flagged pending-duplicate
# resurrection, user-category preservation on re-drive, scan-error propagation,
# delete-fails-after-insert (committed + re-run safe), multi-page + mixed, and the
# REAL summary serialising through lambda_handler.


def _internal_txn_rows(repo):
    """All stored ACCOUNT#/TXN# rows as a {sk: item} map (account-id agnostic)."""
    return {k[1]: v for k, v in repo._table.store.items() if k[0].startswith("ACCOUNT#")}


def test_pending_dead_letter_resurrects_a_duplicate_alongside_existing_posted(lam, repo):
    # KNOWN LIMITATION pinned: the posted version already synced + is stored; its
    # pending twin was stuck in the dead-letter. Reprocess re-drives the pending, which
    # insert_or_reconcile inserts AS-IS (pending rows never reconcile against an
    # already-stored posted), so a duplicate pending is resurrected and the dead-letter
    # IS deleted. Pin the ACTUAL behaviour so any change to it is deliberate.
    posted = lam.banksync.BankSyncClient.normalise(_raw_row(txn_id="posted1", pending=False, amount=-5.50))
    repo.insert_transactions([posted])
    repo.save_failed_transactions([_raw_row(txn_id="pend1", pending=True, amount=-5.50)])

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 1, "skipped": 0, "errors": 0}
    stored = _internal_txn_rows(repo)
    assert "TXN#posted1" in stored and "TXN#pend1" in stored
    assert stored["TXN#pend1"]["status"] == "pending"
    assert _failed_keys(repo) == []


def test_reprocess_does_not_clobber_user_category_on_stored_posted_twin(lam, repo):
    # Money-safety: the posted txn is already stored with a user-picked category; its
    # FAILED row (same id) carries the bank's raw category. Re-driving must carry the
    # user's category onto the re-insert, not overwrite it.
    stored_posted = lam.banksync.BankSyncClient.normalise(
        _raw_row(txn_id="p1", pending=False, category="GENERAL_MERCHANDISE"))
    stored_posted["category"] = "USER_PICKED"
    repo.insert_transactions([stored_posted])
    repo.save_failed_transactions([_raw_row(txn_id="p1", pending=False, category="FOOD_AND_DRINK")])

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 1, "skipped": 0, "errors": 0}
    rows = [v for k, v in _internal_txn_rows(repo).items() if k == "TXN#p1"]
    assert len(rows) == 1                          # no duplicate
    assert rows[0]["category"] == "USER_PICKED"    # user category survived the re-drive
    assert _failed_keys(repo) == []


def test_get_failed_transactions_error_propagates(lam, repo, monkeypatch):
    # The top-level scan is intentionally OUTSIDE the per-row try/except: a table read
    # failure must surface (Lambda errors, CloudWatch shows it), never return a clean
    # 200 summary that hides that the backlog was never read.
    def boom():
        raise RuntimeError("dynamo query failed")

    monkeypatch.setattr(repo, "get_failed_transactions", boom)

    with pytest.raises(RuntimeError, match="dynamo query failed"):
        lam.reprocess.reprocess_failed(repo)


def test_delete_failure_after_insert_counts_error_and_rerun_is_safe(lam, repo, monkeypatch):
    # Insert lands durably, but deleting the dead-letter raises. The row is counted as
    # `errors` (NOT reprocessed) and left in place -- yet the transaction IS committed.
    # A later run must re-sync (no duplicate) and clean the dead-letter up.
    repo.save_failed_transactions([_raw_row(txn_id="r1")])

    def boom(_sk):
        raise RuntimeError("delete threw")

    monkeypatch.setattr(repo, "delete_failed_transaction", boom)
    first = lam.reprocess.reprocess_failed(repo)

    assert first == {"reprocessed": 0, "skipped": 0, "errors": 1}
    assert any(k == "TXN#r1" for k in _internal_txn_rows(repo))  # insert DID land
    assert len(_failed_keys(repo)) == 1                          # dead-letter NOT deleted

    monkeypatch.undo()
    second = lam.reprocess.reprocess_failed(repo)

    assert second == {"reprocessed": 1, "skipped": 0, "errors": 0}
    assert len([k for k in _internal_txn_rows(repo) if k == "TXN#r1"]) == 1
    assert _failed_keys(repo) == []


def test_multi_page_backlog_with_mixed_outcomes(lam, repo):
    # 5 dead-letter rows, forced to 2-per-page, with the two RECOVERABLE rows on later
    # pages. If pagination broke (only first page read) reprocessed would be < 2.
    repo.save_failed_transactions([_raw_row(account_id="nope", txn_id="u0")])
    repo.save_failed_transactions([_raw_row(account_id="nope", txn_id="u1")])
    repo._table.store[("FAILED", "poison")] = {"pk": "FAILED", "sk": "poison", "raw": "{"}
    repo.save_failed_transactions([_raw_row(txn_id="ok0")])
    repo.save_failed_transactions([_raw_row(txn_id="ok1")])
    repo._table.page_size = 2

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 2, "skipped": 3, "errors": 0}
    assert summary["reprocessed"] + summary["skipped"] + summary["errors"] == 5
    stored = _internal_txn_rows(repo)
    assert "TXN#ok0" in stored and "TXN#ok1" in stored   # both recovered across pages
    assert len(_failed_keys(repo)) == 3                  # only recoverable rows deleted


def test_lambda_handler_serialises_the_real_summary(lam, repo, monkeypatch):
    # The handler test above stubs reprocess_failed; this runs it for REAL against the
    # fake table, so json.loads on the body proves the body is genuine JSON.
    repo.save_failed_transactions([_raw_row(txn_id="r1")])
    monkeypatch.setattr(lam.reprocess, "TransactionRepository", lambda: repo)

    resp = lam.reprocess.lambda_handler({"ignored": True}, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"reprocessed": 1, "skipped": 0, "errors": 0}
    assert _failed_keys(repo) == []
