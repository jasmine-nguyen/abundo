"""Tests for GET /budgets/{category}/transactions (get_budget_transactions) — the
transactions behind a budget's total, so the budget-detail list reconciles with the
header instead of the old rolling 7-day feed.

The endpoint MUST derive its rows from the SAME window (_cycle_window_for) + subtree
(subtree_ids) + contribution rule (contributes_to_budget) as list_budgets, so the
headline test proves sum(list rows) == /budgets total for the same id + data.
"""

import json
from datetime import date
from decimal import Decimal

import pytest

# Repo fakes + row/event builders, shared with the folded WHIT-362 gap tests (tests/shared).
from _budget_endpoint_fakes import (
    _DateFilteringTransactionRepo,
    _FakeBudgetRepo,
    _FakeCategoryRepo,
    _FakePayCycleRepo,
    _event,
    _txn,
)


# A parent Cafes-&-Coffee budget with a sub-category (both same bucket, so the sub
# rolls into the parent's total + subtree).
CATEGORIES = [
    {"id": "coffee", "bucket": "Lifestyle", "parent": None},
    {"id": "coffee-beans", "bucket": "Lifestyle", "parent": "coffee"},
]


# The reported screenshot: cycle 01–25 Jul, total $52, but only the last-7-days rows
# were visible. These are the rows behind that $52.
def _screenshot_transactions():
    return [
        _txn("t1", "coffee", -11, "2026-07-21"),
        _txn("t2", "coffee", -12.5, "2026-07-20"),
        _txn("t3", "coffee", -17, "2026-07-13"),          # in-cycle but > 7 days old
        _txn("t4", "coffee-beans", -11.5, "2026-07-12"),  # sub-category, > 7 days old
        _txn("t5", "coffee", -9, "2026-07-19", counts=False),   # !counts_to_budget
        _txn("t6", "coffee", -4, "2026-07-19", excluded=True),  # budget_excluded
        _txn("t7", "coffee", -100, "2026-06-30"),         # BEFORE cycle_start
    ]


def test_list_reconciles_with_budget_total(handler, monkeypatch):
    # THE headline fail-on-revert: the rows sum to the /budgets header, over the WHOLE
    # cycle and the WHOLE subtree. Reverting the subtree filter drops t4; reverting to a
    # 7-day feed drops t3/t4; both flip this. contributes drops t5/t6; the window drops t7.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))

    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(_screenshot_transactions()),
        _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES),
    )["coffee"]
    total_spend = total["posted"] + total["pending"]

    txn_repo = _DateFilteringTransactionRepo(_screenshot_transactions())
    resp = handler.get_budget_transactions(
        _event("coffee"), txn_repo, _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))

    assert resp["statusCode"] == 200
    rows = json.loads(resp["body"])
    assert [r["transaction_id"] for r in rows] == ["t1", "t2", "t3", "t4"]  # newest-first
    listed = sum(Decimal(str(-r["amount"])) for r in rows)
    assert listed == total_spend == Decimal("52.0")
    # The window is the whole cycle [cycle_start, today] — NOT a 7-day feed.
    assert txn_repo.calls[0][1] == "2026-07-01"
    assert txn_repo.calls[0][2] == "2026-07-25"


def test_refund_reconciles_across_endpoints(handler, monkeypatch):
    # WHIT-362: a refund (positive amount) that does NOT drive a bucket negative still
    # reconciles across both endpoints — the list shows the refund row and its signed sum
    # equals the /budgets header, cent-for-cent, across posted + pending and the subtree.
    # Reverting either endpoint's window/subtree/contributes filter (or dropping the
    # refund row from the list) breaks the equality.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    transactions = [
        _txn("spend", "coffee", -30, "2026-07-10"),          # $30 posted spend
        _txn("refund", "coffee-beans", 10, "2026-07-11"),    # $10 posted refund (sub-category)
        _txn("pending", "coffee", -5, "2026-07-12", status="pending"),  # $5 pending spend
    ]

    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES),
    )["coffee"]
    header_spend = total["posted"] + total["pending"]  # 30 - 10 refund + 5 pending = 25

    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))
    rows = json.loads(resp["body"])

    assert "refund" in [r["transaction_id"] for r in rows]   # the list keeps the refund row
    listed = sum(Decimal(str(-r["amount"])) for r in rows)   # refund's +10 subtracts here too
    assert listed == header_spend == Decimal("25")


def test_refund_that_clamps_the_header_still_bounds_the_list(handler, monkeypatch):
    # WHIT-362: when refunds drive a status bucket net-negative, the header floors at 0
    # (a bar can't go negative — the aggregate-then-clamp rule) while the list still shows
    # every refund row. The invariant the user relies on: the header never reads BELOW the
    # signed sum of the visible rows. Locks header >= listed and both buckets >= 0 — goes
    # RED if the list ever drops refund rows (listed rises above the floored header) or the
    # rollup stops clamping (a bucket goes negative).
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    transactions = [
        _txn("spend", "coffee", -10, "2026-07-10"),    # $10 posted spend
        _txn("refund", "coffee", 30, "2026-07-11"),    # $30 posted refund → posted nets -20
    ]

    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES),
    )["coffee"]

    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))
    rows = json.loads(resp["body"])

    assert "refund" in [r["transaction_id"] for r in rows]   # refund row is still listed
    listed = sum(Decimal(str(-r["amount"])) for r in rows)   # 10 - 30 = -20 (net refund)
    assert total["posted"] >= 0 and total["pending"] >= 0    # clamp holds — no negative bar
    assert total["posted"] == 0                              # -20 floored to 0
    assert total["posted"] + total["pending"] >= listed      # header never reads below the rows


def test_null_amount_row_does_not_break_the_header_and_stays_in_the_list(handler, monkeypatch):
    # WHIT-362: a contributing row with a missing/None amount (malformed data) must not
    # 500 the /budgets header — it counts as $0 — while /budgets/{id}/transactions still
    # lists it. Fail-on-revert: reverting _spend_contribution to Decimal(str(amount)) makes
    # list_budgets raise on Decimal("None"), so this test errors.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    null_row = {
        "transaction_id": "null_amt", "category": "coffee", "amount": None,
        "status": "posted", "counts_to_budget": True, "date": "2026-07-11",
        "pk": "ACCT#up-spending", "sk": "TXN#null_amt",
    }
    transactions = [_txn("spend", "coffee", -10, "2026-07-10"), null_row]

    total = handler.list_budgets(
        _FakeBudgetRepo({"coffee": {"target": Decimal("80")}}),
        _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))["coffee"]
    assert total["posted"] == Decimal("10")   # the None row counts as $0, only the real $10 spend

    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(transactions),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))
    assert "null_amt" in [r["transaction_id"] for r in json.loads(resp["body"])]


def test_excludes_non_contributing_rows(handler, monkeypatch):
    # budget_excluded, !counts_to_budget and an unknown status never appear (they're not
    # in the total either), so the eyeballed rows can't disagree with the header.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    txns = [
        _txn("keep", "coffee", -10, "2026-07-10"),
        _txn("nocount", "coffee", -10, "2026-07-10", counts=False),
        _txn("excluded", "coffee", -10, "2026-07-10", excluded=True),
        _txn("unknown", "coffee", -10, "2026-07-10", status="cancelled"),
    ]
    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES))

    assert [r["transaction_id"] for r in json.loads(resp["body"])] == ["keep"]


def test_strips_pk_sk(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    resp = handler.get_budget_transactions(
        _event("coffee"),
        _DateFilteringTransactionRepo([_txn("t1", "coffee", -5, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATEGORIES))

    row = json.loads(resp["body"])[0]
    assert "pk" not in row and "sk" not in row


def test_missing_category_id_returns_404(handler):
    event = {"rawPath": "/budgets//transactions",
             "requestContext": {"http": {"method": "GET"}},
             "pathParameters": {}}
    resp = handler.get_budget_transactions(
        event, _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES))

    assert resp["statusCode"] == 404


def test_empty_cycle_returns_empty_list(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2026, 7, 25))
    resp = handler.get_budget_transactions(
        _event("coffee"), _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATEGORIES))

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


# --- routing -----------------------------------------------------------------


def test_router_dispatches_budget_transactions(handler, monkeypatch):
    # GET /budgets/{id}/transactions reaches the new handler, NOT list_budgets.
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: object())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: object())
    monkeypatch.setattr(handler, "get_budget_transactions",
                        lambda *a: handler._json_response(200, [{"transaction_id": "sentinel"}]))
    monkeypatch.setattr(handler, "list_budgets",
                        lambda *a: pytest.fail("collection route reached from the item path"))

    resp = handler.lambda_handler(_event("coffee"), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])[0]["transaction_id"] == "sentinel"


def test_router_put_budget_not_captured_by_transactions_route(handler, monkeypatch):
    # A PUT /budgets/{id} must still reach set_budget, never the GET transactions handler.
    monkeypatch.setattr(handler, "BudgetRepository", lambda: object())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: object())
    monkeypatch.setattr(handler, "get_budget_transactions",
                        lambda *a: pytest.fail("PUT reached the GET transactions handler"))
    monkeypatch.setattr(handler, "set_budget",
                        lambda *a: handler._json_response(200, {"id": "coffee", "target": 58}))

    resp = handler.lambda_handler(
        {"rawPath": "/budgets/coffee", "requestContext": {"http": {"method": "PUT"}},
         "pathParameters": {"category": "coffee"}, "body": '{"target": 58}'}, None)

    assert resp["statusCode"] == 200


# === adversarial GAP tests (folded from test_budget_transactions_gaps.py) — refunds,
# net-negative divergence, income earn-target subtree, cross-bucket subtree handling. The
# repo fakes / _txn / _event are the shared _budget_endpoint_fakes imported above. ==========


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


# === WHIT-362 penny-consistency GAP tests (folded from test_budget_transactions_whit362_gaps.py)
# — the income earn-target branch, pending clamping independent of posted, whole-subtree net
# refund, net-zero cancel, and cross-sibling aggregate-then-clamp. Reuses _pin_today above. ==


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
