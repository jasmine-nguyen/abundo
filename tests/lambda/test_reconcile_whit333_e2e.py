"""WHIT-333 — end-to-end proof the refactored blank-auth tier still consumes the
LOWEST-transaction_id candidate through the shared `_select_twin` -> `_pop_lowest_id`
path. Exact/tip/skewed already have dedicated end-to-end tie-break tests
(test_two_same_day_identical_reconciles_exactly_one, test_tip_tie_break_lowest_transaction_id,
test_two_full_column_pendings_only_one_is_consumed_and_it_is_the_lowest_id); blank-auth was
the only tier whose predicate->select->pop chain was not pinned end-to-end.
"""

from decimal import Decimal

_BANK_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _bank_row(txn_id, amount, authorized_date="2026-06-29", pending=True,
              category="FOOD_AND_DRINK", pending_transaction_id=None, date="2026-06-29",
              description="SQ *KKV INTERNATIONAL PTY", merchant_name="SQ *KKV INTERNATIONAL PTY"):
    return {
        "id": txn_id, "date": date, "authorizedDate": authorized_date,
        "description": description, "merchantName": merchant_name, "amount": amount,
        "accountId": _BANK_ACCOUNT_ID, "accountName": "ANZ Rewards Black Visa",
        "category": category, "pending": pending, "type": "PAYMENT",
        "pendingTransactionId": pending_transaction_id,
    }


def _norm(lam, **kw):
    return lam.banksync.BankSyncClient.normalise(_bank_row(**kw))


def _seed_pending(repo, lam, **kw):
    txn = _norm(lam, **kw)
    repo.insert_transactions([txn])
    return txn


def _acc(txn):
    return "ACCOUNT#" + txn["account_id"]


def test_blank_auth_tie_break_consumes_lowest_transaction_id(lam, repo):
    # Two indistinguishable blank-auth pendings (same amount, same >=2-word merchant,
    # same in-window date). Exactly one may die and it must be the lowest id (A1) — the
    # deterministic pick the shared _pop_lowest_id makes for the blank-auth tier.
    _seed_pending(repo, lam, txn_id="A2", amount=Decimal("-5.50"),
                  authorized_date="", pending=True, category="treats")
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A1") not in store              # lowest id consumed via _select_twin
    assert (acc, "TXN#A2") in store                  # the other survives untouched
    assert store[(acc, "TXN#A2")]["category"] == "treats"
    assert store[(acc, "TXN#B")]["category"] == "coffee"   # A1's category carried across
    assert len(store) == 2                                  # exactly one pending consumed
