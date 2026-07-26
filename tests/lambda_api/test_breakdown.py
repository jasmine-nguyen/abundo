"""Tests for GET /breakdown (list_category_breakdown) — spend by category for the
current pay cycle, plus the Uncategorized bucket (WHIT-23).

Reuses the direct-call pattern from test_budgets.py: the handler is provided by the
`handler` fixture (conftest.py), and list_category_breakdown takes its three repos
as params, so tests call it directly with fakes — no patching, no AWS.
"""

from datetime import date
from decimal import Decimal

import pytest


class FakeCategoryRepo:
    """Stand-in for CategoryRepository — serves a fixed taxonomy."""

    def __init__(self, categories=None):
        self._categories = categories or []
        self.list_calls = 0

    def list_categories(self):
        self.list_calls += 1
        return [dict(c) for c in self._categories]


class FakeTransactionRepo:
    """Serves a single page of `transactions` per account then empties, so the
    per-account loop in _fetch_windowed_transactions sums each txn once."""

    def __init__(self, transactions=None):
        self._queue = [(list(transactions or []), None)]
        self.calls = []

    def get_transactions_by_date_range(self, account_id, start_date, end_date, limit=20, cursor=None):
        self.calls.append((account_id, start_date, end_date, limit, cursor))
        return self._queue.pop(0) if self._queue else ([], None)


class _DateFilteringTransactionRepo:
    """Honours the date bounds the way DynamoDB `between` does — inclusive on both
    ends over YYYY-MM-DD strings — so a window test can prove which dates are pulled
    in. Serves the pool once total (then empties)."""

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


class FakePayCycleRepo:
    def __init__(self, length=14, last_pay_date="2024-01-03"):
        self._cycle = {"length": length, "last_pay_date": last_pay_date}

    def get_paycycle(self):
        return dict(self._cycle)


def _category(cat_id, bucket, name=None):
    return {"id": cat_id, "name": name or cat_id.title(), "icon": "tag",
            "color": "#123456", "bucket": bucket}


def _transaction(category, amount, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": counts}


# --- happy path --------------------------------------------------------------


def test_breakdown_splits_posted_and_pending_per_category(handler):
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle"), _category("groceries", "Living")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -50, "posted"),
        _transaction("coffee", -12, "pending"),
        _transaction("groceries", -30, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {
        "coffee": {"posted": Decimal("50"), "pending": Decimal("12")},
        "groceries": {"posted": Decimal("30"), "pending": Decimal("0")},
        "__rollup__": {"nodes": {}},
    }


def test_breakdown_no_uncategorized_key_when_clean(handler):
    # Every spend txn maps to a spend-bucket category -> no __uncategorized__ row.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([_transaction("coffee", -10, "posted")])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"coffee": {"posted": Decimal("10"), "pending": Decimal("0")}, "__rollup__": {"nodes": {}}}
    assert "__uncategorized__" not in result


# --- Uncategorized bucket (the core gap this card closes) --------------------


def test_breakdown_raw_bank_enum_folds_into_uncategorized(handler):
    # An un-ruled txn keeps its raw uppercase BankSync category (not a slug, not in
    # the taxonomy). It counts to budget, so it must land in __uncategorized__, not
    # be silently dropped.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -50, "posted"),
        _transaction("MEDICAL", -20, "posted"),
        _transaction("ENTERTAINMENT", -5, "pending"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["coffee"] == {"posted": Decimal("50"), "pending": Decimal("0")}
    assert result["__uncategorized__"] == {"posted": Decimal("20"), "pending": Decimal("5")}


def test_breakdown_null_category_folds_into_uncategorized(handler):
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -10, "posted"),
        _transaction(None, -15, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__uncategorized__"] == {"posted": Decimal("15"), "pending": Decimal("0")}


def test_breakdown_deleted_category_spend_folds_into_uncategorized(handler):
    # A txn points at an id no longer in the taxonomy (category was deleted). Its
    # spend folds into Uncategorized rather than vanishing.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -10, "posted"),
        _transaction("oldcat", -25, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "oldcat" not in result
    assert result["__uncategorized__"] == {"posted": Decimal("25"), "pending": Decimal("0")}


# --- Income/Savings exclusion (spend view) -----------------------------------


def test_breakdown_excludes_income_and_savings_buckets(handler):
    # A user category in an Income/Savings bucket is in the taxonomy, so it is
    # NEITHER a spend row NOR folded into Uncategorized. The literal "income"
    # sentinel is excluded too. No $0 phantom rows.
    cats = FakeCategoryRepo([
        _category("coffee", "Lifestyle"),
        _category("salary", "Income"),
        _category("mortgage", "Savings"),
    ])
    txns = FakeTransactionRepo([
        _transaction("coffee", -40, "posted"),
        _transaction("salary", -100, "posted"),    # Income bucket -> excluded
        _transaction("mortgage", -200, "posted"),  # Savings bucket -> excluded
        _transaction("income", -100, "posted"),    # income sentinel -> excluded
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"coffee": {"posted": Decimal("40"), "pending": Decimal("0")}, "__rollup__": {"nodes": {}}}


# --- refund clamping ---------------------------------------------------------


def test_breakdown_net_refund_spend_category_clamps_to_zero(handler):
    # Refunds exceed charges -> the per-category bucket clamps at 0 (never negative).
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -30, "posted"),
        _transaction("coffee", 50, "posted"),  # refund (positive amount)
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["coffee"] == {"posted": Decimal("0"), "pending": Decimal("0")}


def test_breakdown_net_refund_uncategorized_is_omitted(handler):
    # A net-refund Uncategorized bucket clamps to 0 -> no __uncategorized__ key.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -10, "posted"),
        _transaction("MEDICAL", -30, "posted"),
        _transaction("MEDICAL", 50, "posted"),  # refund > charge
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "__uncategorized__" not in result


# --- window ------------------------------------------------------------------


def test_breakdown_applies_current_cycle_window(handler, monkeypatch):
    # The window is the current pay cycle (Melbourne clock), inclusive [start, today].
    # A tomorrow-dated txn is excluded; older-than-7-days but in-cycle spend is IN
    # (guards the FEED_WINDOW_DAYS trap that made a client-side derivation wrong).
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-03"},  # cycle_start -> IN (13 days ago)
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-16"},  # today       -> IN
        {**_transaction("coffee", -10, "posted"), "date": "2024-01-17"},  # tomorrow    -> OUT
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"coffee": {"posted": Decimal("20"), "pending": Decimal("0")}, "__rollup__": {"nodes": {}}}
    assert txns.calls[0][2] == "2024-01-16"  # queried end bound is today, not today+1


def test_breakdown_no_spend_still_emits_empty_rollup(handler):
    # No spend at all -> no flat keys, but __rollup__ is ALWAYS present (WHIT-358) with
    # empty nodes. Fail-on-revert of the always-emit branch: dropping it makes this {}.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])

    result = handler.list_category_breakdown(cats, FakeTransactionRepo([]), FakePayCycleRepo())

    assert result == {"__rollup__": {"nodes": {}}}


# --- earned bucket (total income for the Earned-vs-Spent chart, WHIT-312) -----


def test_breakdown_earned_sums_all_income_categories(handler):
    # Every Income-bucket category counts toward __earned__ (targeted or not — the
    # chart wants what was actually earned). Income is stored POSITIVE; posted +
    # pending are summed into one aggregate.
    cats = FakeCategoryRepo([
        _category("coffee", "Lifestyle"),
        _category("salary", "Income"),
        _category("dividends", "Income"),
    ])
    txns = FakeTransactionRepo([
        _transaction("coffee", -40, "posted"),
        _transaction("salary", 2500, "posted"),
        _transaction("salary", 300, "pending"),
        _transaction("dividends", 75, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    # Spend row unaffected; earned is the total across both Income categories.
    assert result["coffee"] == {"posted": Decimal("40"), "pending": Decimal("0")}
    assert result["__earned__"] == {"posted": Decimal("2575"), "pending": Decimal("300")}


def test_breakdown_no_earned_key_when_no_income(handler):
    # Spend but no income -> no __earned__ key (response is what it always was).
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([_transaction("coffee", -10, "posted")])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "__earned__" not in result


def test_breakdown_earned_net_reversal_clamps_and_omits_key(handler):
    # A clawback bigger than the earnings drives the aggregate <= 0 -> clamp to 0,
    # so no __earned__ key (never a negative earned bar).
    cats = FakeCategoryRepo([_category("salary", "Income")])
    txns = FakeTransactionRepo([
        _transaction("salary", 100, "posted"),
        _transaction("salary", -250, "posted"),  # clawback/reversal
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "__earned__" not in result


def test_breakdown_earned_excludes_excluded_and_uncounted_income(handler):
    # budget_excluded / counts_to_budget=False income does not count, mirroring spend.
    cats = FakeCategoryRepo([_category("salary", "Income")])
    txns = FakeTransactionRepo([
        _transaction("salary", 1000, "posted"),
        {**_transaction("salary", 500, "posted"), "budget_excluded": True},
        _transaction("salary", 400, "posted", counts=False),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__earned__"] == {"posted": Decimal("1000"), "pending": Decimal("0")}


def test_breakdown_earned_counts_in_cycle_income_older_than_feed_window(handler, monkeypatch):
    # The whole reason earned is server-side: a paycheck lands once a cycle, often
    # >7 days ago. It must be counted over the FULL cycle window, not a 7-day feed.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("salary", "Income")])
    txns = _DateFilteringTransactionRepo([
        {**_transaction("salary", 2500, "posted"), "date": "2024-01-03"},  # cycle_start, 13 days ago -> IN
        {**_transaction("salary", 100, "posted"), "date": "2024-01-17"},   # tomorrow -> OUT
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__earned__"] == {"posted": Decimal("2500"), "pending": Decimal("0")}


def test_breakdown_earned_uses_prior_cycle_window(handler, monkeypatch):
    # cycle=1 earns over the prior FULL cycle: income in the current window is excluded.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("salary", "Income")])
    txns = _DateFilteringTransactionRepo([
        {**_transaction("salary", 2000, "posted"), "date": "2023-12-20"},  # prior cycle -> IN for cycle=1
        {**_transaction("salary", 2500, "posted"), "date": "2024-01-05"},  # current cycle -> OUT for cycle=1
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo(), cycle=1)

    assert result["__earned__"] == {"posted": Decimal("2000"), "pending": Decimal("0")}


def test_breakdown_earned_coexists_with_spend_and_uncategorized(handler):
    # One response can carry spend rows, __uncategorized__, AND __earned__ — none leaks
    # into another. Income never appears as a spend/uncategorized row and vice-versa.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle"), _category("salary", "Income")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -40, "posted"),
        _transaction("MEDICAL", -20, "posted"),  # raw enum -> uncategorized
        _transaction("salary", 2500, "posted"),  # income -> earned
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["coffee"] == {"posted": Decimal("40"), "pending": Decimal("0")}
    assert result["__uncategorized__"] == {"posted": Decimal("20"), "pending": Decimal("0")}
    assert result["__earned__"] == {"posted": Decimal("2500"), "pending": Decimal("0")}


# --- dispatch (through lambda_handler) ---------------------------------------


def test_get_breakdown_dispatches_and_runs_real_body(handler, monkeypatch):
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([_transaction("coffee", -42, "posted")])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = {"rawPath": "/breakdown", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    import json
    assert json.loads(resp["body"]) == {"coffee": {"posted": 42, "pending": 0}, "__rollup__": {"nodes": {}}}


# --- adversarial gaps (qa) ---------------------------------------------------


def test_breakdown_ignores_non_budget_counting_spend(handler):
    # A transfer/excluded charge (counts_to_budget=False) must not appear as a
    # category row NOR fold into Uncategorized — whether its category is a real
    # spend id or a raw enum. Guards the counts_to_budget gate in BOTH summarisers.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -10, "posted"),                 # in
        _transaction("coffee", -99, "posted", counts=False),   # excluded spend cat
        _transaction("MEDICAL", -77, "posted", counts=False),  # excluded raw enum
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"coffee": {"posted": Decimal("10"), "pending": Decimal("0")}, "__rollup__": {"nodes": {}}}
    assert "__uncategorized__" not in result


def test_breakdown_uncategorized_ignores_unknown_status(handler):
    # summarise_uncategorized only buckets known posted/pending statuses; an
    # unexpected status (e.g. "cancelled") must not be silently counted as posted.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("MEDICAL", -20, "posted"),
        _transaction("MEDICAL", -50, "cancelled"),   # unknown status -> dropped
        _transaction("MEDICAL", -5, "pending"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__uncategorized__"] == {"posted": Decimal("20"), "pending": Decimal("5")}


def test_breakdown_only_uncategorized_bucket(handler):
    # Taxonomy exists but nothing landed in a spend category this cycle — the whole
    # response is just the Uncategorized bucket, no phantom spend-category keys.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction(None, -12, "posted"),
        _transaction("MEDICAL", -8, "pending"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"__uncategorized__": {"posted": Decimal("12"), "pending": Decimal("8")}, "__rollup__": {"nodes": {}}}


def test_breakdown_fractional_amounts_survive_decimal_encoder(handler, monkeypatch):
    # Through lambda_handler -> _json_response -> DecimalEncoder(float). Sub-dollar
    # amounts must serialise as JSON numbers with their cents intact, not be dropped
    # or stringified. (Binary-exact values chosen so the assert is deterministic.)
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -12.50, "posted"),
        _transaction("coffee", -0.25, "posted"),
        _transaction("coffee", -0.50, "pending"),
    ])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = {"rawPath": "/breakdown", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    import json
    body = json.loads(resp["body"])
    assert body == {"coffee": {"posted": 12.75, "pending": 0.5}, "__rollup__": {"nodes": {}}}
    assert isinstance(body["coffee"]["posted"], float)  # number, not "12.75"


# --- historical look-back (?cycle=, WHIT-68) --------------------------------
#
# today 2024-01-16, fortnightly, last pay 2024-01-03 → current cycle_start = 2024-01-03,
# so the prior cycle is [2023-12-20, 2024-01-02]. These pin that cycle=1 reads the prior
# window (not the current one) and that cycle=0/omitted is unchanged.


def _dated(cat, amount, d, status="posted"):
    return {**_transaction(cat, amount, status), "date": d}


def test_breakdown_cycle_1_reads_the_prior_window(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -10, "2023-12-25"),  # prior window   -> IN for cycle=1
        _dated("coffee", -99, "2024-01-10"),  # current window -> OUT for cycle=1
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo(), cycle=1)

    assert result == {"coffee": {"posted": Decimal("10"), "pending": Decimal("0")}, "__rollup__": {"nodes": {}}}
    assert txns.calls[0][1] == "2023-12-20"  # queried start = prior window start
    assert txns.calls[0][2] == "2024-01-02"  # queried end   = day before current start


def test_breakdown_cycle_0_is_byte_identical_to_the_default(handler, monkeypatch):
    # cycle=0 (and an omitted param) must be the unchanged current-cycle behaviour —
    # the backward-compat / fail-on-revert guard for the window selection.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    pool = [_dated("coffee", -20, "2024-01-10")]  # current window
    cats = lambda: FakeCategoryRepo([_category("coffee", "Lifestyle")])

    default = handler.list_category_breakdown(cats(), _DateFilteringTransactionRepo(list(pool)), FakePayCycleRepo())
    zero = handler.list_category_breakdown(cats(), _DateFilteringTransactionRepo(list(pool)), FakePayCycleRepo(), cycle=0)

    assert zero == default == {"coffee": {"posted": Decimal("20"), "pending": Decimal("0")}, "__rollup__": {"nodes": {}}}


def test_breakdown_past_window_predating_history_is_empty(handler, monkeypatch):
    # A prior cycle with no transactions (e.g. before first sync) → empty {}, which the
    # client renders as its "No spending in that pay cycle" empty state.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([_dated("coffee", -20, "2024-01-10")])  # all current-cycle

    assert handler.list_category_breakdown(cats, txns, FakePayCycleRepo(), cycle=1) == {"__rollup__": {"nodes": {}}}


def test_breakdown_cycle_param_flows_through_dispatch(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -10, "2023-12-25"),  # prior window
        _dated("coffee", -99, "2024-01-10"),  # current window
    ])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = {"rawPath": "/breakdown", "requestContext": {"http": {"method": "GET"}},
             "queryStringParameters": {"cycle": "1"}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    import json
    assert json.loads(resp["body"]) == {"coffee": {"posted": 10, "pending": 0}, "__rollup__": {"nodes": {}}}


@pytest.mark.parametrize("bad", ["-1", "abc", "1.5", "13", "999"])
def test_breakdown_bad_cycle_returns_400(handler, bad):
    # Non-int, negative, and above-cap (BREAKDOWN_MAX_LOOKBACK=12) all reject before any
    # repo is touched. Fail-loud, not a silent fallback to the current cycle.
    event = {"rawPath": "/breakdown", "requestContext": {"http": {"method": "GET"}},
             "queryStringParameters": {"cycle": bad}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 400


def test_parse_breakdown_cycle_defaults_and_validates(handler):
    # Absent / empty / None params → 0 (current cycle); a valid int passes; out-of-range
    # carries a 400 response.
    assert handler._parse_breakdown_cycle({}) == (0, None)
    assert handler._parse_breakdown_cycle({"queryStringParameters": None}) == (0, None)
    assert handler._parse_breakdown_cycle({"queryStringParameters": {"cycle": ""}}) == (0, None)
    assert handler._parse_breakdown_cycle({"queryStringParameters": {"cycle": "2"}}) == (2, None)
    cycle, err = handler._parse_breakdown_cycle({"queryStringParameters": {"cycle": "-1"}})
    assert cycle == 0 and err["statusCode"] == 400


# --- adversarial gaps (qa) — earned bucket, WHIT-312 --------------------------


def test_breakdown_positive_amount_in_spend_category_is_not_earned(handler):
    # [A16] A positive-amount txn filed under a SPEND-bucket category (a refund, or a mis-filed
    # paycheck) must NOT count as earned — the income gate is by BUCKET, not by amount sign.
    # Guards against a "positive amount == income" shortcut leaking spend-cat credits into
    # the earned bar.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = FakeTransactionRepo([_transaction("coffee", 500, "posted")])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "__earned__" not in result


def test_breakdown_renamed_income_category_still_earned_by_bucket(handler):
    # [A17] A user-renamed Income category (custom name, non-"income" id) still counts — the
    # gate is bucket == Income over the id set, not the name or the raw "income" sentinel.
    cats = FakeCategoryRepo([_category("side_hustle", "Income", name="Etsy shop")])
    txns = FakeTransactionRepo([_transaction("side_hustle", 640, "posted")])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__earned__"] == {"posted": Decimal("640"), "pending": Decimal("0")}


def test_get_breakdown_dispatches_and_serialises_earned_as_json_numbers(handler, monkeypatch):
    # [A8] Through lambda_handler -> _json_response -> DecimalEncoder: the __earned__ bucket's
    # Decimals (posted AND pending, incl. cents) must serialise as JSON numbers, not be
    # dropped or stringified — the client reads posted + pending off this. The existing
    # dispatch test carries no income, so this is the only end-to-end check of __earned__.
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle"), _category("salary", "Income")])
    txns = FakeTransactionRepo([
        _transaction("coffee", -12.50, "posted"),
        _transaction("salary", 2500.25, "posted"),
        _transaction("salary", 300.50, "pending"),
    ])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = {"rawPath": "/breakdown", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    import json
    body = json.loads(resp["body"])
    assert body["__earned__"] == {"posted": 2500.25, "pending": 300.5}
    assert isinstance(body["__earned__"]["posted"], float)  # a JSON number, not "2500.25"
    assert body["coffee"] == {"posted": 12.5, "pending": 0}


# --- WHIT-349 slice 2: server-owned netted parent rollup (__rollup__) ---------


def _child(cat_id, bucket, parent):
    return {**_category(cat_id, bucket), "parent": parent}


class _FakeBudgetRepo:
    """Minimal BudgetRepository stand-in for the /budgets parity cross-check."""

    def __init__(self, budgets):
        self._budgets = budgets

    def list_budgets(self):
        return {k: dict(v) for k, v in self._budgets.items()}


def test_breakdown_rollup_nets_refunded_sub_and_leaves_flat_keys_untouched(handler):
    # WHIT-349 slice 2: __rollup__ gives the netted parent total (aggregate-then-clamp,
    # like /budgets) so the donut stops summing floored leaves on the client. Car =
    # petrol 60 + tolls (50 - 80 refund = -30) = 30. The FLAT per-category keys stay
    # FLOORED and byte-identical (the pie slices + the category drill-in reconcile to
    # them): tolls floors to {0,0}, petrol {60,0}, and `car` (no direct spend) is absent.
    # Fail-on-revert: rolling the client's floored leaves gives 60, not 30.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", -50, "posted"),
        _transaction("tolls", 80, "posted"),       # refund bigger than tolls' own spend
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["petrol"] == {"posted": Decimal("60"), "pending": Decimal("0")}
    assert result["tolls"] == {"posted": Decimal("0"), "pending": Decimal("0")}   # floored, unchanged
    assert "car" not in result                                                    # no direct spend
    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("30"), "pending": Decimal("0")}


def test_breakdown_rollup_clamps_posted_and_pending_independently(handler):
    # The netted parent floors posted and pending SEPARATELY (mirroring /budgets), so a
    # subtree whose POSTED nets negative but PENDING is positive reads {0, 50} — not a
    # combined floor of 40. Fail-on-revert: a combined floor would give posted 0 pending 40.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -10, "posted"),
        _transaction("petrol", 20, "posted"),       # posted nets to -10
        _transaction("petrol", -50, "pending"),      # pending +50
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("0"), "pending": Decimal("50")}


def test_breakdown_flat_taxonomy_emits_empty_rollup(handler):
    # No nested parents -> __rollup__ is ALWAYS present (WHIT-358) but its nodes is {} —
    # a flat leaf reads its own floored flat value, so there is nothing to roll up. The
    # key being present (not absent) is the point: "no __rollup__" now means ONLY "old
    # server", which lets the client's fallback be a pure rollout shim (deletable in 5b).
    cats = FakeCategoryRepo([_category("coffee", "Lifestyle"), _category("groceries", "Living")])
    txns = FakeTransactionRepo([_transaction("coffee", -50), _transaction("groceries", -30)])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__rollup__"] == {"nodes": {}}


def test_breakdown_rollup_omits_parent_whose_subtree_nets_to_zero(handler):
    # A parent whose whole subtree nets to $0 (refunds cancel spend) is omitted from
    # __rollup__.nodes — a $0 parent has no donut slice. Fail-on-revert of the >0 guard:
    # it would emit {0,0}.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -40, "posted"),
        _transaction("petrol", 40, "posted"),        # net 0
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__rollup__"]["nodes"] == {}


def test_breakdown_rollup_parent_total_equals_list_budgets(handler):
    # The core invariant of the whole epic: the donut's netted parent (__rollup__) MUST
    # equal the Budgets bar for the same data. Drive both handlers on one refunded-sub
    # fixture and assert they agree. Fail-on-revert: the old client floored-leaf roll gives
    # 60 while /budgets gives 30, so this pins them together.
    cats = [
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ]
    txns = [
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", -50, "posted"),
        _transaction("tolls", 80, "posted"),
    ]

    breakdown = handler.list_category_breakdown(
        FakeCategoryRepo(cats), FakeTransactionRepo(txns), FakePayCycleRepo())
    budgets = handler.list_budgets(
        _FakeBudgetRepo({"car": {"target": Decimal("300")}}),
        FakeTransactionRepo(txns), FakePayCycleRepo(), FakeCategoryRepo(cats))

    assert breakdown["__rollup__"]["nodes"]["car"] == {
        "posted": budgets["car"]["posted"], "pending": budgets["car"]["pending"]}


# --- WHIT-349 slice 2: ADVERSARIAL GAP tests (QA, not the implementer's) ------
# Cover what the 5 implementer tests above do NOT: multi-LEVEL netting, the cross-
# bucket same-bucket guard (both directions), a parent with its own direct spend,
# nested parents each getting a node, __uncategorized__/__earned__ isolation, the
# ?cycle= look-back, and Income/Savings-parent exclusion. Each is designed to go RED
# if the fold reverts to per-id-floored OR the same-bucket subtree filter is dropped.


def test_breakdown_rollup_nets_grandchild_refund_two_levels_into_top_parent(handler):
    # WHIT-349 — [A6] multi-LEVEL netting: a refund on a GRANDCHILD (tolls, under the
    # mid-parent travel, under the top parent car) must net UP two levels into car's node,
    # and the mid-parent whose own subtree nets negative is omitted. car = petrol 60 +
    # (tolls 50 - 80 refund = -30) = 30. And it must equal /budgets for the same target.
    # Fail-on-revert: per-id-floored leaves give tolls 0 -> car 60 (the exact bug this
    # slice fixes), and a 1-level fold would miss the grandchild entirely.
    cats = [
        _category("car", "Living"),
        _child("travel", "Living", "car"),      # mid-parent (itself a parent)
        _child("tolls", "Living", "travel"),    # grandchild leaf
        _child("petrol", "Living", "car"),
    ]
    txns = [
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", -50, "posted"),
        _transaction("tolls", 80, "posted"),    # refund > the grandchild's own spend
    ]

    result = handler.list_category_breakdown(
        FakeCategoryRepo(cats), FakeTransactionRepo(txns), FakePayCycleRepo())
    budgets = handler.list_budgets(
        _FakeBudgetRepo({"car": {"target": Decimal("300")}}),
        FakeTransactionRepo(txns), FakePayCycleRepo(), FakeCategoryRepo(cats))

    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("30"), "pending": Decimal("0")}
    assert "travel" not in result["__rollup__"]["nodes"]           # mid-subtree nets < 0
    # The whole point of the epic: the donut node MUST equal the Budgets bar, at depth 2.
    assert result["__rollup__"]["nodes"]["car"] == {
        "posted": budgets["car"]["posted"], "pending": budgets["car"]["pending"]}


def test_breakdown_rollup_excludes_cross_bucket_child_mis_parented_under_spend_parent(handler):
    # WHIT-349 — [A7] the same-bucket guard (matches /budgets, WHIT-229): a Lifestyle
    # child mis-filed under a Living parent must NOT net into it. shop(Living) = groceries
    # 40; the mis-parented coffee(Lifestyle) +100 refund must be ignored, not drag shop to 0.
    # Fail-on-revert: drop the bucket filter and coffee's -100 nets in -> 40 folds to 0 ->
    # shop vanishes from nodes. Cross-checked against /budgets, which applies the same guard.
    cats = [
        _category("shop", "Living"),
        _child("groceries", "Living", "shop"),
        _child("coffee", "Lifestyle", "shop"),   # WRONG bucket for this parent
    ]
    txns = [
        _transaction("groceries", -40, "posted"),
        _transaction("coffee", 100, "posted"),    # big refund that would zero shop if it counted
    ]

    result = handler.list_category_breakdown(
        FakeCategoryRepo(cats), FakeTransactionRepo(txns), FakePayCycleRepo())
    budgets = handler.list_budgets(
        _FakeBudgetRepo({"shop": {"target": Decimal("300")}}),
        FakeTransactionRepo(txns), FakePayCycleRepo(), FakeCategoryRepo(cats))

    assert result["__rollup__"]["nodes"]["shop"] == {"posted": Decimal("40"), "pending": Decimal("0")}
    assert result["__rollup__"]["nodes"]["shop"] == {
        "posted": budgets["shop"]["posted"], "pending": budgets["shop"]["pending"]}


def test_breakdown_rollup_keeps_same_bucket_grandchild_under_cross_bucket_intermediate(handler):
    # WHIT-349 — [A8] the OTHER half of the guard: the walk descends THROUGH a cross-bucket
    # intermediate so a SAME-bucket grandchild beneath it still nets into the top parent
    # (matching the client's nearest-same-bucket-ancestor rule). living_top(Living) has a
    # Lifestyle mid, which has a Living leaf: the leaf's 30 rolls up to living_top; the
    # Lifestyle mid's own 50 does NOT. The mid, being a parent, gets its OWN node = 50.
    # Fail-on-revert: if the filter pruned descent (not just membership), the leaf is
    # dropped and living_top has no node.
    cats = [
        _category("living_top", "Living"),
        _child("lifestyle_mid", "Lifestyle", "living_top"),   # cross-bucket intermediate
        _child("living_leaf", "Living", "lifestyle_mid"),      # same bucket as the TOP, under the mid
    ]
    txns = [
        _transaction("living_leaf", -30, "posted"),
        _transaction("lifestyle_mid", -50, "posted"),
    ]

    result = handler.list_category_breakdown(
        FakeCategoryRepo(cats), FakeTransactionRepo(txns), FakePayCycleRepo())
    nodes = result["__rollup__"]["nodes"]

    assert nodes["living_top"] == {"posted": Decimal("30"), "pending": Decimal("0")}      # grandchild kept
    assert nodes["lifestyle_mid"] == {"posted": Decimal("50"), "pending": Decimal("0")}   # its own node, own bucket only


def test_breakdown_rollup_parent_node_includes_parents_own_direct_spend(handler):
    # WHIT-349 — [A9] subtree_ids includes the ROOT, so a transaction tagged directly onto
    # the parent (the picker allows it) counts in the parent's node ALONGSIDE its children:
    # car = own 25 + petrol 60 = 85. The FLAT car key stays the parent's own floored direct
    # spend (25). Fail-on-revert: a root-excluding subtree gives 60, not 85.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("car", -25, "posted"),      # tagged directly on the PARENT
        _transaction("petrol", -60, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["car"] == {"posted": Decimal("25"), "pending": Decimal("0")}            # flat = own direct spend
    assert result["petrol"] == {"posted": Decimal("60"), "pending": Decimal("0")}
    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("85"), "pending": Decimal("0")}


def test_breakdown_rollup_gives_each_nested_parent_its_own_node(handler):
    # WHIT-349 — [A10] a mid-tree node that is ITSELF a parent gets its own node too, and
    # it is correct (its subtree, not the whole tree). car (top) = petrol 60 + travel-direct
    # 5 + tolls 20 = 85; travel (mid) = its own 5 + tolls 20 = 25. Both must appear.
    # Fail-on-revert: excluding the root from a subtree drops travel's own 5 -> travel 20.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("travel", "Living", "car"),
        _child("tolls", "Living", "travel"),
        _child("petrol", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", -20, "posted"),
        _transaction("travel", -5, "posted"),    # direct on the mid-parent
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    nodes = result["__rollup__"]["nodes"]

    assert nodes["car"] == {"posted": Decimal("85"), "pending": Decimal("0")}
    assert nodes["travel"] == {"posted": Decimal("25"), "pending": Decimal("0")}


def test_breakdown_rollup_never_contains_uncategorized_or_earned(handler):
    # WHIT-349 — [A11] __rollup__ lives ALONGSIDE __uncategorized__ and __earned__ but
    # never folds them: nodes holds spend parents only. A raw-enum charge (MEDICAL) still
    # lands in __uncategorized__, income still lands in __earned__, and neither leaks into
    # nodes; nor does the leaf (petrol) appear as a node. Regression guard on key isolation.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _category("salary", "Income"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("MEDICAL", -20, "posted"),   # raw bank enum -> __uncategorized__
        _transaction("salary", 2000, "posted"),    # income -> __earned__
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__rollup__"]["nodes"] == {"car": {"posted": Decimal("60"), "pending": Decimal("0")}}
    assert "__uncategorized__" in result and "__earned__" in result
    for leaked in ("__uncategorized__", "__earned__", "salary"):
        assert leaked not in result["__rollup__"]["nodes"]


def test_breakdown_rollup_correct_over_prior_cycle_lookback(handler, monkeypatch):
    # WHIT-349 — [A12] the ?cycle= look-back still produces a correct NETTED rollup: only
    # the prior window's transactions count. cycle=1 window is [2023-12-20, 2024-01-02];
    # car = petrol 60 + (tolls 50 - 80 refund) = 30, and the current-cycle petrol -99 is
    # excluded. Fail-on-revert: ignore the window and the -99 changes car; floor per-id and
    # tolls -> 0 -> car 60.
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: date(2024, 1, 16))
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = _DateFilteringTransactionRepo([
        _dated("petrol", -60, "2023-12-25"),   # prior window
        _dated("tolls", -50, "2023-12-25"),    # prior window
        _dated("tolls", 80, "2023-12-26"),     # prior window refund
        _dated("petrol", -99, "2024-01-10"),   # CURRENT window -> excluded for cycle=1
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo(), cycle=1)

    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("30"), "pending": Decimal("0")}


def test_breakdown_rollup_excludes_income_and_savings_parents(handler):
    # WHIT-349 — [A13] nodes are SPEND_BUCKETS only: an Income parent and a Savings parent —
    # each with children and activity — must never appear (income would clamp to $0 spend
    # rows; savings isn't a spend view). Only the Living parent gets a node.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _category("pay", "Income"),
        _child("bonus", "Income", "pay"),
        _category("save", "Savings"),
        _child("emergency", "Savings", "save"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("bonus", 2000, "posted"),     # income
        _transaction("emergency", -500, "posted"),  # savings movement
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__rollup__"]["nodes"] == {"car": {"posted": Decimal("60"), "pending": Decimal("0")}}
    assert "pay" not in result["__rollup__"]["nodes"]
    assert "save" not in result["__rollup__"]["nodes"]


def test_get_breakdown_dispatches_and_serialises_rollup_as_nested_json_numbers(handler, monkeypatch):
    # WHIT-349 — [A14] end-to-end through lambda_handler -> _json_response -> DecimalEncoder:
    # __rollup__ is one level DEEPER than __earned__ ({"nodes": {id: {posted, pending}}}),
    # so this proves the encoder recurses and the netted parent's Decimals (incl. cents)
    # reach the client as JSON numbers, not strings or dropped keys. Nets a refunded sub so
    # the serialised number is the netted 47.50, not a floored-leaf 60.00.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60.00, "posted"),
        _transaction("tolls", -12.50, "posted"),   # petrol 60 + tolls 12.50 = 72.50 ...
        _transaction("tolls", 25.00, "posted"),      # ... minus a 25 refund -> net 47.50
    ])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = {"rawPath": "/breakdown", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    import json
    body = json.loads(resp["body"])
    # nodes AND refunds both serialise (WHIT-349 slice 3+4): the netted parent 47.50 and the
    # tolls refund -12.50 reach the client as JSON numbers, not strings or dropped keys.
    assert body["__rollup__"] == {
        "nodes": {"car": {"posted": 47.5, "pending": 0}},
        "refunds": {"car": [{"id": "tolls", "amount": -12.5}]},
    }
    assert isinstance(body["__rollup__"]["nodes"]["car"]["posted"], float)  # JSON number, not "47.50"
    assert isinstance(body["__rollup__"]["refunds"]["car"][0]["amount"], float)


# --- WHIT-349 slice 3+4: __rollup__.refunds (per-parent refund detail) --------


def test_breakdown_rollup_refunds_single_level_reconciles_to_node(handler):
    # WHIT-349 slice 3+4: a net-refunded direct child (tolls) is hidden from the flat rows
    # (floored to 0) but reported under refunds so the client can show a "refund" line. car =
    # petrol 60 + (tolls -30) = 30; refunds["car"] = [{tolls, -30}] and the shown child
    # (petrol 60) + the refund (-30) reconcile to nodes["car"] (30).
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", -50, "posted"),
        _transaction("tolls", 80, "posted"),       # refund > tolls' own spend
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert rollup["refunds"] == {"car": [{"id": "tolls", "amount": Decimal("-30")}]}
    node = rollup["nodes"]["car"]
    shown_child = result["petrol"]["posted"] + result["petrol"]["pending"]          # 60 (floored, shown)
    refund_sum = sum(r["amount"] for r in rollup["refunds"]["car"])                  # -30
    assert shown_child + refund_sum == node["posted"] + node["pending"]             # 60 - 30 == 30


def test_breakdown_rollup_refunds_name_collapsed_mid_parent_not_the_leaf(handler):
    # WHIT-349 slice 3+4 (Decision 1A): when the refunded leaf sits under a collapsed mid-parent
    # (car > travel > tolls), the refund line names the DIRECT child (travel) with its whole
    # subtree's net, so no client re-homing is needed. car = petrol 60 + travel-subtree(-30) = 30.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("travel", "Living", "car"),      # mid-parent, collapses (subtree nets < 0)
        _child("tolls", "Living", "travel"),
        _child("petrol", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", -50, "posted"),
        _transaction("tolls", 80, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert rollup["refunds"] == {"car": [{"id": "travel", "amount": Decimal("-30")}]}
    assert "travel" not in rollup["nodes"]      # collapsed, no node


def test_breakdown_rollup_refund_on_parents_own_direct_spend(handler):
    # WHIT-349 slice 3+4: a refund tagged DIRECTLY on the parent (net negative) is reported
    # under the parent's own id. car own = -20 (net refund), petrol +60 -> node 40; refunds
    # names car itself.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("car", -30, "posted"),
        _transaction("car", 50, "posted"),         # net -20 on the parent's own id
        _transaction("petrol", -60, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert rollup["nodes"]["car"] == {"posted": Decimal("40"), "pending": Decimal("0")}
    assert rollup["refunds"] == {"car": [{"id": "car", "amount": Decimal("-20")}]}


def test_breakdown_rollup_no_refunds_key_when_no_refund(handler):
    # A cycle with no net-refunded member has NO "refunds" key -> byte-identical to slice 2.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", -20, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "refunds" not in result["__rollup__"]
    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("80"), "pending": Decimal("0")}


def test_breakdown_rollup_no_refund_line_for_a_still_shown_member(handler):
    # WHIT-349 (Bug B fix): a member with a settled refund AND a new pending charge floors to
    # {0, +x} -> it still shows as a flat row, so it must NOT also get a refund line (no double-
    # render). tolls: posted -50 (settled refund) + pending 30 (new charge) -> flat {0, 30}.
    # petrol 60 -> car node posted max(0,60-50)=10, pending 30 -> {10,30}. No refunds key for car.
    # Fail-on-revert (drop the _hidden guard): tolls (combined net -20) would emit a refund line
    # AND still render as the $30 row.
    cats = FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = FakeTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", 50, "posted"),        # a settled refund on tolls
        _transaction("tolls", -30, "pending"),        # a new pending charge on tolls
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["tolls"] == {"posted": Decimal("0"), "pending": Decimal("30")}   # still a flat row
    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("10"), "pending": Decimal("30")}
    assert "refunds" not in result["__rollup__"]                                   # tolls not double-rendered
