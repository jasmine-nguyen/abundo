"""Tests for GET /categories/{id}/transactions (get_category_transactions) — the
transactions behind one /breakdown row, so the category drill-in reconciles with the
Insights card instead of reading the rolling 7-day feed.

Reconciliation is the headline: the endpoint's rows (clamped the way the client + server
summarise do) must equal list_category_breakdown[id] for the same fixture — for a named
category AND the uncategorized bucket, over the current and a prior cycle.
"""

import json
from datetime import date
from decimal import Decimal

import pytest

from _api_event import api_event
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _transaction_range_fakes import _AccountTransactionRepo, _DateFilteringTransactionRepo


def _contributes(transaction):
    # Mirror of shared/spend.py contributes_to_budget (imported lazily is fragile at collect
    # time). Kept local like the other test fakes; the reconciliation asserts against the real
    # list_category_breakdown too, so any drift here is caught.
    if not transaction.get("counts_to_budget") or transaction.get("budget_excluded"):
        return False
    return transaction["status"] in ("posted", "pending")


# --- fakes (local; mirror test_budget_transactions.py) -----------------------


# A parent Cafes & Coffee with a same-bucket sub-category (so a subtree bug would leak it).
CATS = [
    {"id": "coffee", "bucket": "Lifestyle", "parent": None},
    {"id": "coffee-beans", "bucket": "Lifestyle", "parent": "coffee"},
]


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


def _event(category_id="coffee", cycle=None):
    query = {"cycle": cycle} if cycle is not None else None
    return api_event("GET", f"/categories/{category_id}/transactions", path_params={"id": category_id}, query=query)


def _pin_today(monkeypatch, day=date(2026, 7, 25)):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: day)


def _clamped_total(rows):
    """The rows' contributing spend, clamped per bucket at >= 0 then summed — the same
    reconciliation math the client (categoryTransactions) and /breakdown (summarise) use."""
    posted = sum((-Decimal(str(r["amount"])) for r in rows
                  if _contributes(r) and r["status"] == "posted"), Decimal(0))
    pending = sum((-Decimal(str(r["amount"])) for r in rows
                   if _contributes(r) and r["status"] == "pending"), Decimal(0))
    return max(Decimal(0), posted) + max(Decimal(0), pending)


# --- reconciliation ----------------------------------------------------------


def test_named_category_reconciles_with_breakdown_exact_not_subtree(handler, monkeypatch):
    # The headline: the drilled rows sum to the /breakdown row for the SAME id, over the whole
    # cycle (incl. a >7-day-old charge the feed would miss). EXACT category — a sub-category's
    # rows are NOT folded in (that's what makes it match /breakdown, which is per-id).
    # FAIL-ON-REVERT: adopting subtree_ids would pull 'beans' in and break both assertions.
    _pin_today(monkeypatch)
    txns = [
        _txn("c1", "coffee", -11, "2026-07-21"),
        _txn("c2", "coffee", -17, "2026-07-08"),          # > 7 days old, in cycle
        _txn("beans", "coffee-beans", -9, "2026-07-09"),  # sub-category → must NOT appear
    ]
    breakdown = handler.list_category_breakdown(
        _FakeCategoryRepo(CATS), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo())

    resp = handler.get_category_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    rows = json.loads(resp["body"])

    assert [r["transaction_id"] for r in rows] == ["c1", "c2"]  # newest-first, no 'beans'
    card = breakdown["coffee"]
    assert _clamped_total(rows) == card["posted"] + card["pending"] == Decimal("28")


def test_named_list_shows_refund_and_excluded_but_total_excludes_them(handler, monkeypatch):
    # A named category LISTS refunds + budget-excluded rows (like the tab), but the reconciling
    # total counts only contributors — matching /breakdown.
    _pin_today(monkeypatch)
    txns = [
        _txn("spend", "coffee", -20, "2026-07-10"),
        _txn("refund", "coffee", 5, "2026-07-11"),
        _txn("excluded", "coffee", -8, "2026-07-12", excluded=True),
    ]
    breakdown = handler.list_category_breakdown(
        _FakeCategoryRepo(CATS), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo())
    resp = handler.get_category_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    rows = json.loads(resp["body"])

    assert {r["transaction_id"] for r in rows} == {"spend", "refund", "excluded"}  # all listed
    card = breakdown["coffee"]
    assert _clamped_total(rows) == card["posted"] + card["pending"] == Decimal("15")  # 20 - 5


def test_uncategorized_reconciles_and_excludes_income_mapped_transfer(handler, monkeypatch):
    # The uncategorized bucket matches /breakdown's __uncategorized__: contributing unmapped spend
    # only — income, a mapped category, and a not-in-budget transfer (counts_to_budget=false) are
    # all excluded. FAIL-ON-REVERT: dropping the contributes_to_budget/taxonomy filter leaks them.
    _pin_today(monkeypatch)
    txns = [
        _txn("u1", None, -30, "2026-07-10"),
        _txn("u2", "RAW_ENUM", -8, "2026-07-11"),               # unknown id → uncategorized
        _txn("income", "income", 500, "2026-07-10"),            # income sentinel → excluded
        _txn("mapped", "coffee", -20, "2026-07-10"),            # in taxonomy → excluded
        _txn("transfer", None, -500, "2026-07-10", counts=False),  # not-in-budget → excluded
    ]
    breakdown = handler.list_category_breakdown(
        _FakeCategoryRepo(CATS), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo())
    resp = handler.get_category_transactions(
        _event("__uncategorized__"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    rows = json.loads(resp["body"])

    assert [r["transaction_id"] for r in rows] == ["u2", "u1"]  # newest-first, only unmapped spend
    card = breakdown["__uncategorized__"]
    assert _clamped_total(rows) == card["posted"] + card["pending"] == Decimal("38")


# --- cycle look-back ---------------------------------------------------------


def test_prior_cycle_uses_the_nth_prior_window(handler, monkeypatch):
    # ?cycle=1 windows the PRIOR full cycle (the fix for the always-empty "last cycle" drill).
    # With last_pay_date 2026-07-01 length 30, cycle 0 = [2026-07-01, today]; cycle 1 =
    # [2026-06-01, 2026-06-30]. A charge dated in June shows for cycle=1, not cycle=0.
    _pin_today(monkeypatch)
    txns = [
        _txn("this", "coffee", -10, "2026-07-10"),
        _txn("last", "coffee", -20, "2026-06-15"),
    ]
    current = json.loads(handler.get_category_transactions(
        _event("coffee", cycle="0"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))["body"])
    prior_repo = _DateFilteringTransactionRepo(txns)
    prior = json.loads(handler.get_category_transactions(
        _event("coffee", cycle="1"), prior_repo, _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))["body"])

    assert [r["transaction_id"] for r in current] == ["this"]
    assert [r["transaction_id"] for r in prior] == ["last"]
    assert prior_repo.calls[0][1] == "2026-06-01"  # prior window start
    assert prior_repo.calls[0][2] == "2026-06-30"  # prior window end


def test_empty_prior_cycle_returns_empty_list(handler, monkeypatch):
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _event("coffee", cycle="1"),
        _DateFilteringTransactionRepo([_txn("this", "coffee", -10, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


def test_cycle_out_of_range_returns_400(handler):
    resp = handler.get_category_transactions(
        _event("coffee", cycle="13"), _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 400


# --- shape / edges -----------------------------------------------------------


def test_missing_category_id_returns_404(handler):
    event = api_event("GET", "/categories//transactions", path_params={})
    resp = handler.get_category_transactions(
        event, _DateFilteringTransactionRepo([]), _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 404


def test_strips_pk_sk(handler, monkeypatch):
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _event("coffee"),
        _DateFilteringTransactionRepo([_txn("c1", "coffee", -5, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    row = json.loads(resp["body"])[0]
    assert "pk" not in row and "sk" not in row


def test_matches_a_weird_id_by_exact_equality(handler, monkeypatch):
    # An id carrying '/' or '__' (a route round-trips it via encodeURIComponent) is matched by
    # exact string equality — the endpoint does NO id parsing. (Moved from the client gaps.)
    _pin_today(monkeypatch)
    weird = "food/sub__direct"
    txns = [
        _txn("w1", weird, -7, "2026-07-10"),
        _txn("other", "food", -7, "2026-07-10"),
    ]
    resp = handler.get_category_transactions(
        _event(weird), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo([{"id": weird, "bucket": "Living", "parent": None},
                           {"id": "food", "bucket": "Living", "parent": None}]))
    assert [r["transaction_id"] for r in json.loads(resp["body"])] == ["w1"]


# --- routing -----------------------------------------------------------------


def test_router_dispatches_category_transactions(handler, monkeypatch):
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: object())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: object())
    monkeypatch.setattr(handler, "get_category_transactions",
                        lambda *a: handler._json_response(200, [{"transaction_id": "sentinel"}]))
    monkeypatch.setattr(handler, "update_category",
                        lambda *a: pytest.fail("PATCH handler reached from a GET transactions path"))

    resp = handler.lambda_handler(_event("coffee"), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])[0]["transaction_id"] == "sentinel"


def test_router_patch_category_not_captured_by_transactions_route(handler, monkeypatch):
    monkeypatch.setattr(handler, "CategoryRepository", lambda: object())
    monkeypatch.setattr(handler, "BudgetRepository", lambda: object())
    monkeypatch.setattr(handler, "get_category_transactions",
                        lambda *a: pytest.fail("PATCH reached the GET transactions handler"))
    monkeypatch.setattr(handler, "update_category",
                        lambda *a: handler._json_response(200, {"id": "coffee"}))

    resp = handler.lambda_handler(
        api_event("PATCH", "/categories/coffee", raw="{}", path_params={"id": "coffee"}), None)

    assert resp["statusCode"] == 200


# ======================================================================================
# Folded from test_category_transactions_gaps.py (WHIT-462, adversarial gaps WHIT-342).
# The identical helpers (_contributes/_FakePayCycleRepo/_FakeCategoryRepo/_event/
# _pin_today/_clamped_total) reuse the ones above; only the account-aware _txn
# (=> _txn_acct) and the single-entry CATS (=> CATS_SINGLE) are kept local. Test bodies
# otherwise verbatim.
# ======================================================================================

CATS_SINGLE = [{"id": "coffee", "bucket": "Lifestyle", "parent": None}]


def _txn_acct(txn_id, category, amount, date_, status="posted", counts=True, excluded=False,
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


def test_refund_and_pending_in_same_category_clamp_independently_and_reconcile(handler, monkeypatch):
    # One category, one posted refund that nets the POSTED bucket negative, plus live PENDING
    # spend. The pending bucket must NOT be eaten by the posted refund (independent clamp), and
    # the drilled total must still equal /breakdown for the same id.
    # FAIL-ON-REVERT: an aggregate (single) clamp would net posted+pending = (10-25)+8 = 0 -> the
    # drill/breakdown would read 8 vs this asserts 8 only because pending is clamped on its own.
    _pin_today(monkeypatch)
    txns = [
        _txn_acct("spend", "coffee", -10, "2026-07-10", status="posted"),
        _txn_acct("refund", "coffee", 25, "2026-07-11", status="posted"),   # posted bucket -> max(0, -15)=0
        _txn_acct("live", "coffee", -8, "2026-07-12", status="pending"),    # pending bucket -> 8
    ]
    breakdown = handler.list_category_breakdown(
        _FakeCategoryRepo(CATS_SINGLE), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo())
    resp = handler.get_category_transactions(
        _event("coffee"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS_SINGLE))
    rows = json.loads(resp["body"])

    assert {r["transaction_id"] for r in rows} == {"spend", "refund", "live"}  # all listed
    card = breakdown["coffee"]
    assert card["posted"] == Decimal("0")           # posted refund clamps its own bucket
    assert card["pending"] == Decimal("8")          # pending untouched by the posted refund
    assert _clamped_total(rows) == card["posted"] + card["pending"] == Decimal("8")


def test_known_category_with_zero_rows_this_cycle_returns_empty_200(handler, monkeypatch):
    # The category exists, but nothing landed on it this cycle -> empty 200 list (the drill's
    # empty state), NOT an error. Distinct from the prior-cycle-empty test: here the id is real.
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _event("coffee"),
        _DateFilteringTransactionRepo([_txn_acct("g1", "groceries", -10, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS_SINGLE))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


def test_totally_unknown_id_returns_empty_200_not_404(handler, monkeypatch):
    # A present-but-unknown id (never a real category) is matched by exact equality -> no rows ->
    # empty 200. Only a MISSING/blank path id is 404. FAIL-ON-REVERT: a "must exist in taxonomy
    # else 404" guard on the named branch would 404 here instead.
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _event("does-not-exist-anywhere"),
        _DateFilteringTransactionRepo([_txn_acct("c1", "coffee", -10, "2026-07-10")]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS_SINGLE))
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == []


def test_merges_same_category_rows_across_accounts_newest_first(handler, monkeypatch):
    # A category's charges span TWO accounts (up-spending + anz-rewards-black-visa). The drill
    # must merge both accounts' rows and sort the merged set newest-first — the per-account loop
    # in read_window, which the pool-once fake never exercises.
    # FAIL-ON-REVERT: breaking to a single-account fetch (dropping the loop) drops 'anz1'.
    _pin_today(monkeypatch)
    txns = [
        _txn_acct("up1", "coffee", -10, "2026-07-10", account_id="up-spending"),
        _txn_acct("anz1", "coffee", -20, "2026-07-20", account_id="anz-rewards-black-visa"),
        _txn_acct("up2", "coffee", -5, "2026-07-05", account_id="up-spending"),
    ]
    repo = _AccountTransactionRepo(txns)
    resp = handler.get_category_transactions(
        _event("coffee"), repo, _FakePayCycleRepo(), _FakeCategoryRepo(CATS_SINGLE))
    rows = json.loads(resp["body"])

    assert [r["transaction_id"] for r in rows] == ["anz1", "up1", "up2"]  # merged, newest-first
    # every account in the map was queried (the merge really looped, not short-circuited)
    assert {"up-spending", "anz-rewards-black-visa"} <= {c[0] for c in repo.calls}


def test_uncategorized_merges_across_accounts_and_still_filters(handler, monkeypatch):
    # The uncategorized bucket over two accounts: an unmapped in-budget charge on each is kept,
    # but a not-in-budget transfer on one account is dropped by the contributes_to_budget gate.
    _pin_today(monkeypatch)
    txns = [
        _txn_acct("u_up", None, -30, "2026-07-10", account_id="up-spending"),
        _txn_acct("u_anz", None, -40, "2026-07-12", account_id="anz-rewards-black-visa"),
        _txn_acct("xfer", None, -500, "2026-07-11", counts=False, account_id="up-spending"),
    ]
    resp = handler.get_category_transactions(
        _event("__uncategorized__"), _AccountTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS_SINGLE))
    rows = json.loads(resp["body"])
    assert [r["transaction_id"] for r in rows] == ["u_anz", "u_up"]


def test_negative_cycle_returns_400(handler):
    resp = handler.get_category_transactions(
        _event("coffee", cycle="-1"), _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS_SINGLE))
    assert resp["statusCode"] == 400


def test_non_integer_cycle_returns_400(handler):
    resp = handler.get_category_transactions(
        _event("coffee", cycle="abc"), _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS_SINGLE))
    assert resp["statusCode"] == 400


# ======================================================================================
# Date-range mode (card 609): ?from=&to= — the Ask Abundo chat's deep link.
# ======================================================================================


def _range_event(category_id="coffee", date_from="2026-06-01", date_to="2026-07-20", cycle=None):
    event = _event(category_id)
    event["queryStringParameters"] = {"from": date_from, "to": date_to}
    if cycle is not None:
        event["queryStringParameters"]["cycle"] = cycle
    return event


def test_range_mode_includes_subcategories_so_it_matches_the_chat_figure(handler, monkeypatch):
    # FAIL-ON-REVERT: the exact match cycle mode uses would drop 'beans' and the list would no
    # longer add up to the chat's folded figure.
    _pin_today(monkeypatch)
    txns = [
        _txn("c1", "coffee", -11, "2026-07-21"),              # after `to` -> out
        _txn("c2", "coffee", -17, "2026-07-08"),
        _txn("beans", "coffee-beans", -9, "2026-06-09"),       # sub-category -> in
        _txn("old", "coffee", -5, "2026-05-31"),               # before `from` -> out
    ]
    repo = _DateFilteringTransactionRepo(txns)
    resp = handler.get_category_transactions(
        _range_event(), repo, _FakePayCycleRepo(), _FakeCategoryRepo(CATS))

    assert resp["statusCode"] == 200
    assert [r["transaction_id"] for r in json.loads(resp["body"])] == ["c2", "beans"]
    assert repo.calls[0][1:3] == ("2026-06-01", "2026-07-20")


def test_range_mode_uncategorized_uses_the_unfiled_rule(handler, monkeypatch):
    _pin_today(monkeypatch)
    txns = [_txn("u1", None, -30, "2026-07-10"), _txn("mapped", "coffee", -20, "2026-07-10")]
    resp = handler.get_category_transactions(
        _range_event("__uncategorized__"), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    assert [r["transaction_id"] for r in json.loads(resp["body"])] == ["u1"]


@pytest.mark.parametrize("date_from, date_to", [
    ("2026-07-01", None),               # only one end
    ("2026-7-1", "2026-07-20"),         # not ISO
    ("2026-02-30", "2026-07-20"),       # not a real day
    ("2026-07-20", "2026-07-01"),       # out of order
    ("2026-07-01", "2026-07-26"),       # after today (2026-07-25)
    ("2025-05-31", "2026-07-20"),       # before the lookback floor + one period of grace (2025-06-01)
])
def test_range_mode_rejects_bad_or_out_of_bounds_dates(handler, monkeypatch, date_from, date_to):
    _pin_today(monkeypatch)
    event = _event("coffee")
    event["queryStringParameters"] = {"from": date_from, "to": date_to}
    repo = _DateFilteringTransactionRepo([])
    resp = handler.get_category_transactions(event, repo, _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 400
    assert repo.calls == []


def test_range_mode_accepts_the_lookback_floor_itself(handler, monkeypatch):
    # The chat's floor is 2025-07-01; the drill-in reaches one period further (2025-06-01).
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _range_event(date_from="2025-06-01", date_to="2026-07-25"), _DateFilteringTransactionRepo([]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 200


def test_a_full_year_link_still_opens_after_the_floor_moves(handler, monkeypatch):
    # A "last 12 months" answer written on 25 Jul links from the chat's floor, 2025-07-01. On
    # 1 Aug the chat's floor moves to 2025-08-01; the link must still open, not 400.
    _pin_today(monkeypatch, day=date(2026, 8, 1))
    resp = handler.get_category_transactions(
        _range_event(date_from="2025-07-01", date_to="2026-07-25"), _DateFilteringTransactionRepo([]),
        _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 200


def test_range_and_cycle_together_is_a_400(handler, monkeypatch):
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _range_event(cycle="1"), _DateFilteringTransactionRepo([]), _FakePayCycleRepo(),
        _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 400


def test_range_mode_leaves_out_a_cross_bucket_subcategory(handler, monkeypatch):
    # [A12] The subtree is SAME-bucket only (subtree_ids with the bucket map), like /budgets and
    # the chat figure. An Income sub filed under a spend parent must not land in the list.
    _pin_today(monkeypatch)
    cats = CATS + [{"id": "coffee-cashback", "bucket": "Income", "parent": "coffee"}]
    txns = [_txn("c1", "coffee", -17, "2026-07-08"),
            _txn("cb", "coffee-cashback", 5, "2026-07-09")]
    resp = handler.get_category_transactions(
        _range_event(), _DateFilteringTransactionRepo(txns), _FakePayCycleRepo(), _FakeCategoryRepo(cats))
    assert [r["transaction_id"] for r in json.loads(resp["body"])] == ["c1"]


def test_an_empty_cycle_beside_a_range_is_not_both(handler, monkeypatch):  # QA [A20]
    # "?cycle=&from=…&to=…" (an empty cycle) is range mode, not "cycle AND range" — no 400.
    _pin_today(monkeypatch)
    resp = handler.get_category_transactions(
        _range_event(date_from="2026-07-01", date_to="2026-07-20", cycle=""),
        _DateFilteringTransactionRepo([]), _FakePayCycleRepo(), _FakeCategoryRepo(CATS))
    assert resp["statusCode"] == 200
