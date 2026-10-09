"""Tests for the budget-target endpoints (GET /budgets, PUT /budgets/{category})
and BudgetRepository.

Handler-level tests inject the REAL BudgetRepository over a FakeTable with a spy on its
calls (_budget_fakes.recording_budget_repo). Repository tests run it over the shared
FakeTable directly (WHIT-625). The budget write is an idempotent UPSERT
(`SET #items.#id = :val`) — setting the same category's target twice must overwrite,
never raise.

The `handler` fixture (conftest.py) makes lambda_api importable in isolation and
puts `shared/` on the path, so `import repository_budget` inside a test resolves to
shared/repository_budget.py with boto3/botocore already faked.
"""

import json
from datetime import date
from decimal import Decimal
from functools import partial

import pytest

from _api_event import api_event
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo, _SpendCategoryRepo, _spend_cat
from _budget_fakes import recording_budget_repo
from _transaction_range_fakes import _DateFilteringTransactionRepo, _QueuedTransactionRepo


def _put_budget_event(category="coffee", body='{"target": 58}', is_b64=False):
    return api_event(
        "PUT",
        f"/budgets/{category}",
        raw=body,
        path_params={"category": category},
        is_base64=is_b64,
    )


# --- handler-level: PUT /budgets/{category} ----------------------------------


def test_set_budget_success(handler):
    repo = recording_budget_repo()

    resp = handler.set_budget(_put_budget_event(), repo, _FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "coffee", "target": 58}
    assert repo.set_calls == [("coffee", Decimal("58"))]


@pytest.mark.parametrize("body, stored", [
    ('{"target": 0}', Decimal("0")),
    # Decimal(str(12.34)) stores exactly, never binary-float drift.
    ('{"target": 12.34}', Decimal("12.34")),
])
def test_set_budget_stores_exact_target(handler, body, stored):
    repo = recording_budget_repo()

    resp = handler.set_budget(_put_budget_event(body=body), repo, _FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", stored)]


# Bodies are RAW wire strings (the event body is passed verbatim; the handler does its own
# json.loads), so the NaN/Infinity/1e40 tokens must stay literal — do NOT rebuild them from
# Python floats. Each case: bad target value -> 400 and nothing persisted.
@pytest.mark.parametrize("body", [
    pytest.param('{"note": "x"}',        id="missing_target"),
    pytest.param('{"target": "58"}',     id="string_target"),
    # bool is an int subclass; must be rejected, not treated as 1/0.
    pytest.param('{"target": true}',     id="bool_target"),
    pytest.param('{"target": -5}',       id="negative"),
    # json.loads accepts the NaN token; must be rejected before hitting DynamoDB.
    pytest.param('{"target": NaN}',      id="nan"),
    pytest.param('{"target": Infinity}', id="infinity"),
    # past the sane ceiling is bad input (400), not a write-time 500.
    pytest.param('{"target": 1e40}',     id="too_large"),
    pytest.param("not json",             id="invalid_json"),
])
def test_set_budget_bad_target_400(handler, body):
    repo = recording_budget_repo()

    resp = handler.set_budget(_put_budget_event(body=body), repo, _FakeCategoryRepo(), FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_savings_category_rejected_400(handler):
    # WHIT-202: a Savings-bucket category can't carry a target — the client refuses to
    # render it, so a stored one is an invisible phantom. Reject at write time; the budget
    # repo is never touched.
    repo = recording_budget_repo()
    category_repo = _FakeCategoryRepo(categories=[{"id": "coffee", "bucket": "Savings"}])

    resp = handler.set_budget(_put_budget_event(), repo, category_repo, FakePayCycleRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []            # never written


def test_put_budget_dispatch_rejects_savings(handler, monkeypatch):
    # The deep-link/back-door backstop END-TO-END: the REAL router must wire
    # CategoryRepository into set_budget so a PUT on a Savings category is rejected (the
    # cold-cache client relies on this 400). Fail-on-revert: reverting the router to a
    # 2-arg set_budget call raises TypeError (missing category_repo), so this errors
    # instead of returning 400.
    repo = recording_budget_repo()
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)
    monkeypatch.setattr(
        handler, "CategoryRepository",
        lambda: _FakeCategoryRepo(categories=[{"id": "coffee", "bucket": "Savings"}]))

    resp = handler.lambda_handler(_put_budget_event(), None)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


# --- handler-level: GET /budgets (rollup, approach C) ------------------------


FakePayCycleRepo = partial(_FakePayCycleRepo, length=14, last_pay_date="2024-01-03")


def test_list_budgets_rollup_shape(handler):
    budget_repo = recording_budget_repo({
        "coffee": {"target": Decimal("58")},
        "groceries": {"target": Decimal("320")},
    })
    txn_repo = _QueuedTransactionRepo(transactions=[
        _transaction("coffee", -50, "posted"),
        _transaction("coffee", -12, "pending"),
        _transaction("groceries", -30, "posted"),
        _transaction("income", -100, "posted"),              # excluded (income)
        _transaction("coffee", -9, "posted", counts=False),  # excluded (!counts_to_budget)
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), _FakeCategoryRepo())

    assert result == {
        "coffee": {"available": Decimal("58"), "target": Decimal("58"), "posted": Decimal("50"), "pending": Decimal("12")},
        "groceries": {"available": Decimal("320"), "target": Decimal("320"), "posted": Decimal("30"), "pending": Decimal("0")},
    }


def test_list_budgets_paginates(handler):
    # A >1-page window must sum across ALL pages, not stop at the first.
    budget_repo = recording_budget_repo({"coffee": {"target": Decimal("100")}})
    txn_repo = _QueuedTransactionRepo(pages=[
        ([_transaction("coffee", -40, "posted")], {"cursor": 1}),  # page 1, more to come
        ([_transaction("coffee", -25, "posted")], None),           # page 2, done
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), _FakeCategoryRepo())

    assert result["coffee"]["posted"] == Decimal("65")  # 40 + 25 summed across pages


# --- handler-level: GET /budgets income earn-targets (WHIT-69) ---------------


def test_list_budgets_income_target_rolls_up_positive_earnings(handler):
    # An Income-bucket target sums POSITIVE earnings (a floor), while a spend target
    # in the same call still sums spend from the NEGATIVE amounts. Both come back in
    # the same shape.
    budget_repo = recording_budget_repo({
        "salary": {"target": Decimal("5000")},
        "coffee": {"target": Decimal("58")},
    })
    txn_repo = _QueuedTransactionRepo(transactions=[
        _transaction("salary", 3000, "posted"),   # income (positive) -> earned
        _transaction("salary", 500, "pending"),    # income pending    -> earned pending
        _transaction("coffee", -50, "posted"),     # spend             -> spent
    ])
    category_repo = _FakeCategoryRepo(categories=[
        {"id": "salary", "bucket": "Income"},
        {"id": "coffee", "bucket": "Lifestyle"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {
        "salary": {"available": Decimal("5000"), "target": Decimal("5000"), "posted": Decimal("3000"), "pending": Decimal("500")},
        "coffee": {"available": Decimal("58"), "target": Decimal("58"), "posted": Decimal("50"), "pending": Decimal("0")},
    }


def test_list_budgets_income_id_named_income_still_counts(handler):
    # A user income category whose id slugs to the literal "income" (same string the
    # spend summariser skips as a sentinel) is a real earn-target and MUST count —
    # summarise_income gates on income_ids membership, not the sentinel skip.
    budget_repo = recording_budget_repo({"income": {"target": Decimal("5000")}})
    txn_repo = _QueuedTransactionRepo(transactions=[_transaction("income", 3000, "posted")])
    category_repo = _FakeCategoryRepo(categories=[{"id": "income", "bucket": "Income"}])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result["income"] == {"available": Decimal("5000"), "target": Decimal("5000"), "posted": Decimal("3000"), "pending": Decimal("0")}


# --- handler-level: GET /budgets sub-category roll-up (WHIT-220) --------------
#
# A budgeted PARENT holds no transactions of its own (they land on its leaves), so
# its posted/pending is the sum over its DESCENDANT LEAVES for the window. The wire
# shape is unchanged: every budgeted id still returns {target, posted, pending}.


def test_list_budgets_parent_rolls_up_leaf_children(handler):
    # Car (parent) + its two leaf children all budgeted. Car's posted/pending = the
    # sum over parking + other; each child also keeps its own correct row.
    budget_repo = recording_budget_repo({
        "car": {"target": Decimal("200")},
        "parking": {"target": Decimal("50")},
        "other": {"target": Decimal("80")},
    })
    txn_repo = _QueuedTransactionRepo(transactions=[
        _transaction("parking", -30, "posted"),
        _transaction("parking", -10, "pending"),
        _transaction("other", -45, "posted"),
    ])
    category_repo = _FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "other", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {
        "car": {"available": Decimal("200"), "target": Decimal("200"), "posted": Decimal("75"), "pending": Decimal("10")},
        "parking": {"available": Decimal("50"), "target": Decimal("50"), "posted": Decimal("30"), "pending": Decimal("10")},
        "other": {"available": Decimal("80"), "target": Decimal("80"), "posted": Decimal("45"), "pending": Decimal("0")},
    }


# --- handler-level: GET /budgets parent-DIRECT spend (WHIT-228) ---------------
#
# The categorize picker lets a transaction be tagged straight onto a PARENT (not only
# a leaf). Its spend must count toward the parent's budget bar too, so /budgets agrees
# with the /breakdown screen ("Directly in <parent>"). The roll-up now sums the whole
# subtree — the parent id itself PLUS every descendant.


def test_list_budgets_parent_direct_spend_counts_with_children(handler):
    # A txn filed straight onto "car" (the budgeted parent) plus a child leaf txn: the
    # parent bar sums BOTH (40 direct + 60 on parking). Pre-WHIT-228 the 40 was dropped.
    budget_repo = recording_budget_repo({"car": {"target": Decimal("200")}})
    txn_repo = _QueuedTransactionRepo(transactions=[
        _transaction("car", -40, "posted"),       # tagged directly onto the parent
        _transaction("parking", -60, "posted"),
    ])
    category_repo = _FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"available": Decimal("200"), "target": Decimal("200"), "posted": Decimal("100"), "pending": Decimal("0")}}


def test_list_budgets_mid_level_direct_spend_counts(handler):
    # car -> daily -> petrol; a txn tagged directly onto the INTERMEDIATE `daily` must
    # roll into car alongside the leaf petrol spend. This is the depth >= 3 case a
    # leaves-only walk dropped (a mid node is neither the root nor a leaf).
    budget_repo = recording_budget_repo({"car": {"target": Decimal("300")}})
    txn_repo = _QueuedTransactionRepo(transactions=[
        _transaction("daily", -25, "posted"),     # tagged directly onto the mid-level parent
        _transaction("petrol", -60, "pending"),
    ])
    category_repo = _FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "daily", "bucket": "Living", "parent": "car"},
        {"id": "petrol", "bucket": "Living", "parent": "daily"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"available": Decimal("300"), "target": Decimal("300"), "posted": Decimal("25"), "pending": Decimal("60")}}


def test_list_budgets_income_parent_direct_earnings_count(handler):
    # An Income parent with earnings tagged directly onto it rolls up POSITIVE via
    # summarise_income (bucketed by the parent's OWN Income bucket), same as its leaves.
    budget_repo = recording_budget_repo({"income": {"target": Decimal("6000")}})
    txn_repo = _QueuedTransactionRepo(transactions=[
        _transaction("income", 500, "posted"),    # tagged directly onto the parent
        _transaction("salary", 4000, "posted"),
    ])
    category_repo = _FakeCategoryRepo(categories=[
        {"id": "income", "bucket": "Income", "parent": None},
        {"id": "salary", "bucket": "Income", "parent": "income"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"income": {"available": Decimal("6000"), "target": Decimal("6000"), "posted": Decimal("4500"), "pending": Decimal("0")}}


# --- handler-level: dispatch -------------------------------------------------


def test_get_budgets_dispatch(handler, monkeypatch):
    budget_repo = recording_budget_repo({"coffee": {"target": Decimal("58")}})
    txn_repo = _QueuedTransactionRepo(transactions=[_transaction("coffee", -50, "posted")])
    monkeypatch.setattr(handler, "BudgetRepository", lambda: budget_repo)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: FakePayCycleRepo())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _FakeCategoryRepo())

    resp = handler.lambda_handler(
        api_event("GET", "/budgets"), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"coffee": {"available": 58, "target": 58, "posted": 50, "pending": 0}}


# --- handler-level: DELETE /budgets/{category} -------------------------------


def _delete_budget_event(category="coffee"):
    return api_event("DELETE", f"/budgets/{category}", path_params={"category": category})


def test_delete_budget_success(handler):
    repo = recording_budget_repo({"coffee": {"target": Decimal("58")}})

    resp = handler.delete_budget(_delete_budget_event(), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "coffee"}
    assert repo.delete_calls == [("coffee")]


@pytest.mark.parametrize("method, path", [
    ("PUT", "/budgets/coffee"),
    ("DELETE", "/budgets/coffee"),
    ("PUT", "/budgets/coffee/spread"),
    ("DELETE", "/budgets/coffee/spread"),
])
def test_a_write_conflict_on_any_budget_route_is_409(handler, monkeypatch, method, path):
    # A repo that exhausts its retry budget raises VersionConflictError; the shared dispatch
    # wrapper must map it to 409 on every write route. The stored spread makes the spread
    # DELETE really write (clearing an absent spread is a no-op, no race).
    repo = recording_budget_repo({"coffee": {"target": Decimal("58"), "spread_amount": Decimal("100")}})
    repo._table.always_race()
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _SpendCategoryRepo(_spend_cat("coffee")))
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: FakePayCycleRepo())

    resp = handler.lambda_handler(api_event(
        method, path, raw='{"target": 58, "amount": 100, "cycles": 2}',
        path_params={"category": "coffee"}, is_base64=False), None)

    assert resp["statusCode"] == 409


# --- pure summarise_transactions + current_cycle_window ----------------------


def _transaction(category, amount, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": counts}


def test_summarise_refund_reduces_spent(handler):
    # A refund (positive amount) in a spend category reduces posted spend (net).
    txns = [_transaction("coffee", -50), _transaction("coffee", 20)]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result["coffee"]["posted"] == Decimal("30")


@pytest.mark.parametrize("last_pay_date, length, today, start, end", [
    # The end bound is today itself (inclusive), NOT today+1 (WHIT-75): tomorrow is out.
    # 43 days on -> k=3 -> +42 days.
    ("2024-01-03", 14, date(2024, 2, 15), "2024-02-14", "2024-02-15"),
    # Exactly `length` days on: a fresh cycle starts today, a single inclusive day.
    ("2024-01-03", 14, date(2024, 1, 17), "2024-01-17", "2024-01-17"),
    # length-1 days on: still the last_pay_date's cycle.
    ("2024-01-03", 14, date(2024, 1, 16), "2024-01-03", "2024-01-16"),
    # 58 days on: weekly k=8 -> +56; monthly k=1 -> +30.
    ("2024-01-03", 7, date(2024, 3, 1), "2024-02-28", "2024-03-01"),
    ("2024-01-03", 30, date(2024, 3, 1), "2024-02-02", "2024-03-01"),
    # A future last_pay_date has no valid k: the window collapses to [today, today], never inverts.
    ("2024-06-05", 14, date(2024, 6, 1), "2024-06-01", "2024-06-01"),
])
def test_current_cycle_window(handler, last_pay_date, length, today, start, end):
    assert handler.current_cycle_window(last_pay_date, length, today=today) == (start, end)


def test_list_budgets_window_counts_only_cycle_start_through_today(handler, monkeypatch):
    # WHIT-75 end-to-end, on the day BEFORE payday: last cycle's spend (the day before
    # cycle_start) and tomorrow's (the next payday) stay out; cycle_start and today count.
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2024, 1, 16))
    budget_repo = recording_budget_repo({"coffee": {"target": Decimal("100")}})
    txn_repo = _DateFilteringTransactionRepo(transactions=[
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-02"},  # day before cycle_start -> OUT
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-03"},  # cycle_start            -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-16"},  # today                  -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-17"},  # tomorrow               -> OUT
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), _FakeCategoryRepo())

    assert result == {"coffee": {"available": Decimal("100"), "target": Decimal("100"), "posted": Decimal("20"), "pending": Decimal("0")}}
    assert txn_repo.calls[0][1:3] == ("2024-01-03", "2024-01-16")  # queried bounds: cycle_start .. today


def test_melbourne_today_maps_utc_instant_to_local_date(handler, monkeypatch):
    from datetime import datetime, timezone
    # 2024-06-30T15:30Z is already 2024-07-01 in Melbourne (UTC+10 in June/AEST).
    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 6, 30, 15, 30, tzinfo=timezone.utc).astimezone(tz)
    import spend
    monkeypatch.setattr(spend, "datetime", _FrozenDatetime)
    assert spend.melbourne_today().isoformat() == "2024-07-01"


def test_melbourne_today_falls_back_to_utc_when_tzdata_missing(handler, monkeypatch):
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfoNotFoundError
    # Simulate tzdata missing from the layer: ZoneInfo raises. The budget path must
    # degrade to UTC, not 500.
    import spend
    def _boom(name):
        raise ZoneInfoNotFoundError(name)
    monkeypatch.setattr(spend, "ZoneInfo", _boom)
    assert spend.melbourne_today() == datetime.now(timezone.utc).date()


# --- WHIT-220 Step 2: adversarial gap tests for sub-category roll-up ----------
# Independent of the implementer's happy-path set above (QA-authored). Exercises the
# full handler.list_budgets + shared/spend roll-up. IDs map to the QA checklist.


def test_income_clawback_on_one_leaf_nets_into_parent(handler):
    # WHIT-343 (aggregate-then-clamp, income side): a clawback netting ONE income leaf
    # negative now nets against a sibling's earnings across the subtree before the floor,
    # so the earn-target reads the TRUE net earned — matching the /budgets screen. salary
    # 4000 + side (250 - 1000 = -750) = 3250 -> clamp once -> 3250 (still never negative).
    # Fail-on-revert (per-id clamp): side floors to 0 -> 4000.
    budget_repo = recording_budget_repo({"income": {"target": Decimal("6000")}})
    txn_repo = _QueuedTransactionRepo(transactions=[
        _transaction("salary", 4000, "posted"),
        _transaction("side", 250, "posted"),
        _transaction("side", -1000, "posted"),  # net -750 on `side`
    ])
    category_repo = _FakeCategoryRepo(categories=[
        {"id": "income", "bucket": "Income", "parent": None},
        {"id": "salary", "bucket": "Income", "parent": "income"},
        {"id": "side", "bucket": "Income", "parent": "income"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    # salary 4000 + side net -750 = 3250 (nets across the subtree, then clamped once).
    assert result == {"income": {"available": Decimal("6000"), "target": Decimal("6000"), "posted": Decimal("3250"), "pending": Decimal("0")}}


def test_corrupt_cross_bucket_income_child_excluded_from_spend_parent(handler):
    # WHIT-229 (the headline case, was [A27] characterization): an Income leaf corruptly
    # parented under a spend parent must NOT have its positive earnings summed into the
    # parent's posted — the same-bucket guard drops it from the subtree before it can reach
    # income_ids/summarise_income. So Car = its Living leaf only (30), never 30 + 500.
    # Fail-on-revert (drop bucket_by_id): the income bonus folds back in -> 530.
    budget_repo = recording_budget_repo({"car": {"target": Decimal("200")}})
    txn_repo = _QueuedTransactionRepo(transactions=[
        _transaction("parking", -30, "posted"),
        _transaction("bonus", 500, "posted"),
    ])
    category_repo = _FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "bonus", "bucket": "Income", "parent": "car"},  # corrupt (write-guard blocks this)
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result["car"]["posted"] == Decimal("30")  # only the same-bucket leaf; income excluded


# ===========================================================================
# QA GAP tests (WHIT-228) — parent-DIRECT edges the implementer's tests don't
# lock: the per-id >=0 clamp now applies to the PARENT's OWN id (never summed
# pre-228), a refund straight onto the parent, mixed posted+pending straight
# onto the parent, and the (deferred) cross-bucket child rollup.
# ===========================================================================


def test_budget_rollup_agrees_across_screen_and_ai_paths(handler):
    # WHIT-343 invariant: /budgets (the screen) and _budgeted_parent_rollup (the AI summary)
    # MUST report the same subtree spend for the same data, so an insight/alert can never
    # disagree with the screen. Car = petrol 60 + tolls (50 - 80 refund = -30) = 30 under
    # aggregate-then-clamp. Fail-on-revert (per-id clamp): tolls floors to 0 -> both read 60.
    txns = [
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", -50, "posted"),
        _transaction("tolls", 80, "posted"),      # refund larger than tolls' own spend
    ]
    categories = [
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "petrol", "bucket": "Living", "parent": "car"},
        {"id": "tolls", "bucket": "Living", "parent": "car"},
    ]

    screen = handler.list_budgets(
        recording_budget_repo({"car": {"target": Decimal("300")}}),
        _QueuedTransactionRepo(transactions=txns), FakePayCycleRepo(),
        _FakeCategoryRepo(categories=categories),
    )["car"]

    children = handler.build_category_children(categories)
    bucket_by_id = {c["id"]: c["bucket"] for c in categories}
    ids_by_parent = {"car": handler.subtree_ids("car", children, bucket_by_id)}
    ai_row = handler._budgeted_parent_rollup(txns, ["car"], ids_by_parent, {"car": "Car"})[0]

    assert screen["posted"] + screen["pending"] == Decimal("30")
    assert Decimal(str(ai_row["posted"])) + Decimal(str(ai_row["pending"])) == Decimal("30")


# ===========================================================================
# WHIT-343 QA GAP tests (aggregate-then-clamp) — adversarial edges the
# implementer's set does NOT cover. Every WHIT-343 assertion here goes RED if the
# per-id clamp is restored (clamp=False dropped); the regression guards go RED if
# the single-category default clamp is flipped. Not duplicates of the 7 tests in
# the diff.
# ===========================================================================


def test_wh343_gap_income_whole_subtree_net_negative_floors_to_zero(handler):
    # WHIT-343 x income boundary. The income earn-target counterpart of the whole-budget
    # net-negative floor: a clawback bigger than the WHOLE subtree's earnings must still
    # floor the earn-target at 0 (never negative). salary 250 + side (-1000) = -750 -> 0.
    # Fail-on-revert (per-id clamp): salary 250 survives, side floors -> 250, not 0.
    budget_repo = recording_budget_repo({"income": {"target": Decimal("6000")}})
    txn_repo = _QueuedTransactionRepo(transactions=[
        _transaction("salary", 250, "posted"),
        _transaction("side", -1000, "posted"),   # clawback > the whole subtree's earnings
    ])
    category_repo = _FakeCategoryRepo(categories=[
        {"id": "income", "bucket": "Income", "parent": None},
        {"id": "salary", "bucket": "Income", "parent": "income"},
        {"id": "side", "bucket": "Income", "parent": "income"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"income": {"available": Decimal("6000"), "target": Decimal("6000"), "posted": Decimal("0"), "pending": Decimal("0")}}


def test_wh343_gap_single_category_default_clamp_still_true(handler):
    # REGRESSION guard: the default clamp=True is the floor EVERY single-category caller
    # relies on (/budgets/{id}/transactions header, per-leaf breakdown rows). A lone leaf
    # netting negative on its own id must still floor at 0 by DEFAULT (no clamp arg).
    # Fail-on-revert: flipping the default to clamp=False makes this -30.
    txns = [_transaction("tolls", -50, "posted"), _transaction("tolls", 80, "posted")]

    assert handler.summarise_transactions(txns, {"tolls"}) == {"tolls": {"posted": Decimal("0"), "pending": Decimal("0")}}
    # And income's default likewise floors a lone clawback-heavy earn id.
    inc = [_transaction("side", 250, "posted"), _transaction("side", -1000, "posted")]
    assert handler.summarise_income(inc, {"side"}) == {"side": {"posted": Decimal("0"), "pending": Decimal("0")}}


def test_list_budgets_drops_an_excluded_charge(handler):
    # WHIT-296: two coffee charges, one marked "exclude"; only the kept one feeds the bar.
    # Without the gate the bar would read $150 posted.
    budget_repo = recording_budget_repo({"coffee": {"target": Decimal("100")}})
    txn_repo = _QueuedTransactionRepo([
        _transaction("coffee", -50, "posted"),
        {**_transaction("coffee", -100, "posted"), "budget_excluded": True},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(),
                                  _FakeCategoryRepo([{"id": "coffee", "bucket": "Lifestyle"}]))

    assert result == {"coffee": {"available": Decimal("100"), "target": Decimal("100"),
                                 "posted": Decimal("50"), "pending": Decimal("0")}}
