"""QA for WHIT-624 slice 2: the budget-alert preview (`budget_alerts._simulate_after`)
carries out the SAME `reconcile` plan as the real save. Every test drives the real
preview and, where it matters, the real `insert_or_reconcile` on FakeTable over the
same data — never a hand-copied preview."""

import re
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from _budget_alert_fakes import FakeNotifyRepo

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BANK_ACCT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"
_BUDGET = {"groceries": {"target": Decimal("100")}}
_CATS = [{"id": "groceries", "name": "Groceries"}]


@pytest.fixture
def alerts(lam, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2026, 7, 14))  # window 07-01..07-14
    return lam


class _Window:
    def __init__(self, rows):
        self._rows = rows

    def get_transactions_by_date_range(self, account_id, start, end, limit=100, cursor=None):
        return ([r for r in self._rows if r["account_id"] == account_id], None)


class _Devices:
    def list_tokens(self):
        return ["ExpoPushToken[a]"]


class _Budgets:
    def list_budgets(self):
        return _BUDGET


class _Paycycle:
    def get_paycycle(self):
        return {"last_pay_date": "2026-07-01", "length": 14}


class _Categories:
    def list_categories(self):
        return _CATS


def _norm_real(alerts, *, txn_id, amount, pending, category, date="2026-07-10",
               authorized_date="2026-07-10", merchant_name="SQ *KKV INTERNATIONAL PTY",
               description="SQ *KKV INTERNATIONAL PTY"):
    return alerts.banksync.BankSyncClient.normalise({
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
    notify = FakeNotifyRepo()
    ctx = ba.capture_pre_write(batch, device_repo=_Devices(), budget_repo=_Budgets(),
                               paycycle_repo=_Paycycle(), window_repo=_Window(before), webhook_repo=repo)
    repo.insert_or_reconcile(batch)
    ba.fire_budget_alerts(ctx, batch, webhook_repo=repo, category_repo=_Categories(), notify_repo=notify)
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


# [A2] P0 — a pending re-sync with a bigger amount (tip added) keeps the user's
# hand-filed category and counts the NEW amount: 70 → 85 of 100 crosses 80%.
def test_pending_resync_keeps_stored_category_and_counts_the_new_amount(alerts, repo, monkeypatch):
    _seed(repo, alerts, txn_id="PEND", amount=Decimal("-70"), pending=True, category="groceries")
    before = list(repo._table.store.values())
    resync = _norm_real(alerts, txn_id="PEND", amount=Decimal("-85"), pending=True, category="FOOD_AND_DRINK")

    sent, notify, ctx = _fire(alerts, monkeypatch, repo, before, [resync])

    assert sent == ["Heads up \U0001f440"]
    assert notify.fired_markers("2026-07-01", 14) == {"groceries#80"}
    ledger = list(repo._table.store.values())
    assert _view(alerts.budget_alerts._simulate_after(ctx, [resync])) == _view(ledger)


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


# [A4] P1 — the preview never mutates the snapshot: running it twice gives the same rows,
# and the pending pools / before-rows the ctx holds are untouched (the fire step reads them).
def test_preview_does_not_mutate_the_snapshot(alerts, repo, monkeypatch):
    _seed(repo, alerts, txn_id="A", amount=Decimal("-70"), pending=True, category="groceries")
    before = list(repo._table.store.values())
    posted = _norm_real(alerts, txn_id="B", amount=Decimal("-70"), pending=False, category="GROCERIES")
    _, _, ctx = _fire(alerts, monkeypatch, repo, before, [posted])
    pools_before = {a: [dict(r) for r in rows] for a, rows in ctx["pending_pools"].items()}
    rows_before = [dict(r) for r in ctx["before_rows"]]

    first = _view(alerts.budget_alerts._simulate_after(ctx, [posted]))
    second = _view(alerts.budget_alerts._simulate_after(ctx, [posted]))

    assert first == second
    assert list(first) == ["B"]
    assert {a: [dict(r) for r in rows] for a, rows in ctx["pending_pools"].items()} == pools_before
    assert [dict(r) for r in ctx["before_rows"]] == rows_before


# [A5] P0 — the card's "done when": no code outside lambda/repository.py reaches into the
# webhook repository's private names, and the moved matching helpers are gone from it.
_MOVED = ("_reconcile_matches", "_ensure_pool", "_find_exact_twin", "_find_tip_twin",
          "_find_skewed_auth_twin", "_find_blank_auth_twin", "_with_carried_category",
          "_inherit_swipe_date", "_delete_pending_if_present", "_merchant_matches_pending")


def test_nothing_outside_the_repository_uses_its_private_names(lam):
    repo_cls = lam.repository.TransactionRepository
    own_private = [n for n in vars(repo_cls) if n.startswith("_") and not n.startswith("__")]
    assert not [n for n in _MOVED if hasattr(repo_cls, n) or hasattr(lam.repository, n)]

    pattern = re.compile(r"\.(%s)\b|\brepository\._[a-z]" % "|".join(map(re.escape, own_private + list(_MOVED))))
    offenders = []
    for folder in ("lambda", "shared", "lambda_api"):
        for path in (_REPO_ROOT / folder).rglob("*.py"):
            if path == _REPO_ROOT / "lambda" / "repository.py":
                continue
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if pattern.search(line):
                    offenders.append(f"{path.relative_to(_REPO_ROOT)}:{number}: {line.strip()}")
    assert offenders == []


# [A6] P1 — the move: budget_alerts lives only in lambda/ (reconcile.py imports
# lambda-only modules, so a shared/ copy can't import it) and is allow-listed for commit.
def test_budget_alerts_lives_in_lambda_and_is_allow_listed():
    assert (_REPO_ROOT / "lambda" / "budget_alerts.py").is_file()
    assert not (_REPO_ROOT / "shared" / "budget_alerts.py").exists()
    allow = (_REPO_ROOT / ".gitignore").read_text().splitlines()
    assert "!lambda/budget_alerts.py" in allow
    assert "!lambda/reconcile.py" in allow
