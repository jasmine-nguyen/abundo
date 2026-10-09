"""Tests for the dead-letter recovery sweep (WHIT-55, lambda/reprocess.py).

`reprocess_failed(repo)` re-drives every FAILED# row through normalise +
insert_or_reconcile and deletes it ONLY after a durable insert. A poison row is
skipped (left in place), never crashing the sweep. Rows are built through the real
`save_failed_transactions` write path (or written directly for malformed cases) and
run against the FakeTable-backed `repo` fixture.
"""

import json

import pytest

# _failed_keys / _txn_rows live in tests/shared/_deadletter_fakes.py so both dead-letter
# recovery suites share ONE definition (WHIT-494); resolved via pytest.ini's pythonpath.
from _deadletter_fakes import _failed_keys, _txn_rows
from _feed_fakes import FakeCategoryRepo
from _rule_ingest_fakes import KKV_RULE, FakeRuleStore, reprocess_failed

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


def _txn_keys(repo):
    return [k for k in repo._table.store if k[0].startswith("ACCOUNT#")]


# --- happy path -------------------------------------------------------------


def test_reprocess_recovers_and_deletes_the_failed_row(lam, repo):
    repo.save_failed_transactions([_raw_row(txn_id="r1")])
    assert len(_failed_keys(repo)) == 1

    summary = reprocess_failed(lam.reprocess, repo)

    assert summary == {"reprocessed": 1, "skipped": 0, "errors": 0, "dropped_zero": 0}
    # The transaction is now stored under its ACCOUNT#/TXN# keys...
    assert any(k[1] == "TXN#r1" for k in _txn_keys(repo))
    # ...and the dead-letter row is gone.
    assert _failed_keys(repo) == []


# --- rows that still cannot process are LEFT in place ------------------------


def test_reprocess_recovers_a_row_missing_its_category(lam, repo):
    # The real stuck case: a FAILED row whose raw payload has NO category key used to be
    # skipped on every sweep (normalise raised KeyError). Now normalise stores it
    # uncategorised, the insert lands, and the dead-letter is deleted -- so the sweep
    # RECOVERS it instead of leaving it stuck until it expires. (This is the ANZ
    # "Inner View Psych" charge.) A revert reintroduces the KeyError -> skipped=1.
    raw = _raw_row(txn_id="nocat")
    del raw["category"]
    repo.save_failed_transactions([raw])

    summary = reprocess_failed(lam.reprocess, repo)

    assert summary == {"reprocessed": 1, "skipped": 0, "errors": 0, "dropped_zero": 0}
    assert any(k[1] == "TXN#nocat" for k in _txn_keys(repo))
    assert _failed_keys(repo) == []


def test_still_unmapped_account_is_skipped_and_survives(lam, repo):
    # accountId not in ACCOUNT_ID_MAP -> normalise raises UnknownAccountError -> skip.
    repo.save_failed_transactions([_raw_row(account_id="not-a-real-account")])

    summary = reprocess_failed(lam.reprocess, repo)

    assert summary == {"reprocessed": 0, "skipped": 1, "errors": 0, "dropped_zero": 0}
    assert len(_failed_keys(repo)) == 1          # survives for a later run
    assert _txn_keys(repo) == []                 # nothing inserted


@pytest.mark.parametrize("raw", [
    "{not json",                         # not valid JSON
    json.dumps("hello"),                 # valid JSON, but not a row dict -> TypeError
    json.dumps(_raw_row(amount=None)),   # a null amount breaks normalise deep (InvalidOperation)
], ids=["malformed-json", "non-dict", "bad-amount"])
def test_an_unrecoverable_row_is_skipped_and_kept(lam, repo, raw):
    # A poison row can never be recovered: it is skipped and left in place, never
    # crashing the sweep.
    repo._table.store[("FAILED", "poison")] = {"pk": "FAILED", "sk": "poison", "raw": raw}

    summary = reprocess_failed(lam.reprocess, repo)

    assert summary == {"reprocessed": 0, "skipped": 1, "errors": 0, "dropped_zero": 0}
    assert ("FAILED", "poison") in repo._table.store
    assert _txn_keys(repo) == []


# --- delete only after a durable insert -------------------------------------


def test_insert_failure_leaves_failed_row_and_counts_error(lam, repo, monkeypatch):
    # If the insert raises (a DB error), the FAILED row must NOT be deleted — recovery
    # is retried next run — and it's counted as an error, not reprocessed.
    repo.save_failed_transactions([_raw_row(txn_id="r1")])

    def boom(_txns):
        raise RuntimeError("dynamo down")

    monkeypatch.setattr(repo, "insert_or_reconcile", boom)

    summary = reprocess_failed(lam.reprocess, repo)

    assert summary == {"reprocessed": 0, "skipped": 0, "errors": 1, "dropped_zero": 0}
    assert len(_failed_keys(repo)) == 1                 # NOT deleted
    assert _txn_keys(repo) == []


# --- WHIT-55 adversarial gaps (QA) ------------------------------------------


def test_get_failed_transactions_error_propagates(lam, repo, monkeypatch):
    # The top-level scan is intentionally OUTSIDE the per-row try/except: a table read
    # failure must surface (Lambda errors, CloudWatch shows it), never return a clean
    # 200 summary that hides that the backlog was never read.
    def boom():
        raise RuntimeError("dynamo query failed")

    monkeypatch.setattr(repo, "get_failed_transactions", boom)

    with pytest.raises(RuntimeError, match="dynamo query failed"):
        reprocess_failed(lam.reprocess, repo)


def test_delete_failure_after_insert_counts_error_and_rerun_is_safe(lam, repo, monkeypatch):
    # Insert lands durably, but deleting the dead-letter raises. The row is counted as
    # `errors` (NOT reprocessed) and left in place -- yet the transaction IS committed.
    # A later run must re-sync (no duplicate) and clean the dead-letter up.
    repo.save_failed_transactions([_raw_row(txn_id="r1")])

    def boom(_sk):
        raise RuntimeError("delete threw")

    monkeypatch.setattr(repo, "delete_failed_transaction", boom)
    first = reprocess_failed(lam.reprocess, repo)

    assert first == {"reprocessed": 0, "skipped": 0, "errors": 1, "dropped_zero": 0}
    assert any(k == "TXN#r1" for k in _txn_rows(repo))  # insert DID land
    assert len(_failed_keys(repo)) == 1                          # dead-letter NOT deleted

    monkeypatch.undo()
    second = reprocess_failed(lam.reprocess, repo)

    assert second == {"reprocessed": 1, "skipped": 0, "errors": 0, "dropped_zero": 0}
    assert len([k for k in _txn_rows(repo) if k == "TXN#r1"]) == 1
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

    summary = reprocess_failed(lam.reprocess, repo)

    assert summary == {"reprocessed": 2, "skipped": 3, "errors": 0, "dropped_zero": 0}
    assert summary["reprocessed"] + summary["skipped"] + summary["errors"] == 5
    stored = _txn_rows(repo)
    assert "TXN#ok0" in stored and "TXN#ok1" in stored   # both recovered across pages
    assert len(_failed_keys(repo)) == 3                  # only recoverable rows deleted


def test_lambda_handler_serialises_the_real_summary(lam, repo, monkeypatch):
    # Runs reprocess_failed for REAL against the fake table, so json.loads on the body
    # proves the body is genuine JSON.
    repo.save_failed_transactions([_raw_row(txn_id="r1")])
    monkeypatch.setattr(lam.reprocess, "TransactionRepository", lambda: repo)

    resp = lam.reprocess.lambda_handler({"ignored": True}, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"reprocessed": 1, "skipped": 0, "errors": 0, "dropped_zero": 0}
    assert _failed_keys(repo) == []


# --- rule filing on re-drive ---------------------------------------------------


def test_reprocess_with_an_unreadable_rule_book_still_recovers_every_row_unfiled(lam, repo):
    # load_rules returns None on a read failure; reprocess must not touch book.is_unfiled
    # or file its charges then. FAIL-ON-REVERT: drop the `if book is not None` guard on is_unfiled
    # (or on the filing) and the sweep crashes with AttributeError on None.
    repo.save_failed_transactions([_raw_row(txn_id="r1"), _raw_row(txn_id="r2")])

    summary = lam.reprocess.reprocess_failed(
        repo, rule_repo=FakeRuleStore(error=True), category_repo=FakeCategoryRepo(["groceries"]))

    assert summary == {"reprocessed": 2, "skipped": 0, "errors": 0, "dropped_zero": 0}
    rows = _txn_rows(repo)
    assert rows["TXN#r1"]["category"] == "FOOD_AND_DRINK"
    assert rows["TXN#r2"]["category"] == "FOOD_AND_DRINK"
    assert _failed_keys(repo) == []


# --- WHIT-545: reprocess threads the taxonomy check into the settlement carry --------------

def test_whit545_reprocess_threads_is_unfiled_so_a_rule_fill_survives_settlement(lam, repo):
    # A dead-letter posted row re-driven with rule stores is rule-filled to "groceries" and then
    # settles onto a pending twin holding the bank's raw enum. reprocess must pass the book's
    # is_unfiled into insert_or_reconcile so the raw enum can't clobber the rule-fill.
    # FAIL-ON-REVERT: change reprocess.py to is_unfiled=None and the twin's raw enum wins.
    pending = lam.banksync.normalise(
        _raw_row(txn_id="PEND", amount=-5.50, pending=True, category="FOOD_AND_DRINK"))
    repo.insert_transactions([pending])
    repo.save_failed_transactions([_raw_row(txn_id="POST", amount=-5.50, pending=False,
                                            category="FOOD_AND_DRINK")])

    summary = lam.reprocess.reprocess_failed(
        repo,
        rule_repo=FakeRuleStore([KKV_RULE]),
        category_repo=FakeCategoryRepo(["groceries"]))

    assert summary["reprocessed"] == 1
    rows = _txn_rows(repo)
    assert rows["TXN#POST"]["category"] == "groceries"     # rule-fill kept; unfiled twin gated
    assert "TXN#PEND" not in rows                           # stale pending twin reaped
