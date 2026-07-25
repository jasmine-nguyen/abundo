"""WHIT-342 GAP tests for GET /categories/{id}/transactions (get_category_transactions).

Adversarial edges the implementer's test_category_transactions.py leaves open:
  * a SINGLE category carrying BOTH a posted refund AND pending spend — both buckets
    clamp independently AND still reconcile with /breakdown (the impl's refund test only
    touched the posted bucket).
  * a KNOWN category with zero rows this cycle vs a TOTALLY-UNKNOWN id — both must be an
    empty 200 list, NOT a 404 (only a missing/blank path id is 404).
  * the multi-account merge in _fetch_windowed_transactions — rows for one category filed
    on DIFFERENT accounts are all merged into the drill list, newest-first. The impl's
    _DateFilteringTransactionRepo serves the whole pool on the first account only, so the
    per-account loop's merge is never actually exercised there.
  * the shared cycle guard rejects a negative / non-integer ?cycle= on THIS route too.

Fakes are local, mirroring test_category_transactions.py (each suite owns its fakes).
"""

import json
from datetime import date
from decimal import Decimal

import pytest


def _contributes(transaction):
    if not transaction.get("counts_to_budget") or transaction.get("budget_excluded"):
        return False
    return transaction["status"] in ("posted", "pending")


class _DateFilteringTransactionRepo:
    """Serves the pool ONCE (first account), honouring the inclusive date `between`.
    Mirrors the impl suite's fake — all rows come back on the first account queried."""

    def __init__(self, transactions):
        self._txns = list(transactions)
        self._served = False
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        if self._served:
            return [], None
        self._served = True
        page = [t for t in self._txns if start_date <= t["date"] <= end_date]
        return page, None


class _PerAccountTransactionRepo:
    """Partitions the pool BY account_id (via each row's `account_id`), so the handler's
    per-account loop is actually exercised: each account returns only its own rows. Used
    to prove the drill MERGES rows filed on different accounts."""

    def __init__(self, transactions):
        self._by_account = {}
        for t in transactions:
            self._by_account.setdefault(t["account_id"], []).append(t)
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append(account_id)
        page = [t for t in self._by_account.get(account_id, [])
                if start_date <= t["date"] <= end_date]
        return page, None


class _FakePayCycleRepo:
    def __init__(self, length=30, last_pay_date="2026-07-01"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


class _FakeCategoryRepo:
    def __init__(self, categories):
        self._categories = categories

    def list_categories(self):
        return [dict(c) for c in self._categories]


CATS = [{"id": "coffee", "bucket": "Lifestyle", "parent": None}]


def _txn(txn_id, category, amount, date_, status="posted", counts=True, excluded=False,
         account_id="up-spending"):
    row = {
        "transaction_id": txn_id,
        "category": category,
        "amount": Decimal(str(amount)),
        "status": status,
        "counts_to_budget": counts,
        "date": date_,
        "account_id": account_id,
        "pk": f"ACCT#{account_id}",
        "sk": f"TXN#{txn_id}",
    }
    if excluded:
        row["budget_excluded"] = True
    return row


def _event(category_id="coffee", cycle=None):
    event = {
        "rawPath": f"/categories/{category_id}/transactions",
        "requestContext": {"http": {"method": "GET"}},
        "pathParameters": {"id": category_id},
    }
    if cycle is not None:
        event["queryStringParameters"] = {"cycle": cycle}
    return event


def _pin_today(monkeypatch, day=date(2026, 7, 25)):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: day)


def _clamped_total(rows):
    posted = sum((-Decimal(str(r["amount"])) for r in rows
                  if _contributes(r) and r["status"] == "posted"), Decimal(0))
    pending = sum((-Decimal(str(r["amount"])) for r in rows
                   if _contributes(r) and r["status"] == "pending"), Decimal(0))
    return max(Decimal(0), posted) + max(Decimal(0), pending)


# --- both-bucket reconciliation ----------------------------------------------


def test_refund_and_pending_in_same_category_clamp_independently_and_reconcile(handler, monkeypatch):
    # One category, one posted refund that nets the POSTED bucket negative, plus live PENDING
    # spend. The pending bucket must NOT be eaten by the posted refund (independent clamp), and
    # the drilled total must still equal /breakdown for the same id.
    # FAIL-ON-REVERT: an aggregate (single) clamp would net posted+pending = (10-25)+8 = 0 -> the
    # drill/breakdown would read 8 vs this asserts 8 only because pending is clamped on its own.
    _pin_today(monkeypatch)
    txns = [
        _txn("spend", "coffee", -10, "2026-07-10", status="posted"),
        _txn("refund", "coffee", 25, "2026-07-11", status="posted"),   # posted bucket -> max(0, -15)=0
        _txn("live", "coffee", -8, "2026-07-12", status="pending"),    # pending bucket -> 8
    ]
    breakdown = handler.list_category_breakdown(
        _FakeCategoryRepo(CATS), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo())
    resp = handler.get_category_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    rows = json.loads(resp["body"])

    assert {r["transaction_id"] for r in rows} == {"spend", "refund", "live"}  # all listed
    card = breakdown["coffee"]
    assert card["posted"] == Decimal("0")           # posted refund clamps its own bucket
    assert card["pending"] == Decimal("8")          # pending untouched by the posted refund
    assert _clamped_total(rows) == card["posted"] + card["pending"] == Decimal("8")


# --- known-empty vs unknown id (both 200 [], never 404 for a present-but-unknown id) ---


def test_known_category_with_zero_rows_this_cycle_returns_empty_200(handler, monkeypatch):
    # The category exists, but nothing landed on it this cycle -> empty 200 list (the drill's
    # empty state), NOT an error. Distinct from the prior-cycle-empty test: here the id is real.
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _event("coffee"),
        _DateFilteringTransactionRepo([_txn("g1", "groceries", -10, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


def test_totally_unknown_id_returns_empty_200_not_404(handler, monkeypatch):
    # A present-but-unknown id (never a real category) is matched by exact equality -> no rows ->
    # empty 200. Only a MISSING/blank path id is 404. FAIL-ON-REVERT: a "must exist in taxonomy
    # else 404" guard on the named branch would 404 here instead.
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _event("does-not-exist-anywhere"),
        _DateFilteringTransactionRepo([_txn("c1", "coffee", -10, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


# --- multi-account merge -----------------------------------------------------


def test_merges_same_category_rows_across_accounts_newest_first(handler, monkeypatch):
    # A category's charges span TWO accounts (up-spending + anz-rewards-black-visa). The drill
    # must merge both accounts' rows and sort the merged set newest-first — the per-account loop
    # in _fetch_windowed_transactions, which the pool-once fake never exercises.
    # FAIL-ON-REVERT: breaking to a single-account fetch (dropping the loop) drops 'anz1'.
    _pin_today(monkeypatch)
    txns = [
        _txn("up1", "coffee", -10, "2026-07-10", account_id="up-spending"),
        _txn("anz1", "coffee", -20, "2026-07-20", account_id="anz-rewards-black-visa"),
        _txn("up2", "coffee", -5, "2026-07-05", account_id="up-spending"),
    ]
    repo = _PerAccountTransactionRepo(txns)
    resp = handler.get_category_transactions(
        _event("coffee"), repo, _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    rows = json.loads(resp["body"])

    assert [r["transaction_id"] for r in rows] == ["anz1", "up1", "up2"]  # merged, newest-first
    # every account in the map was queried (the merge really looped, not short-circuited)
    assert "up-spending" in repo.calls and "anz-rewards-black-visa" in repo.calls


def test_uncategorized_merges_across_accounts_and_still_filters(handler, monkeypatch):
    # The uncategorized bucket over two accounts: an unmapped in-budget charge on each is kept,
    # but a not-in-budget transfer on one account is dropped by the contributes_to_budget gate.
    _pin_today(monkeypatch)
    txns = [
        _txn("u_up", None, -30, "2026-07-10", account_id="up-spending"),
        _txn("u_anz", None, -40, "2026-07-12", account_id="anz-rewards-black-visa"),
        _txn("xfer", None, -500, "2026-07-11", counts=False, account_id="up-spending"),
    ]
    resp = handler.get_category_transactions(
        _event("__uncategorized__"), _PerAccountTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    rows = json.loads(resp["body"])
    assert [r["transaction_id"] for r in rows] == ["u_anz", "u_up"]  # merged, transfer dropped


# --- cycle guard on this route ----------------------------------------------


def test_negative_cycle_returns_400(handler):
    resp = handler.get_category_transactions(
        _event("coffee", cycle="-1"), _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 400


def test_non_integer_cycle_returns_400(handler):
    resp = handler.get_category_transactions(
        _event("coffee", cycle="abc"), _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 400
