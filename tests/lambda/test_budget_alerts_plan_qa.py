"""QA for WHIT-624 slice 2: the budget-alert preview (`budget_alerts._simulate_after`)
carries out the SAME `reconcile` plan as the real save. Every test drives the real
preview and, where it matters, the real `insert_or_reconcile` on FakeTable over the
same data — never a hand-copied preview."""

from datetime import date
from decimal import Decimal
from functools import partial

import pytest
from _budget_alert_fakes import notify_repo
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _transaction_range_fakes import _AccountTransactionRepo

_BANK_ACCT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"
_BUDGET = {"groceries": {"target": Decimal("100")}}
_CATS = [{"id": "groceries", "name": "Groceries"}]


@pytest.fixture
def alerts(lam, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2026, 7, 14))  # window 07-01..07-14
    return lam


class _Devices:
    def list_tokens(self):
        return ["ExpoPushToken[a]"]


class _Budgets:
    def list_budgets(self):
        return _BUDGET


_Paycycle = partial(_FakePayCycleRepo, length=14, last_pay_date="2026-07-01")


_Categories = partial(_FakeCategoryRepo, _CATS)


def _norm_real(alerts, *, txn_id, amount, pending, category, date="2026-07-10",
               authorized_date="2026-07-10", merchant_name="SQ *KKV INTERNATIONAL PTY",
               description="SQ *KKV INTERNATIONAL PTY"):
    return alerts.banksync.normalise({
        "id": txn_id, "date": date, "authorizedDate": authorized_date,
        "description": description, "merchantName": merchant_name,
        "amount": amount, "accountId": _BANK_ACCT, "accountName": "ANZ Rewards Black Visa",
        "category": category, "pending": pending, "type": "PAYMENT", "pendingTransactionId": None,
    })


def _seed(repo, alerts, **kw):
    txn = _norm_real(alerts, **kw)
    repo.insert_transactions([txn])
    return txn


def _fire(alerts, monkeypatch, repo, before, batch):
    """capture → real save → fire, exactly as lambda/handler.py orders them."""
    ba = alerts.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push",
                        lambda title, body, toks, data=None: sent.append(title) or {"sent": 1, "ok": 1, "pruned": []})
    notify = notify_repo()
    ctx = ba.capture_pre_write(batch, device_repo=_Devices(), budget_repo=_Budgets(),
                               paycycle_repo=_Paycycle(),
                                   webhook_repo=_AccountTransactionRepo(before, pending_repo=repo))
    repo.insert_or_reconcile(batch)
    ba.fire_budget_alerts(ctx, batch, category_repo=_Categories(), notify_repo=notify)
    return sent, notify, ctx


def _view(rows):
    return {r["transaction_id"]: (r.get("category"), r["amount"], r["date"], r.get("status"),
                                  r.get("notes"), r.get("filed_by_rule"))
            for r in rows}


# [A1] P0 — a re-sent settled charge whose stored row has NO category (still unfiled) but
# arrives carrying a budgeted category. The real save only overwrites bank fields, so the
# ledger stays unfiled → nothing counts toward groceries → no push. The old hand-copied
# preview rebuilt the row from the new charge and counted it (a false "Budget hit").
def test_resend_of_an_unfiled_stored_row_does_not_count_the_incoming_category(alerts, repo, monkeypatch):
    stored = _seed(repo, alerts, txn_id="P1", amount=Decimal("-95"), pending=False, category="groceries")
    row = repo._table.store[next(iter(repo._table.store))]
    row.pop("category")
    before = [dict(row)]
    resend = _norm_real(alerts, txn_id="P1", amount=Decimal("-95"), pending=False, category="groceries")
    assert stored["transaction_id"] == resend["transaction_id"]

    sent, notify, ctx = _fire(alerts, monkeypatch, repo, before, [resend])

    ledger = list(repo._table.store.values())
    assert [r.get("category") for r in ledger] == [None]           # the real save kept it unfiled
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()
    assert _view(alerts.budget_alerts._simulate_after(ctx, [resend])) == _view(ledger)


# [A3] P0 — full-row parity on a mixed batch through the REAL preview: a pending re-sync
# carrying notes + a rule stamp, a first settlement that carries its twin's category, a
# posted re-send, and a plain new charge. Every row's category/amount/date/status/notes/
# stamp in the preview must equal what the real save stored.
def test_preview_rows_equal_the_real_save_on_a_mixed_batch(alerts, repo, monkeypatch):
    resync_stored = _norm_real(alerts, txn_id="RS", amount=Decimal("-9"), pending=True, category="groceries",
                               merchant_name="IGA", description="IGA", date="2026-07-02",
                               authorized_date="2026-07-02")
    resync_stored.update(notes="weekly", filed_by_rule="rule-7")
    twin = _norm_real(alerts, txn_id="TW", amount=Decimal("-20"), pending=True, category="groceries")
    old_posted = _norm_real(alerts, txn_id="OP", amount=Decimal("-5"), pending=False, category="groceries",
                            merchant_name="ALDI", description="ALDI", date="2026-07-03",
                            authorized_date="2026-07-03")
    repo.insert_transactions([resync_stored, twin, old_posted])
    before = [dict(r) for r in repo._table.store.values()]

    batch = [
        _norm_real(alerts, txn_id="RS", amount=Decimal("-11"), pending=True, category="FOOD_AND_DRINK",
                   merchant_name="IGA", description="IGA", date="2026-07-02", authorized_date="2026-07-02"),
        _norm_real(alerts, txn_id="SET", amount=Decimal("-20"), pending=False, category="FOOD_AND_DRINK"),
        _norm_real(alerts, txn_id="OP", amount=Decimal("-6"), pending=False, category="FOOD_AND_DRINK",
                   merchant_name="ALDI", description="ALDI", date="2026-07-04", authorized_date="2026-07-03"),
        _norm_real(alerts, txn_id="NEW", amount=Decimal("-3"), pending=False, category="FOOD_AND_DRINK",
                   merchant_name="BP", description="BP"),
    ]
    _, _, ctx = _fire(alerts, monkeypatch, repo, before, batch)

    ledger = list(repo._table.store.values())
    assert sorted(r["transaction_id"] for r in ledger) == ["NEW", "OP", "RS", "SET"]
    assert _view(alerts.budget_alerts._simulate_after(ctx, batch)) == _view(ledger)
