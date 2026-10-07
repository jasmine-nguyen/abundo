"""WHIT-793: budget alerts read the cycle window AND the pending pools from one store.

The webhook's own TransactionRepository (over FakeTable) is the only store passed.
Seeded: a posted -20 and a pending -60 twin, both groceries, target $100.
A posted -60 settles the twin → spend 80 → exactly the 80% push.
  window not read through the store → 60 → no push.
  pending pool not read through the store → 140 → "Budget hit" instead.
"""

from datetime import date
from decimal import Decimal

from _budget_alert_fakes import notify_repo
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo

_TODAY = date(2026, 7, 14)
_BANK_ACCT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


class _Budgets:
    def list_budgets(self):
        return {"groceries": {"target": Decimal("100")}}


class _Devices:
    def list_tokens(self):
        return ["ExpoPushToken[a]"]


def _bank_row(txn_id, amount, *, pending, category, pending_transaction_id=None):
    return {
        "id": txn_id, "date": "2026-07-10", "authorizedDate": "2026-07-10",
        "description": "SQ *KKV INTERNATIONAL PTY", "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": Decimal(amount), "accountId": _BANK_ACCT, "accountName": "ANZ Rewards Black Visa",
        "category": category, "pending": pending, "type": "PAYMENT",
        "pendingTransactionId": pending_transaction_id,
    }


def test_alert_fires_reading_window_and_pending_twins_from_the_webhook_store(lam, repo, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: _TODAY)
    normalise = lam.banksync.normalise
    ba = lam.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push", lambda title, body, tokens, data=None:
                        sent.append((title, body)) or {"sent": 1, "ok": 1, "pruned": []})
    repo.insert_transactions([
        normalise(_bank_row("old", "-20", pending=False, category="groceries")),
        normalise(_bank_row("A", "-60", pending=True, category="groceries")),
    ])
    settled = [normalise(_bank_row("B", "-60", pending=False, category="GROCERIES",
                                   pending_transaction_id="A"))]
    notify = notify_repo()

    ctx = ba.capture_pre_write(
        settled,
        device_repo=_Devices(),
        budget_repo=_Budgets(),
        paycycle_repo=_FakePayCycleRepo(length=14, last_pay_date="2026-07-01"),
        webhook_repo=repo,
    )
    ba.fire_budget_alerts(
        ctx, settled,
        category_repo=_FakeCategoryRepo([{"id": "groceries", "name": "Groceries"}]),
        notify_repo=notify,
    )

    assert sent == [("Heads up \U0001f440", "Groceries is at 80% of its budget this cycle.")]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}
