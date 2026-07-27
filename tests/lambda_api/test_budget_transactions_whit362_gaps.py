"""WHIT-362 — ADDITIONAL cross-endpoint penny-consistency coverage.

Adversarial gaps NOT touched by the two tests in test_budget_transactions.py
(test_refund_reconciles_across_endpoints / test_refund_that_clamps_the_header_still
_bounds_the_list). Same invariant, new axes:

  * the Income earn-target branch (summarise_income, sign=+1) — the existing tests
    only exercise the spend branch;
  * pending clamping INDEPENDENTLY of posted;
  * a whole-subtree net refund flooring BOTH buckets;
  * a refund that exactly cancels spend (net 0);
  * cross-sibling aggregate-then-clamp (WHIT-343) — a net-negative SUB must net
    against a positive parent BEFORE the floor, so the header can't exceed its own
    signed row list.

The universal invariant proven throughout: header (posted+pending, clamped) is
ALWAYS >= the signed sum of the visible rows, with EQUALITY whenever no bucket
clamps. Row sign is the client's, per bucket: spend reconciles on sum(-amount),
income on sum(+amount).
"""

import json
from datetime import date
from decimal import Decimal

# Repo fakes + row/event builders, shared with test_budget_transactions.py (tests/shared).
from _budget_endpoint_fakes import (
    _DateFilteringTransactionRepo,
    _FakeBudgetRepo,
    _FakeCategoryRepo,
    _FakePayCycleRepo,
    _event,
    _txn,
)


# Spend subtree (parent + sub, both Lifestyle) — mirrors the reviewed file.
SPEND_CATEGORIES = [
    {"id": "coffee", "bucket": "Lifestyle", "parent": None},
    {"id": "coffee-beans", "bucket": "Lifestyle", "parent": "coffee"},
]

# Income subtree (parent + sub, both Income) — needed for the earn-target branch.
INCOME_CATEGORIES = [
    {"id": "salary", "bucket": "Income", "parent": None},
    {"id": "bonus", "bucket": "Income", "parent": "salary"},
]


def _pin_today(monkeypatch):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))


def _header(handler, target_id, categories, transactions):
    return handler.list_budgets(
        _FakeBudgetRepo({target_id: {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(),
        _FakeCategoryRepo(categories),
    )[target_id]


def _rows(handler, target_id, categories, transactions):
    resp = handler.get_budget_transactions(
        _event(target_id), _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(), _FakeCategoryRepo(categories))
    assert resp["statusCode"] == 200
    return json.loads(resp["body"])


# --- Income earn-target branch (sign=+1) -------------------------------------


def test_income_target_reconciles_across_endpoints(handler, monkeypatch):
    # WHIT-362 — [A1] income earn-target reconciles across endpoints. gap: an Income-bucket target sums EARNINGS (summarise_income, +amount)
    # while the list still filters on contributes_to_budget. The list must reconcile on
    # sum(+amount) == posted+pending across the WHOLE income subtree, posted and pending.
    _pin_today(monkeypatch)
    transactions = [
        _txn("pay", "salary", 2000, "2026-07-05"),                     # posted earnings
        _txn("bonus", "bonus", 500, "2026-07-10"),                     # posted, sub-category
        _txn("pay2", "salary", 300, "2026-07-20", status="pending"),   # pending earnings
    ]
    header = _header(handler, "salary", INCOME_CATEGORIES, transactions)
    header_total = header["posted"] + header["pending"]  # 2500 posted + 300 pending

    rows = _rows(handler, "salary", INCOME_CATEGORIES, transactions)
    ids = [r["transaction_id"] for r in rows]
    assert set(ids) == {"pay", "bonus", "pay2"}            # subtree + both statuses listed
    listed = sum(Decimal(str(r["amount"])) for r in rows)  # income: +amount is the earning
    assert header["posted"] == Decimal("2500")
    assert header["pending"] == Decimal("300")
    assert listed == header_total == Decimal("2800")


def test_income_clawback_clamps_header_but_row_stays(handler, monkeypatch):
    # WHIT-362 — [A2] income clawback clamps header, row stays. gap: an income reversal/clawback (NEGATIVE amount on an income row) drives
    # the posted earnings bucket net-negative → the header floors at 0, but the list keeps
    # the clawback row. Header (0) never reads below the signed rows (-200).
    _pin_today(monkeypatch)
    transactions = [
        _txn("pay", "salary", 100, "2026-07-05"),        # +$100 earned
        _txn("clawback", "salary", -300, "2026-07-06"),  # -$300 reversal → posted nets -200
    ]
    header = _header(handler, "salary", INCOME_CATEGORIES, transactions)
    rows = _rows(handler, "salary", INCOME_CATEGORIES, transactions)

    assert "clawback" in [r["transaction_id"] for r in rows]     # reversal row still listed
    listed = sum(Decimal(str(r["amount"])) for r in rows)        # 100 - 300 = -200
    assert header["posted"] == 0 and header["pending"] == 0      # earnings floored, not negative
    assert header["posted"] + header["pending"] >= listed        # header never below the rows


# --- pending clamps independently of posted (spend) --------------------------


def test_pending_refund_clamps_pending_only_posted_untouched(handler, monkeypatch):
    # WHIT-362 — [A3] pending clamps independently, posted untouched. gap: a PENDING refund drives ONLY the pending bucket net-negative; the
    # posted bucket must be untouched and the pending floor must NOT bleed into posted.
    # (The existing clamp test only nets the posted bucket.)
    _pin_today(monkeypatch)
    transactions = [
        _txn("spend", "coffee", -40, "2026-07-10"),                          # $40 posted spend
        _txn("prefund", "coffee", 15, "2026-07-11", status="pending"),       # $15 pending refund
    ]
    header = _header(handler, "coffee", SPEND_CATEGORIES, transactions)
    rows = _rows(handler, "coffee", SPEND_CATEGORIES, transactions)

    assert {"spend", "prefund"} <= {r["transaction_id"] for r in rows}
    listed = sum(Decimal(str(-r["amount"])) for r in rows)   # 40 - 15 = 25
    assert header["posted"] == Decimal("40")                 # posted untouched by the pending floor
    assert header["pending"] == 0                            # pending -15 floored to 0
    assert header["posted"] + header["pending"] >= listed    # 40 >= 25


# --- whole-subtree net refund floors BOTH buckets ----------------------------


def test_all_refund_subtree_floors_both_buckets(handler, monkeypatch):
    # WHIT-362 — [A4] all-refund cycle floors both buckets. gap: a cycle that is ALL refunds across the subtree — posted AND pending
    # both net-negative. Both header buckets floor to 0; the list still shows every refund
    # row and its signed sum is negative, strictly below the floored header.
    _pin_today(monkeypatch)
    transactions = [
        _txn("refund_p", "coffee", 20, "2026-07-10"),                        # posted refund
        _txn("refund_pend", "coffee-beans", 10, "2026-07-11", status="pending"),  # pending refund, sub
    ]
    header = _header(handler, "coffee", SPEND_CATEGORIES, transactions)
    rows = _rows(handler, "coffee", SPEND_CATEGORIES, transactions)

    assert {"refund_p", "refund_pend"} == {r["transaction_id"] for r in rows}
    listed = sum(Decimal(str(-r["amount"])) for r in rows)   # -20 + -10 = -30
    assert listed == Decimal("-30")
    assert header["posted"] == 0 and header["pending"] == 0  # both bars floored
    assert header["posted"] + header["pending"] >= listed    # 0 >= -30


# --- refund exactly cancels spend (net 0) ------------------------------------


def test_refund_exactly_cancels_spend_net_zero(handler, monkeypatch):
    # WHIT-362 — [A5] refund exactly cancels spend (net 0). gap: refund exactly equals spend → header is 0 by NETTING (not by floor),
    # and the list shows BOTH rows summing to exactly 0. Reconciles with equality, no clamp.
    _pin_today(monkeypatch)
    transactions = [
        _txn("spend", "coffee", -25, "2026-07-10"),   # $25 spend
        _txn("refund", "coffee", 25, "2026-07-11"),   # $25 refund
    ]
    header = _header(handler, "coffee", SPEND_CATEGORIES, transactions)
    rows = _rows(handler, "coffee", SPEND_CATEGORIES, transactions)

    assert {"spend", "refund"} == {r["transaction_id"] for r in rows}   # both rows visible
    listed = sum(Decimal(str(-r["amount"])) for r in rows)              # 25 - 25 = 0
    assert header["posted"] == 0 and header["pending"] == 0
    assert listed == header["posted"] + header["pending"] == Decimal("0")


# --- cross-sibling aggregate-then-clamp (WHIT-343) ---------------------------


def test_net_negative_sub_nets_against_parent_before_floor(handler, monkeypatch):
    # WHIT-362 — [A6] cross-sibling aggregate-then-clamp (WHIT-343). gap the existing clamp test misses: a net-negative SUB
    # (coffee-beans refunded) must net against a POSITIVE parent (coffee spend) BEFORE the
    # single clamp. Header == listed == 30, with NO clamp. If the fold ever floored per-id
    # first (clamp=True), coffee-beans' -20 would floor to 0 and the header would read 50 —
    # strictly ABOVE its own row list. This locks header == listed, catching that inflation.
    _pin_today(monkeypatch)
    transactions = [
        _txn("parent_spend", "coffee", -50, "2026-07-10"),     # +$50 spend on the parent
        _txn("sub_refund", "coffee-beans", 20, "2026-07-11"),  # -$20 refund on the sub
    ]
    header = _header(handler, "coffee", SPEND_CATEGORIES, transactions)
    rows = _rows(handler, "coffee", SPEND_CATEGORIES, transactions)

    assert {"parent_spend", "sub_refund"} == {r["transaction_id"] for r in rows}
    listed = sum(Decimal(str(-r["amount"])) for r in rows)   # 50 - 20 = 30
    assert header["posted"] == Decimal("30")                 # netted, NOT 50 (per-id floor would give 50)
    assert header["pending"] == 0
    assert listed == header["posted"] + header["pending"] == Decimal("30")
