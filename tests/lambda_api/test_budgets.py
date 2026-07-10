"""Tests for the budget-target endpoints (GET /budgets, PUT /budgets/{category})
and BudgetRepository.

Handler-level tests inject a FakeBudgetRepo directly (no patching). Repository
tests inject a tiny in-memory fake DynamoDB table into BudgetRepository. The
budget write is an idempotent UPSERT (`SET #items.#id = :val`, no exists guard),
so the fake table's update branch differs from the category one — setting the
same category's target twice must overwrite, never raise.

The `handler` fixture (conftest.py) makes lambda_api importable in isolation and
puts `shared/` on the path, so `import repository` inside a test resolves to
shared/repository.py with boto3/botocore already faked.
"""

import base64
import copy
import json
from decimal import Decimal

from botocore.exceptions import ClientError


# --- handler-level fake ------------------------------------------------------


class FakeBudgetRepo:
    """Handler-level stand-in for BudgetRepository (records calls)."""

    def __init__(self, budgets=None, conflict_exc=None):
        # budgets: {id: {"target": Decimal}} (the stored/nested shape).
        self._budgets = budgets or {}
        self._conflict_exc = conflict_exc
        self.set_calls = []
        self.list_calls = 0

    def list_budgets(self):
        self.list_calls += 1
        return {k: dict(v) for k, v in self._budgets.items()}

    def set_budget(self, cat_id, target):
        self.set_calls.append((cat_id, target))
        if self._conflict_exc is not None:
            raise self._conflict_exc("boom")
        return {"id": cat_id, "target": target}


def _put_budget_event(category="coffee", body='{"target": 58}', is_b64=False):
    return {
        "rawPath": f"/budgets/{category}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"category": category},
        "body": body,
        "isBase64Encoded": is_b64,
    }


# --- handler-level: PUT /budgets/{category} ----------------------------------


def test_set_budget_success(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"id": "coffee", "target": 58}
    assert repo.set_calls == [("coffee", Decimal("58"))]


def test_set_budget_zero_accepted(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": 0}'), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", Decimal("0"))]


def test_set_budget_decimal_precision(handler):
    # Decimal(str(12.34)) stores exactly, never binary-float drift.
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": 12.34}'), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", Decimal("12.34"))]


def test_set_budget_unknown_category_accepted(handler):
    # Unknown ids are accepted (stored as an orphan the client ignores).
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(category="doesnotexist"), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("doesnotexist", Decimal("58"))]


def test_set_budget_missing_target_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"note": "x"}'), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_string_target_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": "58"}'), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_bool_target_400(handler):
    # bool is an int subclass; must be rejected, not treated as 1/0.
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": true}'), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_negative_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": -5}'), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_nan_400(handler):
    # json.loads accepts the NaN token; must be rejected before hitting DynamoDB.
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": NaN}'), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_infinity_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": Infinity}'), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_too_large_400(handler):
    # A value past the sane ceiling is bad input (400), not a write-time 500.
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body='{"target": 1e40}'), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_missing_path_param_404(handler):
    repo = FakeBudgetRepo()
    event = _put_budget_event()
    event["pathParameters"] = {}

    resp = handler.set_budget(event, repo, FakeCategoryRepo())

    assert resp["statusCode"] == 404
    assert repo.set_calls == []


def test_set_budget_invalid_json_400(handler):
    repo = FakeBudgetRepo()

    resp = handler.set_budget(_put_budget_event(body="not json"), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_set_budget_base64_body(handler):
    repo = FakeBudgetRepo()
    encoded = base64.b64encode(b'{"target": 58}').decode()

    resp = handler.set_budget(_put_budget_event(body=encoded, is_b64=True), repo, FakeCategoryRepo())

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", Decimal("58"))]


def test_set_budget_savings_category_rejected_400(handler):
    # WHIT-202: a Savings-bucket category can't carry a target — the client refuses to
    # render it, so a stored one is an invisible phantom. Reject at write time; the budget
    # repo is never touched.
    repo = FakeBudgetRepo()
    category_repo = FakeCategoryRepo(categories=[{"id": "coffee", "bucket": "Savings"}])

    resp = handler.set_budget(_put_budget_event(), repo, category_repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []            # never written
    assert category_repo.list_calls == 1   # the guard did read the taxonomy


def test_set_budget_non_savings_category_accepted(handler):
    # A KNOWN non-Savings (Living/Lifestyle) category still writes — only Savings is blocked,
    # so the guard can't over-reach and break normal budgeting.
    repo = FakeBudgetRepo()
    category_repo = FakeCategoryRepo(categories=[{"id": "coffee", "bucket": "Lifestyle"}])

    resp = handler.set_budget(_put_budget_event(), repo, category_repo)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", Decimal("58"))]


def test_set_budget_savings_guard_runs_after_numeric_validation(handler):
    # A malformed target 400s WITHOUT reading the taxonomy — the cheap numeric checks
    # short-circuit before the category read, even for a Savings id. Locks the ordering.
    repo = FakeBudgetRepo()
    category_repo = FakeCategoryRepo(categories=[{"id": "coffee", "bucket": "Savings"}])

    resp = handler.set_budget(_put_budget_event(body='{"target": -5}'), repo, category_repo)

    assert resp["statusCode"] == 400
    assert category_repo.list_calls == 0   # numeric reject came first, no taxonomy read


def test_set_budget_zero_target_savings_still_rejected(handler):
    # target=0 passes every numeric check (>= 0), so the Savings guard must still fire on
    # it — a $0 phantom on a Savings category is as un-renderable as any other. Fail-on-
    # revert: without the guard a 0 target writes (200).
    repo = FakeBudgetRepo()
    category_repo = FakeCategoryRepo(categories=[{"id": "coffee", "bucket": "Savings"}])

    resp = handler.set_budget(_put_budget_event(body='{"target": 0}'), repo, category_repo)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


def test_put_budget_dispatch_rejects_savings(handler, monkeypatch):
    # The deep-link/back-door backstop END-TO-END: the REAL router must wire
    # CategoryRepository into set_budget so a PUT on a Savings category is rejected (the
    # cold-cache client relies on this 400). Fail-on-revert: reverting the router to a
    # 2-arg set_budget call raises TypeError (missing category_repo), so this errors
    # instead of returning 400.
    repo = FakeBudgetRepo()
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)
    monkeypatch.setattr(
        handler, "CategoryRepository",
        lambda: FakeCategoryRepo(categories=[{"id": "coffee", "bucket": "Savings"}]))

    resp = handler.lambda_handler(_put_budget_event(), None)

    assert resp["statusCode"] == 400
    assert repo.set_calls == []


# --- handler-level: GET /budgets (rollup, approach C) ------------------------


class FakeTransactionRepo:
    """Stand-in for TransactionRepository. Returns queued (items, cursor) pages
    across calls; account/date args are recorded but ignored. Defaults to a single
    page then empties, so the per-account loop sums each transaction once."""

    def __init__(self, transactions=None, pages=None):
        # pages: [(items, cursor), ...] to model a multi-page result; otherwise a
        # single page of `transactions` then empty.
        self._queue = list(pages) if pages is not None else [(list(transactions or []), None)]
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        return self._queue.pop(0) if self._queue else ([], None)


class FakePayCycleRepo:
    """Stand-in for PayCycleRepository. Returns a fixed cycle and counts reads so a
    test can assert the empty-budget short-circuit skips the pay-cycle read."""

    def __init__(self, length=14, last_pay_date="2024-01-03"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}
        self.get_calls = 0

    def get_paycycle(self):
        self.get_calls += 1
        return dict(self._cycle)


class FakeCategoryRepo:
    """Stand-in for CategoryRepository — serves a fixed taxonomy so list_budgets can
    infer a target's direction (Income bucket => earn-target). Empty by default: an
    unknown bucket falls to the spend/ceiling default, which is how every pre-WHIT-69
    budget test expects a plain spend category to roll up."""

    def __init__(self, categories=None):
        self._categories = categories or []
        self.list_calls = 0

    def list_categories(self):
        self.list_calls += 1
        return [dict(c) for c in self._categories]


def test_list_budgets_rollup_shape(handler):
    budget_repo = FakeBudgetRepo(budgets={
        "coffee": {"target": Decimal("58")},
        "groceries": {"target": Decimal("320")},
    })
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("coffee", -50, "posted"),
        _transaction("coffee", -12, "pending"),
        _transaction("groceries", -30, "posted"),
        _transaction("income", -100, "posted"),              # excluded (income)
        _transaction("coffee", -9, "posted", counts=False),  # excluded (!counts_to_budget)
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), FakeCategoryRepo())

    assert result == {
        "coffee": {"target": Decimal("58"), "posted": Decimal("50"), "pending": Decimal("12")},
        "groceries": {"target": Decimal("320"), "posted": Decimal("30"), "pending": Decimal("0")},
    }


def test_list_budgets_no_spend_is_zero(handler):
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("58")}})

    result = handler.list_budgets(budget_repo, FakeTransactionRepo(transactions=[]), FakePayCycleRepo(), FakeCategoryRepo())

    assert result == {"coffee": {"target": Decimal("58"), "posted": Decimal("0"), "pending": Decimal("0")}}


def test_list_budgets_empty_skips_txn_scan(handler):
    budget_repo = FakeBudgetRepo()  # no targets
    txn_repo = FakeTransactionRepo(transactions=[_transaction("coffee", -50)])
    paycycle_repo = FakePayCycleRepo()
    category_repo = FakeCategoryRepo(categories=[{"id": "coffee", "bucket": "Lifestyle"}])

    result = handler.list_budgets(budget_repo, txn_repo, paycycle_repo, category_repo)

    assert result == {}
    assert txn_repo.calls == []            # no budgets -> don't scan transactions
    assert paycycle_repo.get_calls == 0    # ...and don't even read the pay cycle
    assert category_repo.list_calls == 0   # ...nor read the taxonomy (short-circuit first)


def test_list_budgets_paginates(handler):
    # A >1-page window must sum across ALL pages, not stop at the first.
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = FakeTransactionRepo(pages=[
        ([_transaction("coffee", -40, "posted")], {"cursor": 1}),  # page 1, more to come
        ([_transaction("coffee", -25, "posted")], None),           # page 2, done
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), FakeCategoryRepo())

    assert result["coffee"]["posted"] == Decimal("65")  # 40 + 25 summed across pages


# --- handler-level: GET /budgets income earn-targets (WHIT-69) ---------------


def test_list_budgets_income_target_rolls_up_positive_earnings(handler):
    # An Income-bucket target sums POSITIVE earnings (a floor), while a spend target
    # in the same call still sums spend from the NEGATIVE amounts. Both come back in
    # the same shape.
    budget_repo = FakeBudgetRepo(budgets={
        "salary": {"target": Decimal("5000")},
        "coffee": {"target": Decimal("58")},
    })
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("salary", 3000, "posted"),   # income (positive) -> earned
        _transaction("salary", 500, "pending"),    # income pending    -> earned pending
        _transaction("coffee", -50, "posted"),     # spend             -> spent
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "salary", "bucket": "Income"},
        {"id": "coffee", "bucket": "Lifestyle"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {
        "salary": {"target": Decimal("5000"), "posted": Decimal("3000"), "pending": Decimal("500")},
        "coffee": {"target": Decimal("58"), "posted": Decimal("50"), "pending": Decimal("0")},
    }


def test_list_budgets_income_target_no_earnings_is_zero(handler):
    # An income target with no income yet this cycle shows 0 earned (not omitted).
    budget_repo = FakeBudgetRepo(budgets={"salary": {"target": Decimal("5000")}})
    txn_repo = FakeTransactionRepo(transactions=[])
    category_repo = FakeCategoryRepo(categories=[{"id": "salary", "bucket": "Income"}])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"salary": {"target": Decimal("5000"), "posted": Decimal("0"), "pending": Decimal("0")}}


def test_list_budgets_income_clawback_clamps_to_zero(handler):
    # A reversal/clawback (negative amount) in an income category reduces earnings and
    # clamps at 0 — never a negative earnings bar.
    budget_repo = FakeBudgetRepo(budgets={"salary": {"target": Decimal("5000")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("salary", 3000, "posted"),
        _transaction("salary", -4000, "posted"),  # clawback bigger than earnings
    ])
    category_repo = FakeCategoryRepo(categories=[{"id": "salary", "bucket": "Income"}])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result["salary"]["posted"] == Decimal("0")


def test_list_budgets_income_id_named_income_still_counts(handler):
    # A user income category whose id slugs to the literal "income" (same string the
    # spend summariser skips as a sentinel) is a real earn-target and MUST count —
    # summarise_income gates on income_ids membership, not the sentinel skip.
    budget_repo = FakeBudgetRepo(budgets={"income": {"target": Decimal("5000")}})
    txn_repo = FakeTransactionRepo(transactions=[_transaction("income", 3000, "posted")])
    category_repo = FakeCategoryRepo(categories=[{"id": "income", "bucket": "Income"}])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result["income"] == {"target": Decimal("5000"), "posted": Decimal("3000"), "pending": Decimal("0")}


def test_list_budgets_savings_bucket_target_treated_as_spend(handler):
    # WHIT-69 is Income-only: a Savings-bucket target is NOT an earn-target. It falls
    # to the spend/ceiling default (positive savings amounts clamp to 0 spend), so its
    # rollup stays 0 rather than showing earnings.
    budget_repo = FakeBudgetRepo(budgets={"nest_egg": {"target": Decimal("1000")}})
    txn_repo = FakeTransactionRepo(transactions=[_transaction("nest_egg", 800, "posted")])
    category_repo = FakeCategoryRepo(categories=[{"id": "nest_egg", "bucket": "Savings"}])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result["nest_egg"] == {"target": Decimal("1000"), "posted": Decimal("0"), "pending": Decimal("0")}


def test_list_budgets_orphan_income_target_defaults_to_spend(handler):
    # A target whose category no longer exists (unknown bucket) can't be inferred as
    # income -> it defaults to the spend ceiling, the existing safe behaviour.
    budget_repo = FakeBudgetRepo(budgets={"ghost": {"target": Decimal("5000")}})
    txn_repo = FakeTransactionRepo(transactions=[_transaction("ghost", 3000, "posted")])
    category_repo = FakeCategoryRepo(categories=[])  # ghost not in taxonomy

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    # Positive amount summed as spend clamps to 0 (not earnings) -> ceiling default.
    assert result["ghost"] == {"target": Decimal("5000"), "posted": Decimal("0"), "pending": Decimal("0")}


# --- handler-level: GET /budgets sub-category roll-up (WHIT-220) --------------
#
# A budgeted PARENT holds no transactions of its own (they land on its leaves), so
# its posted/pending is the sum over its DESCENDANT LEAVES for the window. The wire
# shape is unchanged: every budgeted id still returns {target, posted, pending}.


def test_list_budgets_parent_rolls_up_leaf_children(handler):
    # Car (parent) + its two leaf children all budgeted. Car's posted/pending = the
    # sum over parking + other; each child also keeps its own correct row.
    budget_repo = FakeBudgetRepo(budgets={
        "car": {"target": Decimal("200")},
        "parking": {"target": Decimal("50")},
        "other": {"target": Decimal("80")},
    })
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("parking", -30, "posted"),
        _transaction("parking", -10, "pending"),
        _transaction("other", -45, "posted"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "other", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {
        "car": {"target": Decimal("200"), "posted": Decimal("75"), "pending": Decimal("10")},
        "parking": {"target": Decimal("50"), "posted": Decimal("30"), "pending": Decimal("10")},
        "other": {"target": Decimal("80"), "posted": Decimal("45"), "pending": Decimal("0")},
    }


def test_list_budgets_untargeted_leaf_still_rolls_into_parent(handler):
    # Only the parent carries a target; its child leaf has none. The child's spend
    # must still fold into the parent, and NO phantom row appears for the child.
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("200")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("parking", -30, "posted"),
        _transaction("other", -45, "posted"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "other", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"target": Decimal("200"), "posted": Decimal("75"), "pending": Decimal("0")}}


def test_list_budgets_multilevel_grandchild_rolls_up(handler):
    # car -> daily -> {petrol, tolls}; only car is budgeted. The grandchild leaves'
    # spend must reach car through the two-level walk.
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("300")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", -15, "pending"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "daily", "bucket": "Living", "parent": "car"},
        {"id": "petrol", "bucket": "Living", "parent": "daily"},
        {"id": "tolls", "bucket": "Living", "parent": "daily"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"target": Decimal("300"), "posted": Decimal("60"), "pending": Decimal("15")}}


def test_list_budgets_income_parent_rolls_up_income_leaves(handler):
    # An Income parent whose leaves are Income rolls up POSITIVE earnings (floor,
    # over-is-good) via summarise_income, same as a flat income target.
    budget_repo = FakeBudgetRepo(budgets={"income": {"target": Decimal("6000")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("salary", 4000, "posted"),
        _transaction("refund", 250, "pending"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "income", "bucket": "Income", "parent": None},
        {"id": "salary", "bucket": "Income", "parent": "income"},
        {"id": "refund", "bucket": "Income", "parent": "income"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"income": {"target": Decimal("6000"), "posted": Decimal("4000"), "pending": Decimal("250")}}


def test_list_budgets_parent_and_child_both_budgeted_are_independent(handler):
    # With a parent AND its own leaf both budgeted, the same underlying transaction
    # correctly appears in BOTH rows (parent = sum of leaves; leaf = itself). Each row
    # is individually correct; the hero-total de-dup is a client concern (WHIT-221).
    budget_repo = FakeBudgetRepo(budgets={
        "car": {"target": Decimal("200")},
        "parking": {"target": Decimal("50")},
    })
    txn_repo = FakeTransactionRepo(transactions=[_transaction("parking", -30, "posted")])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result["car"]["posted"] == Decimal("30")      # parent rolls up the leaf
    assert result["parking"]["posted"] == Decimal("30")  # leaf keeps its own row


def test_list_budgets_flat_leaf_rolls_up_only_itself(handler):
    # Regression anchor: a budgeted top-level category with NO children maps to the
    # singleton {itself}, so its rollup is byte-identical to the pre-WHIT-220 path.
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("58")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("coffee", -50, "posted"),
        _transaction("groceries", -30, "posted"),  # a different category, must NOT leak in
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "coffee", "bucket": "Lifestyle", "parent": None},
        {"id": "groceries", "bucket": "Living", "parent": None},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"coffee": {"target": Decimal("58"), "posted": Decimal("50"), "pending": Decimal("0")}}


# --- handler-level: GET /budgets parent-DIRECT spend (WHIT-228) ---------------
#
# The categorize picker lets a transaction be tagged straight onto a PARENT (not only
# a leaf). Its spend must count toward the parent's budget bar too, so /budgets agrees
# with the /breakdown screen ("Directly in <parent>"). The roll-up now sums the whole
# subtree — the parent id itself PLUS every descendant.


def test_list_budgets_parent_direct_spend_counts_with_children(handler):
    # A txn filed straight onto "car" (the budgeted parent) plus a child leaf txn: the
    # parent bar sums BOTH (40 direct + 60 on parking). Pre-WHIT-228 the 40 was dropped.
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("200")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("car", -40, "posted"),       # tagged directly onto the parent
        _transaction("parking", -60, "posted"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"target": Decimal("200"), "posted": Decimal("100"), "pending": Decimal("0")}}


def test_list_budgets_mid_level_direct_spend_counts(handler):
    # car -> daily -> petrol; a txn tagged directly onto the INTERMEDIATE `daily` must
    # roll into car alongside the leaf petrol spend. This is the depth >= 3 case a
    # leaves-only walk dropped (a mid node is neither the root nor a leaf).
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("300")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("daily", -25, "posted"),     # tagged directly onto the mid-level parent
        _transaction("petrol", -60, "pending"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "daily", "bucket": "Living", "parent": "car"},
        {"id": "petrol", "bucket": "Living", "parent": "daily"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"target": Decimal("300"), "posted": Decimal("25"), "pending": Decimal("60")}}


def test_list_budgets_income_parent_direct_earnings_count(handler):
    # An Income parent with earnings tagged directly onto it rolls up POSITIVE via
    # summarise_income (bucketed by the parent's OWN Income bucket), same as its leaves.
    budget_repo = FakeBudgetRepo(budgets={"income": {"target": Decimal("6000")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("income", 500, "posted"),    # tagged directly onto the parent
        _transaction("salary", 4000, "posted"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "income", "bucket": "Income", "parent": None},
        {"id": "salary", "bucket": "Income", "parent": "income"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"income": {"target": Decimal("6000"), "posted": Decimal("4500"), "pending": Decimal("0")}}


# --- handler-level: dispatch -------------------------------------------------


def test_get_budgets_dispatch(handler, monkeypatch):
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("58")}})
    txn_repo = FakeTransactionRepo(transactions=[_transaction("coffee", -50, "posted")])
    monkeypatch.setattr(handler, "BudgetRepository", lambda: budget_repo)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(handler, "PayCycleRepository", lambda: FakePayCycleRepo())
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo())

    resp = handler.lambda_handler(
        {"rawPath": "/budgets", "requestContext": {"http": {"method": "GET"}}}, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"coffee": {"target": 58, "posted": 50, "pending": 0}}


def test_get_budgets_dispatch_ignores_days_param(handler, monkeypatch):
    # Back-compat: a deployed client still sends ?days=. The server no longer reads
    # it (the window is last_pay_date-derived), so the request still 200s and the window
    # start is the stored cycle's cycle_start, NOT today-days.
    monkeypatch.setattr(handler, "BudgetRepository",
                        lambda: FakeBudgetRepo(budgets={"coffee": {"target": Decimal("58")}}))
    txn_repo = FakeTransactionRepo(transactions=[])
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txn_repo)
    monkeypatch.setattr(handler, "PayCycleRepository",
                        lambda: FakePayCycleRepo(length=14, last_pay_date="2024-01-03"))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo())

    resp = handler.lambda_handler({
        "rawPath": "/budgets",
        "requestContext": {"http": {"method": "GET"}},
        "queryStringParameters": {"days": "7"},
    }, None)

    assert resp["statusCode"] == 200  # ?days is ignored, not a 400
    expected_start, _ = handler.current_cycle_window("2024-01-03", 14)
    assert txn_repo.calls[0][1] == expected_start  # last_pay_date-derived, not today-7


def test_put_budget_dispatch(handler, monkeypatch):
    repo = FakeBudgetRepo()
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo())

    resp = handler.lambda_handler(_put_budget_event(), None)

    assert resp["statusCode"] == 200
    assert repo.set_calls == [("coffee", Decimal("58"))]


def test_unknown_budget_method_falls_through_404(handler, monkeypatch):
    # DELETE /budgets/{category} isn't a route -> catch-all 404.
    monkeypatch.setattr(handler, "BudgetRepository", lambda: FakeBudgetRepo())

    resp = handler.lambda_handler({
        "rawPath": "/budgets/coffee",
        "requestContext": {"http": {"method": "DELETE"}},
        "pathParameters": {"category": "coffee"},
    }, None)

    assert resp["statusCode"] == 404


def test_set_budget_conflict_returns_409(handler, monkeypatch):
    # A repo that exhausts its retry budget raises VersionConflictError; the shared
    # dispatch wrapper maps it to 409.
    repo = FakeBudgetRepo(conflict_exc=handler.VersionConflictError)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo())

    resp = handler.lambda_handler(_put_budget_event(), None)

    assert resp["statusCode"] == 409


# --- repository-level: storage logic via an in-memory fake table -------------


def _ccfe():
    err = ClientError()
    err.response = {"Error": {"Code": "ConditionalCheckFailedException"}}
    return err


class FakeBudgetTable:
    """In-memory table emulating the calls BudgetRepository makes: get_item,
    conditional put_item, and the nested UPSERT update_item (no exists guard)."""

    def __init__(self):
        self.store = {}  # (pk, sk) -> item
        # Queue of callables(item) run just before each update_item evaluation,
        # to simulate a concurrent writer mutating the row between read and write.
        self.before_update = []

    def get_item(self, Key):
        item = self.store.get((Key["pk"], Key["sk"]))
        return {"Item": copy.deepcopy(item)} if item is not None else {}

    def put_item(self, Item, ConditionExpression=None):
        k = (Item["pk"], Item["sk"])
        if ConditionExpression == "attribute_not_exists(pk)" and k in self.store:
            raise _ccfe()
        self.store[k] = copy.deepcopy(Item)

    def update_item(self, Key, UpdateExpression, ConditionExpression,
                    ExpressionAttributeNames, ExpressionAttributeValues):
        item = self.store.get((Key["pk"], Key["sk"]))
        if self.before_update and item is not None:
            self.before_update.pop(0)(item)  # simulate a concurrent writer
        values = ExpressionAttributeValues

        # attribute_exists(pk) AND #v = :expected — the optimistic-lock guard.
        if item is None or item["version"] != values[":expected"]:
            raise _ccfe()

        # Budget upsert: SET #items.#id = :val, set whether or not the id existed.
        cat_id = ExpressionAttributeNames["#id"]
        item["items"][cat_id] = copy.deepcopy(values[":val"])
        item["version"] = values[":next"]


def _repo_with_fake_table(handler):
    import repository
    repo = repository.BudgetRepository()
    repo._table = FakeBudgetTable()
    return repository, repo


def test_repo_list_budgets_seeds_empty_then_stable(handler):
    repository, repo = _repo_with_fake_table(handler)

    first = repo.list_budgets()
    second = repo.list_budgets()  # must not re-seed

    assert first == {} and second == {}
    config = repo._table.store[("BUDGETS", "BUDGETS")]
    assert config["items"] == {} and config["version"] == 1


def test_repo_set_budget_writes(handler):
    repository, repo = _repo_with_fake_table(handler)

    saved = repo.set_budget("coffee", Decimal("58"))

    config = repo._table.store[("BUDGETS", "BUDGETS")]
    assert config["items"]["coffee"] == {"target": Decimal("58")}
    assert config["version"] == 2
    assert saved == {"id": "coffee", "target": Decimal("58")}


def test_repo_set_budget_upsert_overwrites(handler):
    # The exact case a cloned category FakeTable would get wrong: set the same id
    # twice -> overwrite + version bump, never a duplicate/CCFE.
    repository, repo = _repo_with_fake_table(handler)

    repo.set_budget("coffee", Decimal("58"))
    repo.set_budget("coffee", Decimal("70"))

    config = repo._table.store[("BUDGETS", "BUDGETS")]
    assert config["items"]["coffee"] == {"target": Decimal("70")}
    assert config["version"] == 3


def test_repo_set_budget_preserves_other_keys(handler):
    repository, repo = _repo_with_fake_table(handler)

    repo.set_budget("coffee", Decimal("58"))
    repo.set_budget("groceries", Decimal("320"))

    items = repo._table.store[("BUDGETS", "BUDGETS")]["items"]
    assert items == {"coffee": {"target": Decimal("58")},
                     "groceries": {"target": Decimal("320")}}


def _bump_version(item):
    item["version"] = item["version"] + 1  # Decimal + int -> Decimal


def test_repo_set_budget_retries_after_version_race(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo._table.before_update.append(_bump_version)

    repo.set_budget("coffee", Decimal("58"))

    config = repo._table.store[("BUDGETS", "BUDGETS")]
    assert config["items"]["coffee"] == {"target": Decimal("58")}
    assert config["version"] == 3  # seed(1) + concurrent bump(->2) + our write(->3)


def test_repo_set_budget_raises_under_sustained_contention(handler):
    # Every attempt sees a fresh version bump -> never converges -> 409.
    repository, repo = _repo_with_fake_table(handler)
    repo._table.before_update.extend([_bump_version, _bump_version])

    try:
        repo.set_budget("coffee", Decimal("58"))
        assert False, "expected VersionConflictError under sustained contention"
    except repository.VersionConflictError:
        pass


# --- rollup S1: pure summarise_transactions + current_cycle_window -----------


def _transaction(category, amount, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": counts}


def test_summarise_routes_posted_and_pending(handler):
    # Spend is stored negative; posted -> posted bucket, pending -> pending bucket.
    txns = [_transaction("coffee", -50, "posted"), _transaction("coffee", -12, "pending")]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result == {"coffee": {"posted": Decimal("50"), "pending": Decimal("12")}}


def test_summarise_sums_multiple_and_ignores_others(handler):
    txns = [
        _transaction("coffee", -50), _transaction("coffee", -8),          # summed
        _transaction("groceries", -30),                            # different category
        _transaction("coffee", -99, counts=False),                 # not counts_to_budget
        _transaction("income", -100),                              # income category
        _transaction(None, -20),                                   # uncategorized
        _transaction("unbudgeted", -40),                           # no target -> skipped
    ]

    result = handler.summarise_transactions(txns, {"coffee", "groceries"})

    assert result["coffee"] == {"posted": Decimal("58"), "pending": Decimal("0")}
    assert result["groceries"] == {"posted": Decimal("30"), "pending": Decimal("0")}
    assert "unbudgeted" not in result and "income" not in result


def test_summarise_refund_reduces_spent(handler):
    # A refund (positive amount) in a spend category reduces posted spend (net).
    txns = [_transaction("coffee", -50), _transaction("coffee", 20)]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result["coffee"]["posted"] == Decimal("30")


def test_summarise_net_refund_clamped_to_zero(handler):
    # A category whose net is a refund clamps at 0 (no negative bar).
    txns = [_transaction("coffee", 20)]

    result = handler.summarise_transactions(txns, {"coffee"})

    assert result["coffee"]["posted"] == Decimal("0")


def test_summarise_empty(handler):
    assert handler.summarise_transactions([], {"coffee"}) == {}


def test_summarise_skips_unknown_status(handler):
    # An unrecognised status isn't guessed into a bucket -> the txn is skipped.
    txns = [_transaction("coffee", -50, status="settled")]

    assert handler.summarise_transactions(txns, {"coffee"}) == {}


# --- summarise_income: the earn-target counterpart (WHIT-69) ------------------


def test_summarise_income_routes_posted_and_pending(handler):
    # Income is stored POSITIVE; posted -> posted bucket, pending -> pending bucket.
    txns = [_transaction("salary", 3000, "posted"), _transaction("salary", 500, "pending")]

    result = handler.summarise_income(txns, {"salary"})

    assert result == {"salary": {"posted": Decimal("3000"), "pending": Decimal("500")}}


def test_summarise_income_sums_and_ignores_non_income_ids(handler):
    txns = [
        _transaction("salary", 3000), _transaction("salary", 200),   # summed
        _transaction("coffee", -50),                                  # not an income id
        _transaction("side_gig", 400),                               # income id not targeted
        _transaction("salary", 99, counts=False),                    # not counts_to_budget
    ]

    result = handler.summarise_income(txns, {"salary"})

    assert result == {"salary": {"posted": Decimal("3200"), "pending": Decimal("0")}}
    assert "coffee" not in result and "side_gig" not in result


def test_summarise_income_clawback_reduces_and_clamps(handler):
    # A negative amount (reversal/clawback) reduces earnings; a net-negative clamps to 0.
    reduced = handler.summarise_income(
        [_transaction("salary", 3000), _transaction("salary", -1000)], {"salary"})
    assert reduced["salary"]["posted"] == Decimal("2000")

    clamped = handler.summarise_income([_transaction("salary", -1000)], {"salary"})
    assert clamped["salary"]["posted"] == Decimal("0")


def test_summarise_income_does_not_skip_income_sentinel_id(handler):
    # summarise_transactions skips the literal "income" sentinel; summarise_income must
    # NOT — a user income category can slug to "income" and is a real target.
    result = handler.summarise_income([_transaction("income", 3000, "posted")], {"income"})

    assert result == {"income": {"posted": Decimal("3000"), "pending": Decimal("0")}}


def test_summarise_income_skips_unknown_status(handler):
    assert handler.summarise_income([_transaction("salary", 3000, status="settled")], {"salary"}) == {}


def test_summarise_income_empty(handler):
    assert handler.summarise_income([], {"salary"}) == {}


def test_spend_contribution_income_sign_returns_positive(handler):
    # sign=+1 keeps a positive income amount positive (posted bucket).
    assert handler._spend_contribution(_transaction("salary", 3000, "posted"), sign=1) == (
        "posted", Decimal("3000"))


# --- _spend_contribution: the shared helper both summarisers call (WHIT-106) --


def test_spend_contribution_posted_returns_bucket_and_positive_spend(handler):
    # Spend stored negative -> contribution is -amount (positive) in the posted bucket.
    assert handler._spend_contribution(_transaction("coffee", -50, "posted")) == (
        "posted", Decimal("50"))


def test_spend_contribution_pending_uses_pending_bucket(handler):
    assert handler._spend_contribution(_transaction("coffee", -12, "pending")) == (
        "pending", Decimal("12"))


def test_spend_contribution_refund_is_a_negative_contribution(handler):
    # A refund (positive amount) yields a negative spend; the caller clamps, not this.
    assert handler._spend_contribution(_transaction("coffee", 20, "posted")) == (
        "posted", Decimal("-20"))


def test_spend_contribution_none_when_not_counting(handler):
    assert handler._spend_contribution(_transaction("coffee", -50, counts=False)) is None


def test_spend_contribution_none_on_unknown_status(handler):
    assert handler._spend_contribution(_transaction("coffee", -50, status="settled")) is None


def test_current_cycle_window_end_is_today_inclusive(handler):
    from datetime import date
    # WHIT-75: the end bound is today itself (inclusive), NOT today+1 — date-only
    # storage + inclusive `between` means `today` already covers all of today's spend,
    # and a transaction dated tomorrow must be excluded.
    _, end = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 2, 15))
    assert end == "2024-02-15"          # today, inclusive
    assert end < "2024-02-16"           # tomorrow is out of the window


def test_current_cycle_window_k_selection_across_cycles(handler):
    from datetime import date
    # last_pay_date 2024-01-03, length 14; today 2024-02-15 is 43 days on -> k=3 -> +42 days.
    start, _ = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 2, 15))
    assert start == "2024-02-14"


def test_current_cycle_window_today_on_payday_starts_new_cycle(handler):
    from datetime import date
    # Exactly `length` days after the last_pay_date: a fresh cycle starts today.
    start, _ = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 1, 17))
    assert start == "2024-01-17"


def test_current_cycle_window_day_before_payday_still_previous_cycle(handler):
    from datetime import date
    # length-1 days after the last_pay_date: still the last_pay_date's cycle.
    start, _ = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 1, 16))
    assert start == "2024-01-03"


def test_current_cycle_window_length_variants(handler):
    from datetime import date
    today = date(2024, 3, 1)  # 58 days after the last_pay_date
    # weekly: k=8 -> +56 days -> 2024-02-28; monthly: k=1 -> +30 -> 2024-02-02.
    assert handler.current_cycle_window("2024-01-03", 7, today=today)[0] == "2024-02-28"
    assert handler.current_cycle_window("2024-01-03", 30, today=today)[0] == "2024-02-02"


def test_current_cycle_window_future_last_pay_date_clamped(handler):
    from datetime import date
    # A future last_pay_date has no valid k; the window must not invert. It collapses
    # to the single inclusive day [today, today] — today's spend still counts.
    start, end = handler.current_cycle_window("2024-06-05", 14, today=date(2024, 6, 1))
    assert start == "2024-06-01"       # clamped to today
    assert start == end == "2024-06-01"  # single inclusive day, not inverted/empty


def test_current_cycle_window_payday_end_covers_today(handler):
    from datetime import date
    # On payday, cycle_start == today; the window is the single inclusive day
    # [today, today], so a transaction dated today still lands in the fresh cycle.
    start, end = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 1, 17))
    assert start == end == "2024-01-17"


class _DateFilteringTransactionRepo:
    """Like FakeTransactionRepo, but HONOURS the date bounds the way DynamoDB
    `between` does — inclusive on BOTH ends over date-only YYYY-MM-DD strings — so a
    boundary test can prove exactly which dates the window pulls in. Serves the pool
    once (then empties) so the per-account loop sums each transaction a single time."""

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


def test_list_budgets_window_excludes_tomorrow_includes_boundaries(handler, monkeypatch):
    # WHIT-75 end-to-end: on the day BEFORE payday, a transaction dated TOMORROW (the
    # next payday) must NOT smear into this cycle, while both cycle_start and today
    # count. Fails on the old `today+1` end (would sum 30); passes on the fix (sums 20).
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = _DateFilteringTransactionRepo(transactions=[
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-03"},  # cycle_start -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-16"},  # today       -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-17"},  # tomorrow    -> OUT
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), FakeCategoryRepo())

    assert result == {"coffee": {"target": Decimal("100"), "posted": Decimal("20"), "pending": Decimal("0")}}
    assert txn_repo.calls[0][2] == "2024-01-16"  # queried end bound is today, not today+1


def test_list_budgets_window_excludes_day_before_cycle_start(handler, monkeypatch):
    # WHIT-75 lower-bound guard (regression): a transaction dated the day BEFORE
    # cycle_start (last cycle's spend) must NOT count in this cycle, while cycle_start
    # itself does. Locks the start bound the same way the end bound is locked.
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = _DateFilteringTransactionRepo(transactions=[
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-02"},  # day before cycle_start -> OUT
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-03"},  # cycle_start            -> IN
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), FakeCategoryRepo())

    assert result == {"coffee": {"target": Decimal("100"), "posted": Decimal("10"), "pending": Decimal("0")}}
    assert txn_repo.calls[0][1] == "2024-01-03"  # queried start bound is cycle_start


def test_list_budgets_window_excludes_pending_dated_tomorrow(handler, monkeypatch):
    # WHIT-75 for the PENDING bucket: a pending authorisation dated tomorrow must not
    # leak in either — pending stays 0, today's pending still counts.
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = _DateFilteringTransactionRepo(transactions=[
        {**_transaction("coffee", -10, "pending"), "date": "2024-01-16"},  # today    -> IN
        {**_transaction("coffee", -10, "pending"), "date": "2024-01-17"},  # tomorrow -> OUT
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), FakeCategoryRepo())

    assert result == {"coffee": {"target": Decimal("100"), "posted": Decimal("0"), "pending": Decimal("10")}}


def test_list_budgets_window_monthly_excludes_tomorrow(handler, monkeypatch):
    # Boundary independence from cycle length: with a 30-day cycle the end is still
    # `today`, so a txn dated tomorrow is excluded and cycle_start still counts.
    from datetime import date
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 2, 1))  # 29 days on -> cycle_start 2024-01-03
    budget_repo = FakeBudgetRepo(budgets={"coffee": {"target": Decimal("100")}})
    txn_repo = _DateFilteringTransactionRepo(transactions=[
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-03"},  # cycle_start -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-02-01"},  # today       -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-02-02"},  # tomorrow    -> OUT
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(length=30), FakeCategoryRepo())

    assert result == {"coffee": {"target": Decimal("100"), "posted": Decimal("20"), "pending": Decimal("0")}}
    assert txn_repo.calls[0][2] == "2024-02-01"  # end bound is today regardless of length


def test_current_cycle_window_injectable_today_is_deterministic(handler):
    from datetime import date
    a = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 2, 15))
    b = handler.current_cycle_window("2024-01-03", 14, today=date(2024, 2, 15))
    assert a == b


def test_current_cycle_window_defaults_to_melbourne_today(handler, monkeypatch):
    from datetime import date
    # With no explicit `today`, the window uses _melbourne_today().
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 2, 15))
    start, end = handler.current_cycle_window("2024-01-03", 14)
    assert (start, end) == ("2024-02-14", "2024-02-15")


def test_melbourne_today_maps_utc_instant_to_local_date(handler, monkeypatch):
    from datetime import datetime, timezone
    # 2024-06-30T15:30Z is already 2024-07-01 in Melbourne (UTC+10 in June/AEST).
    class _FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2024, 6, 30, 15, 30, tzinfo=timezone.utc).astimezone(tz)
    import spend
    monkeypatch.setattr(spend, "datetime", _FrozenDatetime)
    assert spend._melbourne_today().isoformat() == "2024-07-01"


def test_melbourne_today_falls_back_to_utc_when_tzdata_missing(handler, monkeypatch):
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfoNotFoundError
    # Simulate tzdata missing from the layer: ZoneInfo raises. The budget path must
    # degrade to UTC, not 500.
    import spend
    monkeypatch.setattr(spend, "_MELBOURNE", None)
    def _boom(name):
        raise ZoneInfoNotFoundError(name)
    monkeypatch.setattr(spend, "ZoneInfo", _boom)
    assert spend._melbourne_today() == datetime.now(timezone.utc).date()


# --- WHIT-220 Step 2: adversarial gap tests for sub-category roll-up ----------
# Independent of the implementer's happy-path set above (QA-authored). Exercises the
# full handler.list_budgets + shared/spend roll-up. IDs map to the QA checklist.


def test_noncounting_leaf_txn_excluded_from_parent(handler):
    # [A20] a counts_to_budget=False txn on a leaf must NOT roll up into the parent.
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("200")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("parking", -30, "posted", counts=True),
        _transaction("parking", -999, "posted", counts=False),  # excluded
        _transaction("other", -45, "posted", counts=True),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "other", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"target": Decimal("200"), "posted": Decimal("75"), "pending": Decimal("0")}}


def test_pending_posted_mix_folds_across_leaves(handler):
    # [A21] pending vs posted fold into separate parent totals across DIFFERENT leaves.
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("300")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("parking", -30, "posted"),
        _transaction("parking", -5, "pending"),
        _transaction("other", -45, "posted"),
        _transaction("other", -20, "pending"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "other", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"target": Decimal("300"), "posted": Decimal("75"), "pending": Decimal("25")}}


def test_income_clawback_on_one_leaf_clamps_at_zero(handler):
    # [A22] a clawback netting ONE income leaf negative clamps that leaf at 0 without
    # dragging down a sibling leaf's positive earnings; parent stays >= 0.
    budget_repo = FakeBudgetRepo(budgets={"income": {"target": Decimal("6000")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("salary", 4000, "posted"),
        _transaction("side", 250, "posted"),
        _transaction("side", -1000, "posted"),  # net -750 on `side` -> clamp 0
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "income", "bucket": "Income", "parent": None},
        {"id": "salary", "bucket": "Income", "parent": "income"},
        {"id": "side", "bucket": "Income", "parent": "income"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    # salary 4000 + side clamped to 0 = 4000 (never 3250, never negative).
    assert result == {"income": {"target": Decimal("6000"), "posted": Decimal("4000"), "pending": Decimal("0")}}


def test_no_leakage_between_parent_subtree_and_sibling_toplevel(handler):
    # [A23] a parent's subtree and an unrelated top-level sibling category don't leak.
    budget_repo = FakeBudgetRepo(budgets={
        "car": {"target": Decimal("200")},
        "coffee": {"target": Decimal("60")},
    })
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("parking", -30, "posted"),
        _transaction("coffee", -50, "posted"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "coffee", "bucket": "Lifestyle", "parent": None},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {
        "car": {"target": Decimal("200"), "posted": Decimal("30"), "pending": Decimal("0")},
        "coffee": {"target": Decimal("60"), "posted": Decimal("50"), "pending": Decimal("0")},
    }


def test_two_disjoint_parents_do_not_cross_contaminate(handler):
    # [A24] two budgeted parents with disjoint leaf sets roll up independently.
    budget_repo = FakeBudgetRepo(budgets={
        "car": {"target": Decimal("200")},
        "food": {"target": Decimal("400")},
    })
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("parking", -30, "posted"),
        _transaction("petrol", -20, "pending"),
        _transaction("groceries", -100, "posted"),
        _transaction("dining", -40, "pending"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "petrol", "bucket": "Living", "parent": "car"},
        {"id": "food", "bucket": "Living", "parent": None},
        {"id": "groceries", "bucket": "Living", "parent": "food"},
        {"id": "dining", "bucket": "Living", "parent": "food"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {
        "car": {"target": Decimal("200"), "posted": Decimal("30"), "pending": Decimal("20")},
        "food": {"target": Decimal("400"), "posted": Decimal("100"), "pending": Decimal("40")},
    }


def test_five_level_chain_rolls_to_top(handler):
    # [A25] a 5-level chain rolls the bottom leaf all the way to the top target.
    budget_repo = FakeBudgetRepo(budgets={"l1": {"target": Decimal("500")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("l5", -60, "posted"),
        _transaction("l5", -10, "pending"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "l1", "bucket": "Living", "parent": None},
        {"id": "l2", "bucket": "Living", "parent": "l1"},
        {"id": "l3", "bucket": "Living", "parent": "l2"},
        {"id": "l4", "bucket": "Living", "parent": "l3"},
        {"id": "l5", "bucket": "Living", "parent": "l4"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"l1": {"target": Decimal("500"), "posted": Decimal("60"), "pending": Decimal("10")}}


def test_midlevel_and_ancestor_both_budgeted_double_count(handler):
    # [A26] a mid node budgeted AND under another budgeted parent: the shared bottom
    # leaf counts in BOTH rows, each independently correct.
    budget_repo = FakeBudgetRepo(budgets={
        "car": {"target": Decimal("300")},
        "daily": {"target": Decimal("150")},
    })
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("petrol", -60, "posted"),   # under daily -> under car
        _transaction("parking", -25, "posted"),  # under car only
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "daily", "bucket": "Living", "parent": "car"},
        {"id": "petrol", "bucket": "Living", "parent": "daily"},
        {"id": "parking", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result["daily"]["posted"] == Decimal("60")   # petrol only
    assert result["car"]["posted"] == Decimal("85")     # petrol + parking


def test_corrupt_cross_bucket_subtree_mixes_income_into_spend(handler):
    # [A27] CHARACTERIZATION: an income leaf mis-parented under a spend parent has its
    # positive earnings summed into the spend parent's posted. The same-bucket rule is
    # enforced on WRITE (Step 1), so this state is unreachable via the API; this test
    # documents the fold's raw behaviour on corrupt data so a future guard flips it
    # deliberately (see WHIT-220 QA finding R1).
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("200")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("parking", -30, "posted"),
        _transaction("bonus", 500, "posted"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "bonus", "bucket": "Income", "parent": "car"},  # corrupt (write-guard blocks this)
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result["car"]["posted"] == Decimal("530")  # 30 spend + 500 income, mixed


# ===========================================================================
# QA GAP tests (WHIT-228) — parent-DIRECT edges the implementer's tests don't
# lock: the per-id >=0 clamp now applies to the PARENT's OWN id (never summed
# pre-228), a refund straight onto the parent, mixed posted+pending straight
# onto the parent, and the (deferred) cross-bucket child rollup.
# ===========================================================================


def test_list_budgets_parent_direct_refund_clamps_at_parent_id_not_sibling(handler):
    # A refund (POSITIVE amount) tagged DIRECTLY onto the parent `car` must clamp at
    # car's OWN id (>=0) and must NOT bleed a negative into a sibling leaf's spend.
    # parking -60 (leaf) + car +100 refund (direct). Correct: car-id clamps to 0 -> fold
    # = 60. WHIT-228 is the first time the parent id itself is summarised, so its per-id
    # clamp is newly load-bearing. Fail-on-revert of the clamp in _summarise -> car -40.
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("200")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("parking", -60, "posted"),
        _transaction("car", 100, "posted"),      # refund straight onto the parent
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"target": Decimal("200"), "posted": Decimal("60"), "pending": Decimal("0")}}


def test_list_budgets_parent_direct_mixed_posted_and_pending_no_leaf_spend(handler):
    # Both a posted AND a pending write tagged straight onto the parent, with ZERO leaf
    # spend: each bucket routes through the parent id. Pre-228 (leaves-only) `car` is not
    # a leaf -> both dropped -> {0,0}. Fail-on-revert (leaves-only): posted 0 / pending 0.
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("300")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("car", -40, "posted"),
        _transaction("car", -25, "pending"),
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},   # a child exists but is unspent
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    assert result == {"car": {"target": Decimal("300"), "posted": Decimal("40"), "pending": Decimal("25")}}


def test_list_budgets_cross_bucket_child_folds_into_parent_no_server_guard(handler):
    # DOCUMENTS A LATENT GAP (WHIT-228 defers the same-bucket guard to the client): a
    # child in a DIFFERENT spend bucket (Lifestyle) under a Living parent has its spend
    # folded into the Living parent, because subtree_ids has no same-bucket filter and
    # the bucket split is per-id (a Lifestyle id is still "spend" -> spend_ids -> the
    # parent's fold). The /breakdown client hides this with a same-bucket guard; the
    # server does not. Characterization, NOT a fail-on-revert of the fix -> flagged in
    # the critique as an acceptable-for-scope (corrupt-data-only) risk.
    budget_repo = FakeBudgetRepo(budgets={"car": {"target": Decimal("300")}})
    txn_repo = FakeTransactionRepo(transactions=[
        _transaction("misfiled", -50, "posted"),   # Lifestyle child under a Living parent
    ])
    category_repo = FakeCategoryRepo(categories=[
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "misfiled", "bucket": "Lifestyle", "parent": "car"},
    ])

    result = handler.list_budgets(budget_repo, txn_repo, FakePayCycleRepo(), category_repo)

    # The cross-bucket child's spend IS summed into the Living parent (current behaviour).
    assert result == {"car": {"target": Decimal("300"), "posted": Decimal("50"), "pending": Decimal("0")}}
