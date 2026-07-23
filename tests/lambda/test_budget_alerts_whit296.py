"""WHIT-296 — the over-budget push path must honour the budget_excluded override.

Two independent guards the implementer's shared-gate test doesn't reach:

  * [A-P1] a freshly-settled charge whose PENDING twin the user marked "exclude"
    must NOT trip an over-budget push. This drives the REAL webhook repo through
    `fire_if_crossed` -> `_simulate_after` -> `_reconcile_matches` /
    `_with_carried_category` (the carry) -> `summarise_transactions` (the gate), so
    it fails if EITHER the carry (repository.py) or the spend gate (spend.py) is
    reverted.
  * [A-P2] an excluded charge in the incoming batch never contributes to the Δ that
    the crossing check sums — the gate alone, via NoTwinRepo.

Harness mirrors tests/lambda/test_budget_alerts.py (pinned _melbourne_today,
stubbed send_push). Cycle [2026-07-01, 2026-07-14].
"""

from datetime import date
from decimal import Decimal

import pytest

_TODAY = date(2026, 7, 14)
_ACCT = "up-spending"


@pytest.fixture
def alerts(lam, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: _TODAY)
    return lam


class FakeWindowRepo:
    def __init__(self, rows):
        self._rows = rows

    def get_transactions_by_date_range(self, account_id, start, end, limit=100, cursor=None):
        return ([r for r in self._rows if r["account_id"] == account_id], None)


class FakeBudgetRepo:
    def __init__(self, budgets):
        self._b = budgets

    def list_budgets(self):
        return self._b


class FakePaycycleRepo:
    def get_paycycle(self):
        return {"last_pay_date": "2026-07-01", "length": 14}


class FakeDeviceRepo:
    def list_tokens(self):
        return ["ExpoPushToken[a]"]


class FakeCategoryRepo:
    def __init__(self, cats):
        self._c = cats

    def list_categories(self):
        return self._c


class FakeNotifyRepo:
    def __init__(self):
        self.store = {}

    def fired_markers(self, last, length):
        return set(self.store.get((last, length), set()))

    def mark_fired(self, last, length, marker):
        self.store.setdefault((last, length), set()).add(marker)


class NoTwinRepo:
    def get_pending_transactions_for_account(self, account):
        return []

    def _reconcile_matches(self, posted_txns, pools):
        return [(txn, None) for txn in posted_txns]

    @staticmethod
    def _with_carried_category(txn, src):
        return dict(txn)


def _posted(txn_id, category, amount, budget_excluded=None, date="2026-07-10"):
    row = {
        "transaction_id": txn_id, "account_id": _ACCT, "category": category,
        "amount": Decimal(str(amount)), "status": "posted", "date": date,
        "counts_to_budget": True, "authorized_date": date,
    }
    if budget_excluded is not None:
        row["budget_excluded"] = budget_excluded
    return row


def _fire(alerts, monkeypatch, *, budgets, before, normalised, webhook_repo,
          cats=None):
    ba = alerts.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push",
                        lambda title, body, toks, data=None: sent.append((title, body)) or
                        {"sent": len(list(toks)), "ok": 1, "pruned": []})
    notify = FakeNotifyRepo()
    ctx = ba.capture_pre_write(
        normalised,
        device_repo=FakeDeviceRepo(),
        budget_repo=FakeBudgetRepo(budgets),
        paycycle_repo=FakePaycycleRepo(),
        window_repo=FakeWindowRepo(before),
        webhook_repo=webhook_repo,
    )
    ba.fire_if_crossed(
        ctx, normalised, webhook_repo=webhook_repo,
        category_repo=FakeCategoryRepo(cats or [{"id": "groceries", "name": "Groceries", "bucket": "Living"}]),
        notify_repo=notify,
    )
    return sent, notify


def test_excluded_settling_twin_does_not_fire_over_budget_alert(alerts, repo, monkeypatch):
    # [A-P1] The pending groceries -85 (85% of a 100 budget) was marked "exclude". On
    # settlement the posted twin carries the override, so the Δ sees $0 of groceries
    # spend and no threshold is crossed. Uses the REAL webhook repo for the carry.
    # Fail-on-revert: revert the carry OR the spend gate and after jumps to $85 -> the
    # 80% push fires and this goes red.
    acc = "ACCOUNT#" + _ACCT
    repo._table.store[(acc, "TXN#pend1")] = {
        "pk": acc, "sk": "TXN#pend1", "transaction_id": "pend1", "account_id": _ACCT,
        "category": "groceries", "amount": Decimal("-85"), "status": "pending",
        "date": "2026-07-10", "authorized_date": "2026-07-10",
        "counts_to_budget": True, "budget_excluded": True,
    }
    before = [dict(repo._table.store[(acc, "TXN#pend1")])]  # window read sees the pending
    posted = _posted("post1", "groceries", -85)             # bank feed: no override

    sent, notify = _fire(alerts, monkeypatch,
                         budgets={"groceries": {"target": Decimal("100")}},
                         before=before, normalised=[posted], webhook_repo=repo)

    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


def test_excluded_charge_in_batch_never_crosses_threshold(alerts, monkeypatch):
    # [A-P2] The gate alone: a lone excluded groceries -85 in the batch (no twin) must
    # not push. Fail-on-revert: revert the spend gate and the 80% push fires.
    posted = _posted("g1", "groceries", -85, budget_excluded=True)

    sent, _ = _fire(alerts, monkeypatch,
                    budgets={"groceries": {"target": Decimal("100")}},
                    before=[], normalised=[posted], webhook_repo=NoTwinRepo())

    assert sent == []
