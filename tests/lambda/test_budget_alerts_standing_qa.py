"""WHIT-622 QA — the alert threshold is wired to budget_standing's `available` + posted/pending.

A date-honouring fake window read (like the real date-index query), so the rollover history
really comes from the widened read. Cycle: 14 days, payday 2026-07-01, today 2026-07-14.
"""

from datetime import date
from decimal import Decimal
from functools import partial

from _budget_alert_fakes import notify_repo
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _transaction_range_fakes import _AccountTransactionRepo

_TODAY = date(2026, 7, 14)
_ACCT = "up-spending"
_CATS = [
    {"id": "groceries", "name": "Groceries", "bucket": "Living"},
    {"id": "dining", "name": "Dining", "bucket": "Lifestyle"},
]


def _txn(txn_id, category, amount, day):
    return {
        "transaction_id": txn_id, "account_id": _ACCT, "category": category,
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


class _NoTwins:
    def get_pending_transactions_for_account(self, account):
        return []


def _fire(lam, monkeypatch, budgets, stored, new):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: _TODAY)
    ba = lam.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push", lambda title, body, toks, data=None: (
        sent.append(body) or {"sent": 1, "ok": 1, "pruned": []}))
    ctx = ba.capture_pre_write(
        new, device_repo=_Devices(), budget_repo=_Budgets(budgets), paycycle_repo=_Paycycle(),
        window_repo=_AccountTransactionRepo(stored), webhook_repo=_NoTwins(),
    )
    ba.fire_budget_alerts(ctx, new, webhook_repo=_NoTwins(), category_repo=_Categories(),
                          notify_repo=notify_repo())
    return sent


_ROLLOVER = {
    "rollover": True, "carryover": Decimal("0"), "carryover_from": "2026-06-17",
    "carryover_len": Decimal("14"), "carryover_paydate": "2026-07-01",
}


def test_widened_rollover_read_does_not_leak_last_cycle_into_a_plain_budget(lam, monkeypatch):
    # [A9] (P0) A rollover budget widens the read back to 2026-06-17. Dining (plain, $100) spent
    # $500 LAST cycle and only $20 + $10 this one → 30%, no push. If last cycle's rows leak into
    # this cycle's spend, Dining reads $530 → a false "Budget hit".
    budgets = {"groceries": {"target": Decimal("1000"), **_ROLLOVER},
               "dining": {"target": Decimal("100")}}
    stored = [_txn("prior", "dining", -500, "2026-06-20"), _txn("old", "dining", -20, "2026-07-05")]
    sent = _fire(lam, monkeypatch, budgets, stored, [_txn("new1", "dining", -10, "2026-07-10")])
    assert sent == []


def test_this_cycle_rows_are_counted_once_not_twice_with_rollover_history(lam, monkeypatch):
    # [A10] (P0) The rollover read's current-cycle rows are also in the after-write rows. They
    # must count once: $70 + $5 = $75 of a $100 + $0 carryover basis → no push. Counted twice
    # ($145) it would read "Budget hit".
    stored = [_txn("prior", "groceries", -100, "2026-06-20"), _txn("old", "groceries", -70, "2026-07-05")]
    sent = _fire(lam, monkeypatch, {"groceries": {"target": Decimal("100"), **_ROLLOVER}},
                 stored, [_txn("new1", "groceries", -5, "2026-07-10")])
    assert sent == []


def test_rollover_overspend_last_cycle_lowers_the_alert_basis(lam, monkeypatch):
    # [A11] (P1) Last cycle overspent by $40 → carryover −$40 → basis $60, 80% = $48. This cycle
    # $40 + $10 = $50 → the 80% push. On the raw $100 target that would be silent.
    stored = [_txn("prior", "groceries", -140, "2026-06-20"), _txn("old", "groceries", -40, "2026-07-05")]
    sent = _fire(lam, monkeypatch, {"groceries": {"target": Decimal("100"), **_ROLLOVER}},
                 stored, [_txn("new1", "groceries", -10, "2026-07-10")])
    assert len(sent) == 1
    assert "80%" in sent[0]


def test_rollover_after_a_pay_cycle_change_keeps_the_stored_carryover(lam, monkeypatch):
    # [A12] (P1) The rollover was sealed under a 7-day cycle; the cycle is now 14 days → it is
    # re-anchored and keeps its stored $50. Basis $150, 80% = $120. $100 + $10 = $110 → silent.
    # Dropping the carryover (basis $100) would fire a false "Budget hit".
    budget = {"target": Decimal("100"), **_ROLLOVER, "carryover": Decimal("50"),
              "carryover_len": Decimal("7")}
    stored = [_txn("old", "groceries", -100, "2026-07-05")]
    sent = _fire(lam, monkeypatch, {"groceries": budget}, stored,
                 [_txn("new1", "groceries", -10, "2026-07-10")])
    assert sent == []
