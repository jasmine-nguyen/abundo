"""WHIT-607 QA — the budget alerts' window read must widen back to the rollover history.

The shared _AccountTransactionRepo honours the date range like the real date-index query
and records every request, so these tests can tell whether capture_pre_write asks for
[cycle start, today] or the wider rollover window.
"""

from datetime import date
from decimal import Decimal
from functools import partial

from _budget_alert_fakes import notify_repo
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _transaction_range_fakes import _AccountTransactionRepo

_TODAY = date(2026, 7, 14)
_ACCT = "up-spending"
_CATS = [{"id": "groceries", "name": "Groceries", "bucket": "Living"}]


def _txn(txn_id, amount, day):
    return {
        "transaction_id": txn_id, "account_id": _ACCT, "category": "groceries",
        "amount": Decimal(str(amount)), "status": "posted", "date": day,
        "counts_to_budget": True, "authorized_date": day,
    }


class _Devices:
    def list_tokens(self):
        return ["ExpoPushToken[a]"]


class _Budgets:
    def __init__(self, budgets):
        self.budgets = budgets

    def list_budgets(self):
        return self.budgets


_Paycycle = partial(_FakePayCycleRepo, length=14, last_pay_date="2026-07-01")


_Categories = partial(_FakeCategoryRepo, _CATS)


def _fire(lam, monkeypatch, budget, stored, new):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: _TODAY)
    ba = lam.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push", lambda title, body, toks, data=None: (
        sent.append(body) or {"sent": 1, "ok": 1, "pruned": []}))
    store = _AccountTransactionRepo(stored)
    ctx = ba.capture_pre_write(
        [new], device_repo=_Devices(), budget_repo=_Budgets({"groceries": budget}),
        paycycle_repo=_Paycycle(), webhook_repo=store,
    )
    ba.fire_budget_alerts(ctx, [new], category_repo=_Categories(),
                          notify_repo=notify_repo())
    return sent, store


def test_rollover_alert_reads_back_to_the_first_unsealed_cycle(lam, monkeypatch):
    # [A8] carryover_from 2026-06-17 → the read starts there, not at the cycle start
    # 2026-07-01. Prior cycle spent $60 of $100 → $40 leftover → basis $140, 80% = $112.
    # $105 + $10 = $115 → the 80% push, not "Budget hit" (which a $100 basis would give).
    budget = {
        "target": Decimal("100"), "rollover": True, "carryover": Decimal("0"),
        "carryover_from": "2026-06-17",
        "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
    }
    stored = [_txn("prior1", -60, "2026-06-20"), _txn("old", -105, "2026-07-10")]
    sent, store = _fire(lam, monkeypatch, budget, stored, _txn("new1", -10, "2026-07-11"))

    assert {c[1] for c in store.calls} == {"2026-06-17"}
    assert {c[2] for c in store.calls} == {"2026-07-14"}
    assert len(sent) == 1
    assert "80%" in sent[0]


def test_plain_budget_alert_reads_only_the_current_cycle(lam, monkeypatch):
    # [A9] no rollover target → the read covers exactly [cycle start, today] on every account.
    import constants

    budget = {"target": Decimal("100")}
    stored = [_txn("prior1", -500, "2026-06-20"), _txn("old", -70, "2026-07-10")]
    sent, store = _fire(lam, monkeypatch, budget, stored, _txn("new1", -15, "2026-07-11"))

    assert [c[:3] for c in store.calls] == [
        (account_id, "2026-07-01", "2026-07-14") for account_id in constants.ACCOUNT_ID_MAP.values()
    ]
    assert len(sent) == 1
    assert "80%" in sent[0]
