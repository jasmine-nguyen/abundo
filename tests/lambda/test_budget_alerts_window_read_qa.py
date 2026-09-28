"""WHIT-607 QA — the budget alerts' window read must widen back to the rollover history.

The main suite's FakeWindowRepo ignores the requested dates, so it can't tell whether
capture_pre_write asks for [cycle start, today] or the wider rollover window. This fake
honours the date range like the real date-index query, and records every request.
"""

from datetime import date
from decimal import Decimal

from _budget_alert_fakes import FakeNotifyRepo

_TODAY = date(2026, 7, 14)
_ACCT = "up-spending"
_CATS = [{"id": "groceries", "name": "Groceries", "bucket": "Living"}]


def _txn(txn_id, amount, day):
    return {
        "transaction_id": txn_id, "account_id": _ACCT, "category": "groceries",
        "amount": Decimal(str(amount)), "status": "posted", "date": day,
        "counts_to_budget": True, "authorized_date": day,
    }


class _DateRangeRepo:
    def __init__(self, rows):
        self.rows = rows
        self.requests = []

    def get_transactions_by_date_range(self, account_id, start, end, limit=100, cursor=None):
        self.requests.append((account_id, start, end))
        return [r for r in self.rows
                if r["account_id"] == account_id
                and (start is None or r["date"] >= start)
                and (end is None or r["date"] <= end)], None


class _Devices:
    def list_tokens(self):
        return ["ExpoPushToken[a]"]


class _Budgets:
    def __init__(self, budgets):
        self.budgets = budgets

    def list_budgets(self):
        return self.budgets


class _Paycycle:
    def get_paycycle(self):
        return {"last_pay_date": "2026-07-01", "length": 14}


class _Categories:
    def list_categories(self):
        return _CATS


class _NoTwins:
    def get_pending_transactions_for_account(self, account):
        return []


def _fire(lam, monkeypatch, budget, stored, new):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: _TODAY)
    ba = lam.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push", lambda title, body, toks, data=None: (
        sent.append(body) or {"sent": 1, "ok": 1, "pruned": []}))
    window_repo = _DateRangeRepo(stored)
    ctx = ba.capture_pre_write(
        [new], device_repo=_Devices(), budget_repo=_Budgets({"groceries": budget}),
        paycycle_repo=_Paycycle(), window_repo=window_repo, webhook_repo=_NoTwins(),
    )
    ba.fire_budget_alerts(ctx, [new], webhook_repo=_NoTwins(), category_repo=_Categories(),
                          notify_repo=FakeNotifyRepo())
    return sent, window_repo


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
    sent, window_repo = _fire(lam, monkeypatch, budget, stored, _txn("new1", -10, "2026-07-11"))

    assert {start for _, start, _ in window_repo.requests} == {"2026-06-17"}
    assert {end for _, _, end in window_repo.requests} == {"2026-07-14"}
    assert len(sent) == 1
    assert "80%" in sent[0]


def test_plain_budget_alert_reads_only_the_current_cycle(lam, monkeypatch):
    # [A9] no rollover target → the read covers exactly [cycle start, today] on every account.
    import constants

    budget = {"target": Decimal("100")}
    stored = [_txn("prior1", -500, "2026-06-20"), _txn("old", -70, "2026-07-10")]
    sent, window_repo = _fire(lam, monkeypatch, budget, stored, _txn("new1", -15, "2026-07-11"))

    assert window_repo.requests == [
        (account_id, "2026-07-01", "2026-07-14") for account_id in constants.ACCOUNT_ID_MAP.values()
    ]
    assert len(sent) == 1
    assert "80%" in sent[0]
