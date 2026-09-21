"""WHIT-450 — the KEPT on-ingest reconcile is a DIFFERENT path from the deleted batch job.

WHIT-450 deleted the one-time `dedupe_cleanup` job and the shared
`TransactionRepository.get_all_transactions_for_account` it (alone) read. The LIVE webhook
dedupe — `insert_or_reconcile` carrying a user's category onto the settled twin and deleting
the stale pending — is a SEPARATE code path that loads pending rows via the KEPT
`get_pending_transactions_for_account`. `test_retired_jobs_removed.py` proves the batch helper
is gone; nothing proves the live path still wires through its OWN (kept) loader and is undisturbed.

Forward regression guard (the deleted code is gone, so there is nothing to revert-to-red on the
removal itself). Red-green here is on the KEPT wiring: breaking `_ensure_pool` so it no longer
calls `get_pending_transactions_for_account` reddens both the spy count AND the carry/delete.
Reuses the webhook suite's `lam` + `repo` fixtures (tests/lambda/conftest.py).
"""
from decimal import Decimal

_BANK_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _bank_row(txn_id, amount, pending, category, authorized_date="2026-06-29", date="2026-06-29"):
    return {
        "id": txn_id, "date": date, "authorizedDate": authorized_date,
        "description": "SQ *KKV INTERNATIONAL PTY", "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": amount, "accountId": _BANK_ACCOUNT_ID, "accountName": "ANZ Rewards Black Visa",
        "category": category, "pending": pending, "type": "PAYMENT", "pendingTransactionId": None,
    }


def _norm(lam, **kw):
    return lam.banksync.BankSyncClient.normalise(_bank_row(**kw))


def test_deleted_batch_helper_is_not_reachable_via_the_live_reconcile(lam, repo, monkeypatch):
    # [GAP-W1] The live reconcile loads its pending pool ONLY through the kept
    # get_pending_transactions_for_account. Spy proves the deleted all-rows helper is never
    # what the live path leans on, and the end-to-end carry+delete still happens.
    seen = {"pending_loader": 0}
    real_loader = repo.get_pending_transactions_for_account

    def spy_loader(account_id):
        seen["pending_loader"] += 1
        return real_loader(account_id)

    monkeypatch.setattr(repo, "get_pending_transactions_for_account", spy_loader)
    # The deleted helper must not exist to be called at all.
    assert not hasattr(repo, "get_all_transactions_for_account")

    repo.insert_transactions([_norm(lam, txn_id="A", amount=Decimal("-5.50"),
                                    pending=True, category="coffee")])
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    acc = "ACCOUNT#" + posted["account_id"]
    store = repo._table.store
    assert seen["pending_loader"] >= 1                     # live path used the KEPT loader
    assert store[(acc, "TXN#B")]["category"] == "coffee"   # category carried across settlement
    assert (acc, "TXN#A") not in store                      # stale pending removed on ingest
    assert len(store) == 1                                   # no duplicate left behind


def test_reprocess_dead_letter_reader_neighbour_survived_the_deletion(lam, repo):
    # [GAP-W2] The deleted get_all_transactions_for_account sat between two kept paginated
    # readers. get_failed_transactions (the method immediately AFTER it, driving the kept
    # reprocess sweep) must still exist and read the FAILED partition — proof the deletion
    # clipped the middle method, not a neighbour.
    assert hasattr(repo, "get_failed_transactions")
    repo._table.store[("FAILED", "TXN#x")] = {
        "pk": "FAILED", "sk": "TXN#x", "transaction_id": "x", "status": "posted"}
    failed = repo.get_failed_transactions()
    assert [t["transaction_id"] for t in failed] == ["x"]
