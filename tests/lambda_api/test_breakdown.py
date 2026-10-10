"""Tests for GET /breakdown (list_category_breakdown) — spend by category for the
current pay cycle, plus the Uncategorized bucket (WHIT-23).

Reuses the direct-call pattern from test_budgets.py: the handler is provided by the
`handler` fixture (conftest.py), and list_category_breakdown takes its three repos
as params, so tests call it directly with fakes — no patching, no AWS.
"""

from datetime import date
from decimal import Decimal
from functools import partial

import pytest

from _api_event import api_event
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _transaction_range_fakes import _DateFilteringTransactionRepo, _QueuedTransactionRepo


FakePayCycleRepo = partial(_FakePayCycleRepo, length=14, last_pay_date="2024-01-03")


def _category(cat_id, bucket, name=None):
    return {"id": cat_id, "name": name or cat_id.title(), "icon": "tag",
            "color": "#123456", "bucket": bucket}


def _transaction(category, amount, status="posted", counts=True):
    return {"category": category, "amount": Decimal(str(amount)), "status": status,
            "counts_to_budget": counts}


# --- happy path --------------------------------------------------------------


def test_breakdown_splits_posted_and_pending_per_category(handler):
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle"), _category("groceries", "Living")])
    txns = _QueuedTransactionRepo([
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


# --- Uncategorized bucket (the core gap this card closes) --------------------


def test_breakdown_raw_bank_enum_folds_into_uncategorized(handler):
    # An un-ruled txn keeps its raw uppercase BankSync category (not a slug, not in
    # the taxonomy). It counts to budget, so it must land in __uncategorized__, not
    # be silently dropped.
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _QueuedTransactionRepo([
        _transaction("coffee", -50, "posted"),
        _transaction("MEDICAL", -20, "posted"),
        _transaction("ENTERTAINMENT", -5, "pending"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["coffee"] == {"posted": Decimal("50"), "pending": Decimal("0")}
    assert result["__uncategorized__"] == {"posted": Decimal("20"), "pending": Decimal("5")}


def test_breakdown_null_category_folds_into_uncategorized(handler):
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _QueuedTransactionRepo([
        _transaction("coffee", -10, "posted"),
        _transaction(None, -15, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__uncategorized__"] == {"posted": Decimal("15"), "pending": Decimal("0")}


# --- Income/Savings exclusion (spend view) -----------------------------------


def test_breakdown_excludes_income_and_savings_buckets(handler):
    # A user category in an Income/Savings bucket is in the taxonomy, so it is
    # NEITHER a spend row NOR folded into Uncategorized. The literal "income"
    # sentinel is excluded too. No $0 phantom rows.
    cats = _FakeCategoryRepo([
        _category("coffee", "Lifestyle"),
        _category("salary", "Income"),
        _category("mortgage", "Savings"),
    ])
    txns = _QueuedTransactionRepo([
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
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _QueuedTransactionRepo([
        _transaction("coffee", -30, "posted"),
        _transaction("coffee", 50, "posted"),  # refund (positive amount)
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["coffee"] == {"posted": Decimal("0"), "pending": Decimal("0")}


def test_breakdown_net_refund_uncategorized_is_omitted(handler):
    # A net-refund Uncategorized bucket clamps to 0 -> no __uncategorized__ key.
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _QueuedTransactionRepo([
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
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2024, 1, 16))
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
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
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])

    result = handler.list_category_breakdown(cats, _QueuedTransactionRepo([]), FakePayCycleRepo())

    assert result == {"__rollup__": {"nodes": {}}}


# --- earned bucket (total income for the Earned-vs-Spent chart, WHIT-312) -----


def test_breakdown_earned_sums_all_income_categories(handler):
    # Every Income-bucket category counts toward __earned__ (targeted or not — the
    # chart wants what was actually earned). Income is stored POSITIVE; posted +
    # pending are summed into one aggregate.
    cats = _FakeCategoryRepo([
        _category("coffee", "Lifestyle"),
        _category("salary", "Income"),
        _category("dividends", "Income"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("coffee", -40, "posted"),
        _transaction("salary", 2500, "posted"),
        _transaction("salary", 300, "pending"),
        _transaction("dividends", 75, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    # Spend row unaffected; earned is the total across both Income categories.
    assert result["coffee"] == {"posted": Decimal("40"), "pending": Decimal("0")}
    assert result["__earned__"] == {"posted": Decimal("2575"), "pending": Decimal("300")}


def test_breakdown_earned_excludes_excluded_and_uncounted_income(handler):
    # budget_excluded / counts_to_budget=False income does not count, mirroring spend.
    cats = _FakeCategoryRepo([_category("salary", "Income")])
    txns = _QueuedTransactionRepo([
        _transaction("salary", 1000, "posted"),
        {**_transaction("salary", 500, "posted"), "budget_excluded": True},
        _transaction("salary", 400, "posted", counts=False),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__earned__"] == {"posted": Decimal("1000"), "pending": Decimal("0")}


# --- __income__: per-source income breakdown (WHIT-366) ----------------------


def test_breakdown_income_sources_split_per_category(handler):
    # __income__ carries one entry per Income-bucket category that earned, keyed by id with
    # posted/pending — what the drill-into-Earned screen lists. On clean all-positive income the
    # sources sum to __earned__ exactly (aggregate-clamp-once == sum of per-source clamps).
    cats = _FakeCategoryRepo([
        _category("coffee", "Lifestyle"),
        _category("salary", "Income"),
        _category("dividends", "Income"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("coffee", -40, "posted"),
        _transaction("salary", 2500, "posted"),
        _transaction("salary", 300, "pending"),
        _transaction("dividends", 75, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {
        "salary": {"posted": Decimal("2500"), "pending": Decimal("300")},
        "dividends": {"posted": Decimal("75"), "pending": Decimal("0")},
    }
    # Reconciliation: the sources sum to the __earned__ headline on clean data.
    earned = result["__earned__"]
    total_sources = sum(
        (v["posted"] + v["pending"] for v in result["__income__"].values()), Decimal("0")
    )
    assert total_sources == earned["posted"] + earned["pending"]
    assert result["coffee"] == {"posted": Decimal("40"), "pending": Decimal("0")}  # spend untouched


def test_breakdown_reversed_source_survives_signed_and_reconciles(handler):
    # WHIT-376: a source clawed back this cycle survives as a SIGNED NEGATIVE row (clamp=False),
    # instead of vanishing — so the per-source list reconciles to __earned__ (the client renders
    # it as a "−$X" reversal, mirroring how Spend shows a net-refunded member). Both buckets stay
    # non-negative here, so __earned__ (aggregate clamp) == the raw net == the sum of the sources.
    cats = _FakeCategoryRepo([
        _category("salary", "Income"),
        _category("bonus", "Income"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("salary", 2000, "posted"),
        _transaction("bonus", 100, "posted"),
        _transaction("bonus", -250, "posted"),  # clawback > bonus -> bonus nets -150, KEPT signed
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {
        "salary": {"posted": Decimal("2000"), "pending": Decimal("0")},
        "bonus": {"posted": Decimal("-150"), "pending": Decimal("0")},  # kept, signed
    }
    assert result["__earned__"] == {"posted": Decimal("1850"), "pending": Decimal("0")}
    # Reconciliation now holds: the sources sum to the __earned__ headline (2000 - 150 == 1850).
    earned = result["__earned__"]
    total_sources = sum(
        (v["posted"] + v["pending"] for v in result["__income__"].values()), Decimal("0")
    )
    assert total_sources == earned["posted"] + earned["pending"]


def test_breakdown_income_sign_split_leaves_a_client_residual_for_the_plug(handler):
    # WHIT-376 edge: when the aggregate SETTLED bucket goes negative but PENDING keeps the total
    # positive, __earned__ clamps the settled bucket to 0 while the source keeps its raw signed net.
    # So the source net (100) is LESS than __earned__ (300) by the clamped-away settled reversal —
    # the client closes that 200 gap with one "adjustment" plug so the rows still sum to 300.
    cats = _FakeCategoryRepo([_category("salary", "Income")])
    txns = _QueuedTransactionRepo([
        _transaction("salary", 100, "posted"),
        _transaction("salary", -200, "posted"),  # settled bucket nets -100
        _transaction("salary", 300, "pending"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {"salary": {"posted": Decimal("-100"), "pending": Decimal("300")}}
    assert result["__earned__"] == {"posted": Decimal("0"), "pending": Decimal("300")}  # settled clamped to 0
    earned_total = result["__earned__"]["posted"] + result["__earned__"]["pending"]  # 300
    source_total = result["__income__"]["salary"]["posted"] + result["__income__"]["salary"]["pending"]  # 200
    assert earned_total - source_total == Decimal("100")  # the residual the client plug fills


def test_breakdown_income_gated_on_earned_across_multiple_nonzero_sources(handler):
    # FAIL-ON-REVERT for the has_earned gate: TWO income sources that each net non-zero but whose
    # AGGREGATE is <= 0. income_sources is NON-EMPTY (both survive the != 0 filter), so a bare
    # `if income_sources:` emit would ship __income__ under an ABSENT __earned__ — a lone list with
    # no headline. Gating on __earned__ suppresses BOTH. (The single-source all-reversed test also
    # locks this gate; this case additionally proves a POSITIVE source present alongside a
    # net-negative one still can't force emission once the aggregate is <= 0.)
    cats = _FakeCategoryRepo([_category("salary", "Income"), _category("bonus", "Income")])
    txns = _QueuedTransactionRepo([
        _transaction("salary", 500, "posted"),
        _transaction("bonus", -600, "posted"),  # each source non-zero; aggregate nets -100
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "__earned__" not in result   # aggregate <= 0
    assert "__income__" not in result   # gated on __earned__, NOT on a non-empty source map


def test_breakdown_net_zero_income_source_dropped(handler):
    # A source whose net is EXACTLY $0 (a same-cycle reversal that cancels out) carries no
    # information -> dropped from __income__ (no phantom $0 row), while a real source survives.
    cats = _FakeCategoryRepo([
        _category("salary", "Income"),
        _category("bonus", "Income"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("salary", 2000, "posted"),
        _transaction("bonus", 200, "posted"),
        _transaction("bonus", -200, "posted"),  # nets exactly 0 -> dropped
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__income__"] == {"salary": {"posted": Decimal("2000"), "pending": Decimal("0")}}
    assert "bonus" not in result["__income__"]


# --- dispatch (through lambda_handler) ---------------------------------------


# --- adversarial gaps (qa) ---------------------------------------------------


def test_breakdown_ignores_non_budget_counting_spend(handler):
    # A transfer/excluded charge (counts_to_budget=False) must not appear as a
    # category row NOR fold into Uncategorized — whether its category is a real
    # spend id or a raw enum. Guards the counts_to_budget gate in BOTH summarisers.
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _QueuedTransactionRepo([
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
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _QueuedTransactionRepo([
        _transaction("MEDICAL", -20, "posted"),
        _transaction("MEDICAL", -50, "cancelled"),   # unknown status -> dropped
        _transaction("MEDICAL", -5, "pending"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__uncategorized__"] == {"posted": Decimal("20"), "pending": Decimal("5")}


# --- historical look-back (?cycle=, WHIT-68) --------------------------------
#
# today 2024-01-16, fortnightly, last pay 2024-01-03 → current cycle_start = 2024-01-03,
# so the prior cycle is [2023-12-20, 2024-01-02]. These pin that cycle=1 reads the prior
# window (not the current one) and that cycle=0/omitted is unchanged.


def _dated(cat, amount, d, status="posted"):
    return {**_transaction(cat, amount, status), "date": d}


def test_breakdown_cycle_1_reads_the_prior_window(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2024, 1, 16))
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -10, "2023-12-25"),  # prior window   -> IN for cycle=1
        _dated("coffee", -99, "2024-01-10"),  # current window -> OUT for cycle=1
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo(), cycle=1)

    assert result == {"coffee": {"posted": Decimal("10"), "pending": Decimal("0")}, "__rollup__": {"nodes": {}}}
    assert txns.calls[0][1] == "2023-12-20"  # queried start = prior window start
    assert txns.calls[0][2] == "2024-01-02"  # queried end   = day before current start


def test_breakdown_cycle_param_flows_through_dispatch(handler, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2024, 1, 16))
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -10, "2023-12-25"),  # prior window
        _dated("coffee", -99, "2024-01-10"),  # current window
    ])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = api_event("GET", "/breakdown", query={"cycle": "1"})
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    import json
    assert json.loads(resp["body"]) == {"coffee": {"posted": 10, "pending": 0}, "__rollup__": {"nodes": {}}}


@pytest.mark.parametrize("cycle, status", [
    ("-1", 400), ("abc", 400), ("1.5", 400), ("13", 400), ("999", 400),
    # BREAKDOWN_MAX_LOOKBACK (12) is the LAST allowed value: served, not rejected.
    ("12", 200),
])
def test_breakdown_cycle_param_is_bounded(handler, monkeypatch, cycle, status):
    # Non-int, negative, and above-cap all reject. Fail-loud, not a silent fallback to the
    # current cycle.
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _FakeCategoryRepo([_category("coffee", "Lifestyle")]))
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _DateFilteringTransactionRepo([]))
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    resp = handler.lambda_handler(api_event("GET", "/breakdown", query={"cycle": cycle}), None)

    assert resp["statusCode"] == status


def test_breakdown_cycle_2_reads_the_second_prior_window_end_to_end(handler, monkeypatch):
    # cycle=2 must read the 2nd-prior window ONLY — not the current, not cycle=1, not
    # cycle=3: the n-step is non-overlapping all the way through the endpoint.
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2024, 1, 16))
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -1, "2024-01-10"),   # current  -> OUT
        _dated("coffee", -2, "2024-01-01"),   # cycle=1  -> OUT
        _dated("coffee", -7, "2023-12-19"),   # cycle=2 (last day)  -> IN
        _dated("coffee", -3, "2023-12-06"),   # cycle=2 (first day) -> IN
        _dated("coffee", -9, "2023-12-05"),   # cycle=3 (day before) -> OUT
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo(), cycle=2)

    assert result == {"coffee": {"posted": Decimal("10"), "pending": Decimal("0")}, "__rollup__": {"nodes": {}}}
    assert txns.calls[0][1] == "2023-12-06"  # queried start = 2nd-prior window start
    assert txns.calls[0][2] == "2023-12-19"  # queried end   = 2nd-prior window end


def test_breakdown_prior_window_weekly_length_7_end_to_end(handler, monkeypatch):
    # length=7: last pay 2024-01-01, today 2024-01-16 -> cycle_start = 2024-01-15, so the
    # cycle=1 window is [2024-01-08, 2024-01-14].
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: date(2024, 1, 16))
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _DateFilteringTransactionRepo([
        _dated("coffee", -5, "2024-01-10"),   # prior week   -> IN
        _dated("coffee", -50, "2024-01-15"),  # current week -> OUT
        _dated("coffee", -7, "2024-01-07"),   # week before  -> OUT
    ])

    result = handler.list_category_breakdown(
        cats, txns, FakePayCycleRepo(length=7, last_pay_date="2024-01-01"), cycle=1)

    assert result == {"coffee": {"posted": Decimal("5"), "pending": Decimal("0")}, "__rollup__": {"nodes": {}}}
    assert txns.calls[0][1] == "2024-01-08"
    assert txns.calls[0][2] == "2024-01-14"


def test_breakdown_excluded_uncategorized_charge_does_not_inflate_the_uncategorized_bucket(handler):
    # WHIT-296: an excluded charge with a raw (un-mapped) category must NOT land in
    # __uncategorized__; a lone excluded charge yields no uncategorized row.
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _QueuedTransactionRepo([{**_transaction("MEDICAL", -20, "posted"), "budget_excluded": True}])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result == {"__rollup__": {"nodes": {}}}  # nothing counts -> no coffee row and no __uncategorized__


# --- adversarial gaps (qa) — earned bucket, WHIT-312 --------------------------


def test_breakdown_positive_amount_in_spend_category_is_not_earned(handler):
    # [A16] A positive-amount txn filed under a SPEND-bucket category (a refund, or a mis-filed
    # paycheck) must NOT count as earned — the income gate is by BUCKET, not by amount sign.
    # Guards against a "positive amount == income" shortcut leaking spend-cat credits into
    # the earned bar.
    cats = _FakeCategoryRepo([_category("coffee", "Lifestyle")])
    txns = _QueuedTransactionRepo([_transaction("coffee", 500, "posted")])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert "__earned__" not in result


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
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = _QueuedTransactionRepo([
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
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("petrol", -10, "posted"),
        _transaction("petrol", 20, "posted"),       # posted nets to -10
        _transaction("petrol", -50, "pending"),      # pending +50
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("0"), "pending": Decimal("50")}


def test_breakdown_rollup_omits_parent_whose_subtree_nets_to_zero(handler):
    # A parent whose whole subtree nets to $0 (refunds cancel spend) is omitted from
    # __rollup__.nodes — a $0 parent has no donut slice. Fail-on-revert of the >0 guard:
    # it would emit {0,0}.
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("petrol", -40, "posted"),
        _transaction("petrol", 40, "posted"),        # net 0
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["__rollup__"]["nodes"] == {}


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
        _FakeCategoryRepo(cats), _QueuedTransactionRepo(txns), FakePayCycleRepo())
    budgets = handler.list_budgets(
        _FakeBudgetRepo({"car": {"target": Decimal("300")}}),
        _QueuedTransactionRepo(txns), FakePayCycleRepo(), _FakeCategoryRepo(cats))

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
        _FakeCategoryRepo(cats), _QueuedTransactionRepo(txns), FakePayCycleRepo())
    budgets = handler.list_budgets(
        _FakeBudgetRepo({"shop": {"target": Decimal("300")}}),
        _QueuedTransactionRepo(txns), FakePayCycleRepo(), _FakeCategoryRepo(cats))

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
        _FakeCategoryRepo(cats), _QueuedTransactionRepo(txns), FakePayCycleRepo())
    nodes = result["__rollup__"]["nodes"]

    assert nodes["living_top"] == {"posted": Decimal("30"), "pending": Decimal("0")}      # grandchild kept
    assert nodes["lifestyle_mid"] == {"posted": Decimal("50"), "pending": Decimal("0")}   # its own node, own bucket only


def test_breakdown_rollup_parent_node_includes_parents_own_direct_spend(handler):
    # WHIT-349 — [A9] subtree_ids includes the ROOT, so a transaction tagged directly onto
    # the parent (the picker allows it) counts in the parent's node ALONGSIDE its children:
    # car = own 25 + petrol 60 = 85. The FLAT car key stays the parent's own floored direct
    # spend (25). Fail-on-revert: a root-excluding subtree gives 60, not 85.
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("car", -25, "posted"),      # tagged directly on the PARENT
        _transaction("petrol", -60, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["car"] == {"posted": Decimal("25"), "pending": Decimal("0")}            # flat = own direct spend
    assert result["petrol"] == {"posted": Decimal("60"), "pending": Decimal("0")}
    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("85"), "pending": Decimal("0")}


def test_get_breakdown_dispatches_and_serialises_rollup_as_nested_json_numbers(handler, monkeypatch):
    # WHIT-349 — [A14] end-to-end through lambda_handler -> _json_response -> json.dumps(default=float):
    # __rollup__ is one level DEEPER than __earned__ ({"nodes": {id: {posted, pending}}}),
    # so this proves the encoder recurses and the netted parent's Decimals (incl. cents)
    # reach the client as JSON numbers, not strings or dropped keys. Nets a refunded sub so
    # the serialised number is the netted 47.50, not a floored-leaf 60.00.
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("petrol", -60.00, "posted"),
        _transaction("tolls", -12.50, "posted"),   # petrol 60 + tolls 12.50 = 72.50 ...
        _transaction("tolls", 25.00, "posted"),      # ... minus a 25 refund -> net 47.50
    ])
    monkeypatch.setattr(handler, "CategoryRepository", lambda: cats)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: txns)
    monkeypatch.setattr(handler, "PayCycleRepository", FakePayCycleRepo)

    event = api_event("GET", "/breakdown")
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
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = _QueuedTransactionRepo([
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
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("travel", "Living", "car"),      # mid-parent, collapses (subtree nets < 0)
        _child("tolls", "Living", "travel"),
        _child("petrol", "Living", "car"),
    ])
    txns = _QueuedTransactionRepo([
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
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("car", -30, "posted"),
        _transaction("car", 50, "posted"),         # net -20 on the parent's own id
        _transaction("petrol", -60, "posted"),
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert rollup["nodes"]["car"] == {"posted": Decimal("40"), "pending": Decimal("0")}
    assert rollup["refunds"] == {"car": [{"id": "car", "amount": Decimal("-20")}]}


def test_breakdown_rollup_no_refund_line_for_a_still_shown_member(handler):
    # WHIT-349 (Bug B fix): a member with a settled refund AND a new pending charge floors to
    # {0, +x} -> it still shows as a flat row, so it must NOT also get a refund line (no double-
    # render). tolls: posted -50 (settled refund) + pending 30 (new charge) -> flat {0, 30}.
    # petrol 60 -> car node posted max(0,60-50)=10, pending 30 -> {10,30}. No refunds key for car.
    # Fail-on-revert (drop the _hidden guard): tolls (combined net -20) would emit a refund line
    # AND still render as the $30 row.
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", 50, "posted"),        # a settled refund on tolls
        _transaction("tolls", -30, "pending"),        # a new pending charge on tolls
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())

    assert result["tolls"] == {"posted": Decimal("0"), "pending": Decimal("30")}   # still a flat row
    assert result["__rollup__"]["nodes"]["car"] == {"posted": Decimal("10"), "pending": Decimal("30")}
    assert "refunds" not in result["__rollup__"]                                   # tolls not double-rendered


# === WHIT-366/376 income per-source GAP tests (folded from test_breakdown_income_gaps.py) —
# __income__ carries the SIGNED per-source net (clamp=False): a clawed-back source survives as a
# negative row and only an exact-$0-net source is dropped. Reuses the fakes/builders above. =====


# === WHIT-349 refund __rollup__ GAP tests (folded from test_breakdown_refund_gaps.py) — the
# independent posted/pending clamp gap, a grandchild refund under a net-positive mid-parent, a
# refunded sub-parent, and income/savings never leaking into refunds. Reuses the fakes above. ===


def test_rollup_grandchild_refund_attaches_to_positive_mid_parent_not_top(handler):
    # car > travel(own +50) > tolls(-30 refund); a sibling petrol(+60) directly under car.
    # travel's subtree nets +20 (positive) -> travel HAS a node and is NOT a refund under car.
    # The tolls refund attaches to travel (its direct parent), so travel reconciles as
    # "Directly in travel" 50 + refund -30 = 20 == travel node. car lists NO refund.
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("travel", "Living", "car"),
        _child("tolls", "Living", "travel"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("travel", -50, "posted"),   # travel's own direct spend
        _transaction("tolls", 30, "posted"),      # -30 refund two levels down
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert rollup["nodes"]["car"] == {"posted": Decimal("80"), "pending": Decimal("0")}   # 60+50-30
    assert rollup["nodes"]["travel"] == {"posted": Decimal("20"), "pending": Decimal("0")}
    # The refund lands on travel (the parent in nodes with the negative child), NOT on car.
    assert rollup["refunds"] == {"travel": [{"id": "tolls", "amount": Decimal("-30")}]}


def test_rollup_income_and_savings_never_in_nodes_or_refunds(handler):
    # A spend parent with a refunded child, PLUS an Income earn and a net-negative Savings
    # subtree and a raw uncategorized charge. The rollup must carry ONLY the spend parent:
    # income/savings are never spend_ids, so they can't inflate nodes NOR appear as refunds,
    # even when the savings subtree nets negative. __earned__/__uncategorized__ still ride along.
    cats = _FakeCategoryRepo([
        _category("car", "Living"),
        _child("petrol", "Living", "car"),
        _child("tolls", "Living", "car"),
        _category("salary", "Income"),
        _category("vault", "Savings"),
        _child("vault_sub", "Savings", "vault"),
    ])
    txns = _QueuedTransactionRepo([
        _transaction("petrol", -60, "posted"),
        _transaction("tolls", 30, "posted"),        # -30 spend refund
        _transaction("salary", 2000, "posted"),      # income (earned)
        _transaction("vault_sub", -100, "posted"),
        _transaction("vault_sub", 250, "posted"),    # savings subtree nets negative
        _transaction("MEDICAL", -20, "posted"),      # raw uncategorized
    ])

    result = handler.list_category_breakdown(cats, txns, FakePayCycleRepo())
    rollup = result["__rollup__"]

    assert set(rollup["nodes"].keys()) == {"car"}                 # no salary/vault node
    assert rollup["refunds"] == {"car": [{"id": "tolls", "amount": Decimal("-30")}]}
    assert "salary" not in rollup["refunds"] and "vault" not in rollup["refunds"]
    assert "vault_sub" not in rollup["refunds"]
    assert result["__earned__"]["posted"] == Decimal("2000")     # earned still emitted
    assert "__uncategorized__" in result                          # raw charge still bucketed
