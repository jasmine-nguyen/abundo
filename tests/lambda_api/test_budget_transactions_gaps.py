"""QA GAP tests for GET /budgets/{category}/transactions (get_budget_transactions).

The implementer's test_budget_transactions.py covers the headline reconciliation (a
>7-day-old row + a same-bucket sub-category row), non-contributing exclusion, pk/sk
strip, missing-id 404, empty cycle, window bounds and router dispatch. These add the
ADVERSARIAL edges it does not:

  * a refund (positive amount) is counted symmetrically with the /budgets total,
  * a NET-NEGATIVE bucket — where the list and the clamped header DIVERGE (a real gap;
    see the ranked critique),
  * an EARN-TARGET (Income) budget's list — the endpoint is bucket-agnostic and returns
    the income subtree, newest-first,
  * a CROSS-BUCKET child is dropped from the list (the endpoint passes bucket_by_id to
    subtree_ids — reverting that leaks the child), while a SAME-bucket descendant sitting
    UNDER a cross-bucket intermediate is still kept (subtree filters membership, not descent).

Local fakes mirror test_budget_transactions.py's stand-ins so the file stands alone.
"""

import json
from datetime import date
from decimal import Decimal


class _DateFilteringTransactionRepo:
    """Honours DynamoDB `between` (inclusive both ends over YYYY-MM-DD). Serves the pool
    once so the per-account loop counts each transaction a single time."""

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


class _FakeBudgetRepo:
    def __init__(self, budgets):
        self._budgets = budgets

    def list_budgets(self):
        return {k: dict(v) for k, v in self._budgets.items()}


def _txn(txn_id, category, amount, date_, status="posted", counts=True, excluded=False):
    row = {
        "transaction_id": txn_id,
        "category": category,
        "amount": Decimal(str(amount)),
        "status": status,
        "counts_to_budget": counts,
        "date": date_,
        "pk": "ACCT#up-spending",
        "sk": f"TXN#{txn_id}",
    }
    if excluded:
        row["budget_excluded"] = True
    return row


def _event(category="coffee"):
    return {
        "rawPath": f"/budgets/{category}/transactions",
        "requestContext": {"http": {"method": "GET"}},
        "pathParameters": {"category": category},
    }


def _pin_today(monkeypatch, day=date(2026, 7, 25)):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: day)


# --- refunds -----------------------------------------------------------------

CATS_LIFESTYLE = [
    {"id": "coffee", "bucket": "Lifestyle", "parent": None},
    {"id": "coffee-beans", "bucket": "Lifestyle", "parent": "coffee"},
]


def test_refund_reconciles_with_the_budget_total(handler, monkeypatch):
    # A refund (POSITIVE stored amount) reduces both the /budgets total and the list sum by
    # the same signed amount, so the eyeballed rows still add up to the header. Spend $30,
    # refund $10 → net $20 in BOTH. Fail-on-revert anchor: the shared sign=-1 contribution
    # (a filter that dropped the positive-amount refund would read $30 here, not $20).
    _pin_today(monkeypatch)
    txns = [
        _txn("spend", "coffee", -30, "2026-07-10"),
        _txn("refund", "coffee", 10, "2026-07-11"),  # money back
    ]
    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS_LIFESTYLE))["coffee"]
    total_spend = total["posted"] + total["pending"]

    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS_LIFESTYLE))
    rows = json.loads(resp["body"])

    assert [r["transaction_id"] for r in rows] == ["refund", "spend"]  # newest-first
    listed = sum(Decimal(str(-r["amount"])) for r in rows)
    assert listed == total_spend == Decimal("20")


def test_net_negative_bucket_list_and_clamped_header_DIVERGE(handler, monkeypatch):
    # CHARACTERISATION (pins current, arguably-wrong behaviour — see the ranked critique):
    # a refund LARGER than the cycle's spend drives the posted bucket net-negative. The
    # /budgets header CLAMPS each bucket at >= 0 (spend.py _summarise), so it shows $0 — but
    # the transaction list returns every contributing row, whose signed sum is NEGATIVE. The
    # "the rows always reconcile with the header" promise does NOT hold in this corner.
    _pin_today(monkeypatch)
    txns = [
        _txn("spend", "coffee", -10, "2026-07-10"),
        _txn("bigrefund", "coffee", 25, "2026-07-11"),  # refund > spend
    ]
    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS_LIFESTYLE))["coffee"]
    header = total["posted"] + total["pending"]

    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS_LIFESTYLE))
    rows = json.loads(resp["body"])
    listed = sum(Decimal(str(-r["amount"])) for r in rows)

    assert header == Decimal("0")       # header clamped to zero
    assert listed == Decimal("-15")     # list sums NEGATIVE (both refund rows still shown)
    assert listed != header             # they diverge — the reconciliation guarantee breaks here


# --- income (earn-target) budgets -------------------------------------------

CATS_INCOME = [
    {"id": "salary", "bucket": "Income", "parent": None},
    {"id": "bonus", "bucket": "Income", "parent": "salary"},
]


def test_income_earn_target_lists_its_subtree_positive_amounts(handler, monkeypatch):
    # The endpoint is bucket-agnostic: an Income earn-target budget gets its whole subtree's
    # EARNINGS (positive stored amounts), newest-first, so the earn-target detail list has
    # rows too. Fail-on-revert anchor: subtree_ids — reverting the list to just {root} drops
    # the 'bonus' sub-category row that the earn-target total (a subtree rollup) DOES count.
    _pin_today(monkeypatch)
    txns = [
        _txn("pay", "salary", 2000, "2026-07-15"),
        _txn("bonus1", "bonus", 500, "2026-07-14"),  # same-bucket sub-category
    ]
    resp = handler.get_budget_transactions(
        _event("salary"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS_INCOME))
    rows = json.loads(resp["body"])

    assert [r["transaction_id"] for r in rows] == ["pay", "bonus1"]  # newest-first, subtree included
    assert all(Decimal(str(r["amount"])) > 0 for r in rows)          # earnings stay positive (not sign-flipped)


# --- cross-bucket subtree handling ------------------------------------------


def test_cross_bucket_child_is_dropped_from_the_list(handler, monkeypatch):
    # A sub-category corruptly filed under a DIFFERENT bucket must not appear under the parent
    # — the /budgets total excludes it (subtree_ids filtered by bucket), so the list must too.
    # FAIL-ON-REVERT: the endpoint passes bucket_by_id to subtree_ids; dropping that argument
    # leaks 'stray' into the list.
    _pin_today(monkeypatch)
    cats = [
        {"id": "coffee", "bucket": "Lifestyle", "parent": None},
        {"id": "stray", "bucket": "Income", "parent": "coffee"},  # cross-bucket child
    ]
    txns = [
        _txn("keep", "coffee", -10, "2026-07-10"),
        _txn("stray1", "stray", -99, "2026-07-11"),  # cross-bucket → excluded
    ]
    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(cats))

    assert [r["transaction_id"] for r in json.loads(resp["body"])] == ["keep"]


def test_same_bucket_descendant_under_a_cross_bucket_node_is_kept(handler, monkeypatch):
    # Adversarial subtree: coffee(Lifestyle) -> mid(Income, cross) -> leaf(Lifestyle, == root
    # bucket). The walk descends THROUGH the cross-bucket 'mid' and keeps the same-bucket
    # 'leaf' beneath it (subtree_ids filters membership, not descent) — matching the client's
    # nearest-same-bucket-ancestor rule. So the leaf's charge shows, the mid's does not.
    _pin_today(monkeypatch)
    cats = [
        {"id": "coffee", "bucket": "Lifestyle", "parent": None},
        {"id": "mid", "bucket": "Income", "parent": "coffee"},       # cross-bucket intermediate
        {"id": "leaf", "bucket": "Lifestyle", "parent": "mid"},      # same bucket as root, under mid
    ]
    txns = [
        _txn("root1", "coffee", -10, "2026-07-10"),
        _txn("mid1", "mid", -20, "2026-07-11"),    # cross-bucket node itself → dropped
        _txn("leaf1", "leaf", -5, "2026-07-12"),   # same-bucket descendant → KEPT
    ]
    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(cats))

    assert [r["transaction_id"] for r in json.loads(resp["body"])] == ["leaf1", "root1"]
