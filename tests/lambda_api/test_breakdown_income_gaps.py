"""WHIT-366/376 (QA gaps) — the __income__ per-source breakdown edges the implementer's
test_breakdown.py does NOT cover. Reuses that file's direct-call fakes (redeclared minimally
here to keep the suite self-contained, matching its FakeCategoryRepo/FakeTransactionRepo style).

WHIT-376 changed the contract: __income__ now carries the SIGNED per-source net (clamp=False), so
a source clawed back this cycle SURVIVES as a negative row (the drill screen renders it "−$X" and
reconciles the rows to __earned__), and only an exact-$0-net source is dropped.
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


# --- [S1] per-source net is SIGNED (clamp=False); only an exact-$0 source is dropped -----------


def test_income_source_keeps_signed_posted_when_pending_positive(handler):
    # A source whose SETTLED bucket nets negative (a settled clawback bigger than the settled pay)
    # but which also has a POSITIVE PENDING (a new pay run not yet settled) SURVIVES with its raw
    # SIGNED buckets — posted -100, pending 300 (WHIT-376) — never floored, never dropped. This is
    # the sign-split case whose client-side residual the "adjustment" plug fills.
    # Fail-on-revert: revert summarise_income to clamp=True and posted floors to 0 -> {0,300}.
    cats = FakeCategoryRepo([_category("salary", "Income")])
    txns = FakeTransactionRepo([
        _transaction("salary", 100, "posted"),
        _transaction("salary", -200, "posted"),   # settled clawback > the settled pay -> posted nets -100
        _transaction("salary", 300, "pending"),    # a new pending pay run
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {"salary": {"posted": Decimal("-100"), "pending": Decimal("300")}}


def test_income_source_kept_signed_even_when_net_negative(handler):
    # A source whose posted AND pending both net negative (a full clawback across both) now SURVIVES
    # as a signed negative row (net -340), so the drill screen can show it as a "−$340" reversal and
    # the rows still reconcile to __earned__ — a healthy sibling keeps the aggregate positive so
    # __earned__/__income__ are emitted. Fail-on-revert: revert to clamp=True + the `> 0` filter and
    # "clawed" floors to {0,0} and is dropped.
    cats = FakeCategoryRepo([_category("salary", "Income"), _category("clawed", "Income")])
    txns = FakeTransactionRepo([
        _transaction("salary", 2000, "posted"),
        _transaction("clawed", 100, "posted"),
        _transaction("clawed", -400, "posted"),    # posted nets -300
        _transaction("clawed", 50, "pending"),
        _transaction("clawed", -90, "pending"),      # pending nets -40
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {
        "salary": {"posted": Decimal("2000"), "pending": Decimal("0")},
        "clawed": {"posted": Decimal("-300"), "pending": Decimal("-40")},  # kept, signed
    }


# --- [S2] the OTHER clamp bucket + multi-reversal reconciliation ------------------------------


def test_income_source_keeps_signed_negative_pending_earned_clamps_that_bucket(handler):
    # WHIT-376 gap: the existing sign-split test clamps the SETTLED bucket. The mirror case — a
    # PENDING reversal (a pending pay run pulled back) larger than nothing, with settled positive —
    # must keep the source's raw SIGNED pending (-100), while __earned__ (aggregate clamp) floors
    # its pending bucket to 0. So __earned__ (2000) EXCEEDS the source net (1900) by the clamped-away
    # pending reversal — the residual the client's "adjustment" plug fills in the pending direction.
    # Fail-on-revert: revert summarise_income to clamp=True and pending floors to 0 -> {2000, 0}.
    cats = FakeCategoryRepo([_category("salary", "Income")])
    txns = FakeTransactionRepo([
        _transaction("salary", 2000, "posted"),
        _transaction("salary", -100, "pending"),  # a pending clawback -> pending nets -100
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {"salary": {"posted": Decimal("2000"), "pending": Decimal("-100")}}
    assert result["__earned__"] == {"posted": Decimal("2000"), "pending": Decimal("0")}  # pending clamped
    earned_total = result["__earned__"]["posted"] + result["__earned__"]["pending"]  # 2000
    source_total = result["__income__"]["salary"]["posted"] + result["__income__"]["salary"]["pending"]  # 1900
    assert earned_total - source_total == Decimal("100")  # the residual, in the pending bucket


def test_income_multiple_reversed_sources_all_survive_and_reconcile(handler):
    # WHIT-376 invariant with MORE THAN ONE reversal: two distinct sources clawed back this cycle
    # must BOTH survive as signed negative rows, and the per-source list must still reconcile to
    # __earned__ (2000 - 100 - 50 == 1850). Guards against a per-source clamp reappearing that only
    # shows up once several negatives exist. Fail-on-revert: revert to clamp=True + the `> 0` filter
    # and both bonus rows drop, so the sources sum to 2000 (not 1850) and the __income__ map shrinks.
    cats = FakeCategoryRepo([
        _category("salary", "Income"),
        _category("bonus_a", "Income"),
        _category("bonus_b", "Income"),
    ])
    txns = FakeTransactionRepo([
        _transaction("salary", 2000, "posted"),
        _transaction("bonus_a", 40, "posted"),
        _transaction("bonus_a", -140, "posted"),  # nets -100
        _transaction("bonus_b", -50, "posted"),   # nets -50
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {
        "salary": {"posted": Decimal("2000"), "pending": Decimal("0")},
        "bonus_a": {"posted": Decimal("-100"), "pending": Decimal("0")},
        "bonus_b": {"posted": Decimal("-50"), "pending": Decimal("0")},
    }
    assert result["__earned__"] == {"posted": Decimal("1850"), "pending": Decimal("0")}
    total_sources = sum(
        (v["posted"] + v["pending"] for v in result["__income__"].values()), Decimal("0")
    )
    earned = result["__earned__"]
    assert total_sources == earned["posted"] + earned["pending"]  # rows reconcile to the headline
