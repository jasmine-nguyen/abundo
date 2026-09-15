"""WHIT-558 gap: a webhook-rule-set exclusion must SURVIVE settlement.

A pending charge the webhook filer excluded from the budget (budget_excluded=True) settles to a
brand-new posted id. The live reconcile carry (`_with_carried_category`, dedupe_sweep=False) must
carry that flag onto the posted row — otherwise the charge silently re-enters the budget the moment
it settles. Carry of budget_excluded predates WHIT-558 (WHIT-296), but WHIT-558 makes rules the
thing that SETS it on the webhook, so this is now the regression guard for that end-to-end path.

Reuses the same lam/repo fixtures + BankSync.normalise builders as test_reconcile.py.
"""

from decimal import Decimal

_BANK_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _bank_row(txn_id, amount, pending, category, authorized_date="2026-06-29"):
    return {
        "id": txn_id, "date": "2026-06-29", "authorizedDate": authorized_date,
        "description": "SQ *KKV INTERNATIONAL PTY", "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": amount, "accountId": _BANK_ACCOUNT_ID, "accountName": "ANZ Rewards Black Visa",
        "category": category, "pending": pending, "type": "PAYMENT", "pendingTransactionId": None,
    }


def _norm(lam, **kw):
    return lam.banksync.BankSyncClient.normalise(_bank_row(**kw))


def _acc(txn):
    return "ACCOUNT#" + txn["account_id"]


def test_settlement_carries_a_webhook_rule_set_exclusion_onto_the_posted(lam, repo):
    # A rule filed the pending AND kept it out of budget (WHIT-558): the stored pending carries
    # category + budget_excluded=True. FAIL-ON-REVERT: drop "budget_excluded" from the carry loop in
    # _with_carried_category and the settled posted re-enters the budget (flag absent).
    pending = _norm(lam, txn_id="A", amount=Decimal("-5.50"), pending=True, category="coffee")
    repo.insert_transactions([pending])
    acc = _acc(pending)
    repo._table.store[(acc, "TXN#A")]["budget_excluded"] = True
    repo._table.store[(acc, "TXN#A")]["filed_by_rule"] = "rule-coffee"

    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False,
                   category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([posted])

    store = repo._table.store
    assert (acc, "TXN#A") not in store             # stale pending removed
    row = store[(acc, "TXN#B")]
    assert row["category"] == "coffee"             # user/rule category carried
    assert row["budget_excluded"] is True          # …and the exclusion rode along


def test_settlement_does_not_invent_an_exclusion_the_pending_never_had(lam, repo):
    # A pending filed WITHOUT the flag settles: the posted must not sprout budget_excluded from
    # nowhere. Guards against a carry that writes the flag unconditionally.
    pending = _norm(lam, txn_id="A", amount=Decimal("-5.50"), pending=True, category="coffee")
    repo.insert_transactions([pending])
    acc = _acc(pending)

    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False,
                   category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([posted])

    row = repo._table.store[(acc, "TXN#B")]
    assert row["category"] == "coffee"
    assert "budget_excluded" not in row
