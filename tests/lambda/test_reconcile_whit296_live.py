"""WHIT-296 — the budget_excluded override survives settlement through the LIVE
reconcile (`insert_or_reconcile`), not just the static `_with_carried_category`
helper the implementer unit-tested (tests/lambda/test_reconcile_whit296.py).

Mirrors test_reconcile.py: rows are built through BankSyncClient.normalise (so the
stored shapes match production) and a FakeTable is injected via repo._table.
budget_excluded is not a bank field (normalise strips it), so — exactly as the
WHIT-275 note/tag reconcile tests do — it's injected directly onto the stored
pending/posted row.

Fail-on-revert anchor: drop "budget_excluded" from the carry tuple in
lambda/repository.py:_with_carried_category and every carry assertion here goes red.
"""

from decimal import Decimal

_BANK_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _bank_row(txn_id, amount, authorized_date="2026-06-29", pending=True,
              category="FOOD_AND_DRINK", date="2026-06-29"):
    return {
        "id": txn_id, "date": date, "authorizedDate": authorized_date,
        "description": "SQ *KKV INTERNATIONAL PTY", "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": amount, "accountId": _BANK_ACCOUNT_ID, "accountName": "ANZ Rewards Black Visa",
        "category": category, "pending": pending, "type": "PAYMENT", "pendingTransactionId": None,
    }


def _norm(lam, **kw):
    return lam.banksync.BankSyncClient.normalise(_bank_row(**kw))


def _acc(txn):
    return "ACCOUNT#" + txn["account_id"]


def test_reconcile_carries_budget_excluded_onto_posted(lam, repo):
    # WHIT-296 — [A-R1] the user marked the PENDING leg as a transfer; on settlement the
    # override must ride onto the new posted row (whose bank feed knows nothing of it),
    # and the stale pending must be deleted.
    pending = _norm(lam, txn_id="A", amount=Decimal("-5.50"), pending=True, category="coffee")
    repo.insert_transactions([pending])
    acc = _acc(pending)
    repo._table.store[(acc, "TXN#A")]["budget_excluded"] = True

    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([posted])

    row = repo._table.store[(acc, "TXN#B")]
    assert row["budget_excluded"] is True            # override carried onto the posted
    assert (acc, "TXN#A") not in repo._table.store   # stale pending removed
    assert len(repo._table.store) == 1               # no duplicate


def test_reconcile_resync_preserves_override_on_existing_posted(lam, repo):
    # WHIT-296 — [A-R2] a plain re-import (no pending twin) of an already-stored posted the
    # user excluded AFTER it settled must keep the override — the read-then-carry branch
    # (repository.py:300). The bank's re-imported row carries no override; the existing
    # one must not be wiped by the recompute.
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False, category="coffee")
    repo.insert_transactions([posted])
    acc = _acc(posted)
    repo._table.store[(acc, "TXN#B")]["budget_excluded"] = True

    reimport = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([reimport])

    row = repo._table.store[(acc, "TXN#B")]
    assert row["budget_excluded"] is True   # survived the re-sync recompute
    assert row["category"] == "coffee"      # (user category still carried too)


def test_reconcile_does_not_carry_a_falsy_override_onto_posted(lam, repo):
    # WHIT-296 — [A-R3] edge: a stored budget_excluded=False on the pending is falsy, so the
    # truthy carry guard skips it — the posted stays absent (not excluded), never storing a
    # read-back-as-excluded value. Mirrors the "cleared note not carried" rule.
    pending = _norm(lam, txn_id="A", amount=Decimal("-5.50"), pending=True, category="coffee")
    repo.insert_transactions([pending])
    acc = _acc(pending)
    repo._table.store[(acc, "TXN#A")]["budget_excluded"] = False  # falsy

    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([posted])

    assert "budget_excluded" not in repo._table.store[(acc, "TXN#B")]
