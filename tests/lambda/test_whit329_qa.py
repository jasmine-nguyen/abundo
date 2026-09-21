"""WHIT-329 QA-gap tests — the pending re-send carry, its budget-alert preview
mirror, the out-of-order posted-then-pending edge, and the reprocess caller.

The 4 implementer tests in test_reconcile.py already lock the reconcile-side carry
via the REAL repo. These cover the gaps:
  * the budget-alert PREVIEW mirror (shared/budget_alerts._simulate_after) — driven
    with the REAL webhook repo so the production _with_carried_category runs (the
    NoTwinRepo stub in test_budget_alerts.py returns dict(txn), so it can't prove it);
  * the out-of-order posted-then-pending same-id edge (pinned behaviour);
  * the reprocess dead-letter caller driving the pending branch.

Uses the webhook `lam` / `repo` fixtures from conftest.py.
"""

from datetime import date
from decimal import Decimal

import pytest

_BANK_ACCT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"  # -> "anz-rewards-black-visa"
_TODAY = date(2026, 7, 14)   # cycle [2026-07-01, 2026-07-14] with payday 07-01, len 14


@pytest.fixture
def alerts(lam, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: _TODAY)
    return lam


def _bank(txn_id, amount, *, pending, category, date="2026-07-10",
          authorized_date="2026-07-10", merchant_name="SQ *KKV INTERNATIONAL PTY",
          description="SQ *KKV INTERNATIONAL PTY"):
    return {
        "id": txn_id, "date": date, "authorizedDate": authorized_date,
        "description": description, "merchantName": merchant_name, "amount": amount,
        "accountId": _BANK_ACCT, "accountName": "ANZ Rewards Black Visa",
        "category": category, "pending": pending, "type": "PAYMENT",
        "pendingTransactionId": None,
    }


def _norm(lam, **kw):
    return lam.banksync.BankSyncClient.normalise(_bank(**kw))


def _acc(txn):
    return "ACCOUNT#" + txn["account_id"]


# ---------------------------------------------------------------------------
# Minimal fakes for the budget-alert straddle (mirror the ones in
# test_budget_alerts.py; kept local so this file is self-contained). The
# load-bearing carry runs on the REAL repo, never on a fake.
# ---------------------------------------------------------------------------


class _WindowRepo:
    def __init__(self, rows):
        self._rows = rows

    def get_transactions_by_date_range(self, account_id, start, end, limit=100, cursor=None):
        return ([r for r in self._rows if r["account_id"] == account_id], None)


class _BudgetRepo:
    def __init__(self, b):
        self._b = b

    def list_budgets(self):
        return self._b


class _PaycycleRepo:
    def get_paycycle(self):
        return {"last_pay_date": "2026-07-01", "length": 14}


class _DeviceRepo:
    def list_tokens(self):
        return ["ExpoPushToken[a]"]


class _CategoryRepo:
    def __init__(self, cats):
        self._c = cats

    def list_categories(self):
        return self._c


class _NotifyRepo:
    def __init__(self):
        self.store = {}

    def fired_markers(self, last, length):
        return set(self.store.get((last, length), set()))

    def mark_fired(self, last, length, marker):
        self.store.setdefault((last, length), set()).add(marker)


def _run_alerts(alerts, monkeypatch, *, budgets, before, normalised, webhook_repo,
                cats=(("groceries", "Groceries", "Living"),)):
    ba = alerts.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push",
                        lambda title, body, toks, data=None:
                        (sent.append((title, body)), {"sent": 1, "ok": 1, "pruned": []})[1])
    notify = _NotifyRepo()
    catlist = [{"id": c[0], "name": c[1], "bucket": c[2]} for c in cats]
    ctx = ba.capture_pre_write(
        normalised, device_repo=_DeviceRepo(), budget_repo=_BudgetRepo(budgets),
        paycycle_repo=_PaycycleRepo(), window_repo=_WindowRepo(before), webhook_repo=webhook_repo,
    )
    ba.fire_if_crossed(ctx, normalised, webhook_repo=webhook_repo,
                       category_repo=_CategoryRepo(catlist), notify_repo=notify)
    return sent, notify


# ===========================================================================
# GAP 1 — the budget-alert PREVIEW mirror of the pending re-send carry.
# _simulate_after's pending branch now carries the user's category from the
# in-memory snapshot; these prove the preview counts spend under the USER's
# category, not the bank's raw one. Driven with the REAL repo so the real
# production _with_carried_category runs (NoTwinRepo's stub cannot).
# ===========================================================================


def test_pending_resend_preview_counts_user_category_and_fires(alerts, repo, monkeypatch):
    # WHIT-329 — [A-mirror-1] the preview keeps the user's category on a pending re-send.
    # User categorised pending "P" as groceries (-70, 70% of the 100 budget). The bank
    # re-sends the SAME pending id with its raw "FOOD_AND_DRINK" AND a grown amount (-85,
    # a topped-up auth). The mirror must carry "groceries" so the preview reads 85 and
    # fires 80%.  Fail-on-revert (blind dict(txn)): the re-send is counted as
    # FOOD_AND_DRINK -> groceries stays 0 in the after-set -> the real crossing is
    # dropped -> SILENT.
    before = [_norm(alerts, txn_id="P", amount=Decimal("-70"), pending=True, category="groceries")]
    resend = _norm(alerts, txn_id="P", amount=Decimal("-85"), pending=True, category="FOOD_AND_DRINK")
    sent, notify = _run_alerts(alerts, monkeypatch,
                               budgets={"groceries": {"target": Decimal("100")}},
                               before=before, normalised=[resend], webhook_repo=repo)
    assert len(sent) == 1
    assert sent[0][1] == "Groceries is at 80% of its budget this cycle."
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}


def test_pending_resend_preview_does_not_fire_a_false_alert_on_raw_category(alerts, repo, monkeypatch):
    # WHIT-329 — [A-mirror-2] the OTHER direction: the user moved a pending charge OUT of
    # groceries into an unbudgeted "dining". A pending re-send arrives whose own category is
    # the budgeted "groceries" slug. The mirror carries "dining", so groceries stays at its
    # existing 70 and does NOT fire.  Fail-on-revert (blind dict(txn)): the re-send counts
    # as groceries -> 70 + 85 = 155 -> crosses 80% -> a FALSE push the user would find
    # infuriating. (The re-send category is the lowercase budget slug so the false-add lands
    # on the budget; a raw UPPERCASE enum would be masked by the WHIT-22 slug gate.)
    before = [
        _norm(alerts, txn_id="old", amount=Decimal("-70"), pending=False, category="groceries"),
        _norm(alerts, txn_id="P", amount=Decimal("-85"), pending=True, category="dining"),
    ]
    resend = _norm(alerts, txn_id="P", amount=Decimal("-85"), pending=True, category="groceries")
    sent, notify = _run_alerts(alerts, monkeypatch,
                               budgets={"groceries": {"target": Decimal("100")}},
                               before=before, normalised=[resend], webhook_repo=repo)
    assert sent == []
    assert notify.fired_markers("2026-07-01", 14) == set()


# ===========================================================================
# GAP 2 — out-of-order: an already-stored POSTED row + a pending re-send under
# the SAME id. Pins the ACTUAL behaviour so any future change is deliberate.
# ===========================================================================


def test_pending_resend_over_existing_posted_carries_category_and_downgrades_status(lam, repo):
    # WHIT-329 edge — a pending arrives under an id ALREADY stored as posted. The fix reads
    # the stored row and carries the user's category onto the pending, THEN inserts it —
    # which overwrites the posted row back to status "pending".
    #   * category carry IS fail-on-revert: drop the pending-branch carry -> "FOOD_AND_DRINK".
    #   * the status downgrade is PINNED (acceptable-for-scope): settlement issues a NEW id
    #     (pendingTransactionId null in banksync.normalise), so a same-id posted->pending is
    #     a bank status regression that shouldn't occur; the OLD code also overwrote it AND
    #     lost the category, so the fix is strictly better. No duplicate row either way.
    posted = _norm(lam, txn_id="A", amount=Decimal("-260.00"), pending=False, category="health")
    repo.insert_transactions([posted])
    resend = _norm(lam, txn_id="A", amount=Decimal("-260.00"), pending=True, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([resend])

    store = repo._table.store
    row = store[(_acc(posted), "TXN#A")]
    assert row["category"] == "health"     # user category carried off the stored posted
    assert row["status"] == "pending"      # PINNED: the re-send downgrades status
    assert len(store) == 1                  # no duplicate row


# ===========================================================================
# GAP 3 — the reprocess dead-letter caller drives the pending branch too.
# ===========================================================================


def test_reprocess_pending_dead_letter_preserves_user_category_on_stored_pending(lam, repo):
    # WHIT-329 x WHIT-55 — a pending charge the user categorised is stored; its pending
    # twin got stuck in the dead-letter under the bank's raw category. Re-driving it must
    # carry the user's category onto the re-insert (the pending branch's new read-carry),
    # not clobber it back.  Fail-on-revert: drop the pending-branch carry -> "FOOD_AND_DRINK".
    stored = _norm(lam, txn_id="P", amount=Decimal("-40.00"), pending=True, category="FOOD_AND_DRINK")
    stored["category"] = "USER_PICKED"
    repo.insert_transactions([stored])
    repo.save_failed_transactions([_bank("P", -40.00, pending=True, category="FOOD_AND_DRINK")])

    summary = lam.reprocess.reprocess_failed(repo)

    assert summary == {"reprocessed": 1, "skipped": 0, "errors": 0}
    row = repo._table.store[(_acc(stored), "TXN#P")]
    assert row["category"] == "USER_PICKED"    # user category preserved through reprocess
    assert row["status"] == "pending"
    assert [k for k in repo._table.store if k[0] == "FAILED"] == []   # dead-letter cleared
