"""WHIT-366 (QA gaps) — the __income__ per-source breakdown edges the implementer's
test_breakdown.py does NOT cover. Reuses that file's direct-call fakes (redeclared minimally
here to keep the suite self-contained, matching its FakeCategoryRepo/FakeTransactionRepo style).
"""

from decimal import Decimal


class FakeCategoryRepo:
    def __init__(self, categories=None):
        self._categories = categories or []

    def list_categories(self):
        return [dict(c) for c in self._categories]


class FakeTransactionRepo:
    def __init__(self, transactions=None):
        self._queue = [(list(transactions or []), None)]

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        return self._queue.pop(0) if self._queue else ([], None)


class FakePayCycleRepo:
    def __init__(self, length=14, last_pay_date="2024-01-03"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


def _category(cat_id, bucket, name=None):
    return {"id": cat_id, "name": name or cat_id.title(), "icon": "tag", "color": "#123456", "bucket": bucket}


def _transaction(category, amount, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status, "counts_to_budget": counts}


# --- [S1] per-source posted/pending clamp is INDEPENDENT; drop-guard is on the SUM -------------


def test_income_source_posted_reversal_kept_when_pending_positive(handler):
    # summarise_income clamps posted and pending SEPARATELY per source (via _summarise), and the
    # handler drops a source only when posted+pending <= 0. A source whose POSTED nets negative (a
    # settled clawback bigger than the settled pay) but which also has a POSITIVE PENDING (a new pay
    # run not yet settled) must SURVIVE with its posted floored to 0 — never dropped, never negative.
    # Fail-on-revert: pass clamp=False to summarise_income and posted reads -100 (a negative leaks to
    # the drill screen); a single aggregate clamp would instead zero the whole source and drop it.
    cats = FakeCategoryRepo([_category("salary", "Income")])
    txns = FakeTransactionRepo([
        _transaction("salary", 100, "posted"),
        _transaction("salary", -200, "posted"),   # settled clawback > the settled pay -> posted nets -100
        _transaction("salary", 300, "pending"),    # a new pending pay run
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {"salary": {"posted": Decimal("0"), "pending": Decimal("300")}}


def test_income_source_dropped_only_when_both_buckets_clamp_to_zero(handler):
    # The complement of the above: a source whose posted AND pending both net <= 0 (a full
    # clawback across both) clamps to {0,0} and is dropped entirely — no phantom $0 source row —
    # while a healthy sibling is unaffected. Fail-on-revert: drop the handler's `> 0` filter and
    # __income__ gains a "clawed": {0,0} row.
    cats = FakeCategoryRepo([_category("salary", "Income"), _category("clawed", "Income")])
    txns = FakeTransactionRepo([
        _transaction("salary", 2000, "posted"),
        _transaction("clawed", 100, "posted"),
        _transaction("clawed", -400, "posted"),    # posted nets -300
        _transaction("clawed", 50, "pending"),
        _transaction("clawed", -90, "pending"),      # pending nets -40 -> both buckets clamp to 0
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {"salary": {"posted": Decimal("2000"), "pending": Decimal("0")}}
    assert "clawed" not in result["__income__"]
