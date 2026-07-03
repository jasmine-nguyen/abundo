"""Tests for pending→posted reconciliation in the BankSync webhook
(`TransactionRepository.insert_or_reconcile`) and its wiring in `process_transaction`.

Real data drives the scenarios: on settlement BankSync issues a NEW id with
`pendingTransactionId: null` (e.g. pending b726e693 → posted 14e463, both
authorizedDate 2026-06-29, -5.50), so a blind insert would leave a duplicate and
lose the user's category. These tests build rows through `BankSyncClient.normalise`
so the stored shapes match production, and inject a FakeTable via `repo._table`.
"""

from decimal import Decimal

# A real BankSync account id (resolves via ACCOUNT_ID_MAP to an internal id).
_BANK_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _bank_row(txn_id, amount, authorized_date="2026-06-29", pending=True,
              category="FOOD_AND_DRINK", pending_transaction_id=None, date="2026-06-29"):
    return {
        "id": txn_id,
        "date": date,
        "authorizedDate": authorized_date,
        "description": "SQ *KKV INTERNATIONAL PTY",
        "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": amount,
        "accountId": _BANK_ACCOUNT_ID,
        "accountName": "ANZ Rewards Black Visa",
        "category": category,
        "pending": pending,
        "type": "PAYMENT",
        "pendingTransactionId": pending_transaction_id,
    }


def _norm(lam, **kw):
    return lam.banksync.BankSyncClient.normalise(_bank_row(**kw))


def _seed_pending(repo, lam, **kw):
    """Store a (typically already user-categorised) transaction and return it."""
    txn = _norm(lam, **kw)
    repo.insert_transactions([txn])
    return txn


def _acc(txn):
    return "ACCOUNT#" + txn["account_id"]


# --- the core bug: pending→posted with a new id -----------------------------


def test_reconcile_carries_category_and_deletes_pending(lam, repo):
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert store[(acc, "TXN#B")]["category"] == "coffee"   # carried onto the posted row
    assert (acc, "TXN#A") not in store                      # stale pending removed
    assert len(store) == 1                                   # no duplicate


def test_no_match_inserts_posted_normally(lam, repo):
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    assert store[(_acc(posted), "TXN#B")]["category"] == "FOOD_AND_DRINK"
    assert len(store) == 1


def test_same_id_resync_preserves_user_category(lam, repo):
    # A posted row already stored + user-categorised.
    _seed_pending(repo, lam, txn_id="B", amount=Decimal("-5.50"),
                  pending=False, category="Groceries")
    # The same posted id re-syncs with the bank's raw category.
    resync = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([resync])

    store = repo._table.store
    assert store[(_acc(resync), "TXN#B")]["category"] == "Groceries"  # not clobbered
    assert len(store) == 1                                             # not duplicated/deleted


# --- accepted edges (documented behaviour) ----------------------------------


def test_amount_change_misses_and_leaves_both(lam, repo):
    # Amount changes on settlement (tip/FX) → heuristic misses → duplicate persists.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-6.00"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store                                    # pending survives
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"      # no carry


def test_empty_authorized_date_does_not_match(lam, repo):
    # Missing authorizedDate is not a match key → no false-positive reconcile.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"


# --- same-day identical purchases (Jasmine's daily coffee) -------------------


def test_two_same_day_identical_reconciles_exactly_one(lam, repo):
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    _seed_pending(repo, lam, txn_id="A2", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    # consume-on-match: exactly one pending consumed; deterministic (lowest id A1).
    assert (acc, "TXN#A1") not in store
    assert (acc, "TXN#A2") in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"


# --- forward-compat: pendingTransactionId exact link ------------------------


def test_exact_pending_transaction_id_link(lam, repo):
    # authorized_date AND amount differ, so the heuristic would NOT match — only the
    # explicit link does. Proves the exact path works the day BankSync populates it.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-6.00"), authorized_date="2026-07-02",
                   pending=False, category="FOOD_AND_DRINK", pending_transaction_id="A")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"


def test_bogus_link_falls_through_to_heuristic(lam, repo):
    # A pending_transaction_id that isn't a stored pending must NOT crash or fabricate
    # a key — it falls through to the heuristic, which matches here.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), authorized_date="2026-06-29",
                   pending=False, category="FOOD_AND_DRINK", pending_transaction_id="ghost")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"


# --- batch behaviour --------------------------------------------------------


def test_batch_mix_reconciles_and_queries_once_per_account(lam, repo):
    _seed_pending(repo, lam, txn_id="P", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    repo._table.query_calls = 0

    batch = [
        _norm(lam, txn_id="C", amount=Decimal("-9.00"),
              authorized_date="2026-07-01", pending=True, category="FOOD_AND_DRINK"),   # new pending
        _norm(lam, txn_id="B", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),  # settles P
        _norm(lam, txn_id="D", amount=Decimal("-3.00"),
              authorized_date="2026-07-02", pending=False, category="FOOD_AND_DRINK"),  # no match
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert (acc, "TXN#C") in store                                   # new pending inserted
    assert (acc, "TXN#P") not in store                               # settled + deleted
    assert store[(acc, "TXN#B")]["category"] == "coffee"
    assert (acc, "TXN#D") in store                                   # unmatched posted inserted
    assert repo._table.query_calls == 1                              # pending pool fetched once


# --- handler wiring ---------------------------------------------------------


def test_process_transaction_uses_insert_or_reconcile(lam):
    calls = {}

    class FakeRepo:
        def save_failed_transactions(self, rows):
            calls["failed"] = rows

        def insert_or_reconcile(self, txns):
            calls["reconcile"] = txns

        def insert_transactions(self, txns):
            calls["insert"] = txns

    bad_row = {"id": "X", "accountId": "unknown-account"}  # missing fields -> unmapped
    payload = {"data": [_bank_row("A", Decimal("-5.50"), pending=False), bad_row]}

    lam.handler.process_transaction(payload, FakeRepo())

    assert "reconcile" in calls and "insert" not in calls   # swapped to the new path
    assert len(calls["reconcile"]) == 1                      # the one good row normalised
    assert calls["failed"] == [bad_row]                      # the bad row diverted


# --- consume-on-match across a batch (locks the pool.pop) --------------------


def test_two_posted_consume_two_identical_pendings_in_one_batch(lam, repo):
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    _seed_pending(repo, lam, txn_id="A2", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    batch = [
        _norm(lam, txn_id="B", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="C", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    # Each posted popped a DISTINCT pending — both consumed, both posted carry the tag.
    assert (acc, "TXN#A1") not in store
    assert (acc, "TXN#A2") not in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"
    assert store[(acc, "TXN#C")]["category"] == "coffee"
    assert len(store) == 2  # only the two posted rows remain


def test_consume_on_match_pool_exhausts(lam, repo):
    # One pending, two posted twins in the batch: the FIRST consumes it, the second
    # finds an empty pool and falls through to a plain insert. Without pool.pop, the
    # second would also match the pending and wrongly carry "coffee".
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    batch = [
        _norm(lam, txn_id="B", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="C", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert (acc, "TXN#A1") not in store                              # consumed by B
    assert store[(acc, "TXN#B")]["category"] == "coffee"
    assert store[(acc, "TXN#C")]["category"] == "FOOD_AND_DRINK"     # no twin left -> plain insert


# --- small edge coverage ----------------------------------------------------


def test_empty_batch_is_a_noop(lam, repo):
    repo.insert_or_reconcile([])
    assert repo._table.store == {}
    assert repo._table.query_calls == 0


def test_matched_pending_without_category_still_dedupes(lam, repo):
    # An uncategorised pending (falsy category) still gets reconciled/de-duped; the
    # posted keeps its own (bank) category rather than carrying an empty one.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store                          # stale pending removed
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"  # empty not carried
