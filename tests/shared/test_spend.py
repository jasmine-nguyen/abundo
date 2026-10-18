"""Unit tests for the pure money maths in shared/spend.py: bill-spread slices, the spend gate
(budget_excluded and counts_to_budget), cadence clamps, earned income, rollover history, the
category subtree fold, unified_available and the prior/completed cycle windows. No repos, no AWS.
"""

from datetime import date
from decimal import Decimal

import pytest

from _budget_endpoint_fakes import TODAY  # settle cutoff 2026-07-31
from _rollover_fakes import charge, cycle_record

OLDER_SEALED = ("2026-05-08", "2026-06-06")
SEALED = ("2026-06-07", "2026-07-06")
SETTLING = ("2026-07-07", "2026-08-05")
PAYDAY_6TH = "2026-01-06"


def _txn(amount, *, category="salary", status="posted", counts=True, budget_excluded=None):
    txn = {
        "transaction_id": f"t-{amount}-{category}",
        "amount": Decimal(str(amount)),
        "category": category,
        "status": status,
        "counts_to_budget": counts,
    }
    if budget_excluded is not None:
        txn["budget_excluded"] = budget_excluded
    return txn


def _cat(cat_id, parent=None):
    return {"id": cat_id, "bucket": "Living", "parent": parent}


def _entry(**extra):
    return {"target": Decimal(100), "carryover": Decimal(0), "carryover_from": SEALED[0], **extra}


def _seal(shared, entry, windows, charges):
    return shared.spend.seal_rollover(entry, windows, {"sink"}, charges, TODAY)


def _record(start, end, leftover):
    return cycle_record(start, end, Decimal(100) - Decimal(leftover), leftover)


# --- spread_adjustment: cushion, slices, then nothing ---------------------------


def test_anchor_cycle_gets_the_full_amount_as_a_cushion(shared):
    assert shared.spend.spread_adjustment(Decimal("1390.91"), 4, 0) == Decimal("1390.91")


@pytest.mark.parametrize("amount, cycles", [
    ("1390.91", 4),   # the Insurance bill that motivated the feature
    ("100.00", 3),    # not evenly divisible — the odd cent must land somewhere
    ("0.01", 3),      # one cent over three cycles: one slice carries it, two are zero
    ("250.00", 1),    # a single payback cycle
    ("999.99", 24),   # the max cycle count
])
def test_the_payback_slices_sum_back_to_exactly_the_amount(shared, amount, cycles):
    # FAIL-ON-REVERT for the cent-exact split: a naive amount/cycles rounding would drift
    # by a cent on the non-divisible cases and break net-zero.
    amount = Decimal(amount)
    slices = [shared.spend.spread_adjustment(amount, cycles, k) for k in range(1, cycles + 1)]
    assert all(s <= 0 for s in slices)
    assert sum(slices, Decimal(0)) == -amount
    # Net over the plan's whole life: cushion + slices == 0.
    assert shared.spend.spread_adjustment(amount, cycles, 0) + sum(slices, Decimal(0)) == 0


def test_the_odd_cents_go_on_the_earliest_slices(shared):
    # $100 over 3: 10000 cents = 3333 * 3 + 1 -> the first slice carries the extra cent.
    assert shared.spend.spread_adjustment(Decimal("100.00"), 3, 1) == Decimal("-33.34")
    assert shared.spend.spread_adjustment(Decimal("100.00"), 3, 2) == Decimal("-33.33")
    assert shared.spend.spread_adjustment(Decimal("100.00"), 3, 3) == Decimal("-33.33")
    # $1390.91 over 4: 139091 = 34772 * 4 + 3 -> three slices of 347.73, then 347.72.
    assert shared.spend.spread_adjustment(Decimal("1390.91"), 4, 1) == Decimal("-347.73")
    assert shared.spend.spread_adjustment(Decimal("1390.91"), 4, 4) == Decimal("-347.72")


def test_the_last_payback_cycle_is_index_n_and_the_plan_is_over_at_n_plus_one(shared):
    # FAIL-ON-REVERT for the off-by-one: index == cycles is still a payback cycle (the LAST
    # slice); index == cycles + 1 is past the plan and contributes nothing.
    amount = Decimal("1390.91")
    assert shared.spend.spread_adjustment(amount, 4, 4) == Decimal("-347.72")
    assert shared.spend.spread_adjustment(amount, 4, 5) == Decimal(0)
    assert shared.spend.spread_adjustment(amount, 4, 500) == Decimal(0)   # long finished
    assert shared.spend.spread_adjustment(amount, 4, -1) == Decimal(0)    # corrupt future anchor


# --- spread_index: an UNCAPPED elapsed-cycle count ------------------------------


@pytest.mark.parametrize("length, last_pay_date, spread_from, current_start, expected", [
    (14, "2026-07-23", "2026-08-06", "2026-08-06", 0),   # still the anchor cycle
    (14, "2026-07-23", "2026-07-23", "2026-08-06", 1),   # the next cycle
    (14, "2026-07-23", "2026-06-25", "2026-08-06", 3),
    (30, "2026-01-31", "2026-01-31", "2026-01-31", 0),   # monthly from the 31st, across Feb (ABU-44)
    (30, "2026-01-31", "2026-01-31", "2026-02-28", 1),
    (30, "2026-01-31", "2026-01-31", "2026-03-31", 2),
])
def test_spread_index_counts_whole_cycles_since_the_anchor(shared, length, last_pay_date, spread_from,
                                                           current_start, expected):
    assert shared.spend.spread_index(spread_from, current_start, length, last_pay_date) == expected


def test_spread_index_is_not_capped_by_a_lookback_limit(shared):
    # FAIL-ON-REVERT for the saturation bug: deriving the position from the CAPPED
    # `completed_cycle_windows` (max 12 or 24) would pin a long-gap read at the cap, so a
    # plan whose `cycles` equals the cap could never be seen to end. The direct count keeps
    # climbing: Jan 2024 to Aug 2026 on a monthly cycle is 31 cycles, past any cap.
    index = shared.spend.spread_index("2024-01-06", "2026-08-06", 30, "2024-01-06")
    assert index == 31
    assert index > 24
    assert index != len(shared.spend.completed_cycle_windows("2024-01-06", "2026-08-06", 30, 24, "2024-01-06"))


def test_excluded_charge_removed_from_a_mixed_set(shared):
    # Coffee charges, one excluded: only the counting ones (flag False or absent) land in the bar.
    totals = shared.spend.summarise_transactions(
        [
            _txn(-40, category="coffee", budget_excluded=True),
            _txn(-15, category="coffee"),
            _txn(-5, category="coffee", budget_excluded=False),
        ],
        {"coffee"},
    )
    assert totals["coffee"]["posted"] == Decimal("20")


@pytest.mark.parametrize("gap, length, expected", [
    (14, 14, 1),                 # weekly-on-fortnightly beat -> one cycle
    (30, 14, 2),                 # monthly bill on a fortnightly pay cycle -> ~2 cycles
    (91, 30, 3),                 # quarterly on monthly -> 3
    (30, 30, 1),                 # monthly bill, monthly pay cycle -> 1
    (7, 14, 1),                  # sub-cycle cadence rounds down to the floor, never 0
    (365, 14, 24),               # a yearly bill clamps to SPREAD_MAX_CYCLES (24), not 26
    (Decimal("30"), 14, 2),      # a Decimal gap off a stored rule row divides fine
    (336, 14, 24),               # exactly at the max is kept, not clamped down
    (350, 14, 24),               # one beat over the max clamps to the max
    (Decimal("45"), 14, 3),      # a non-whole Decimal quotient rounds numerically
])
def test_cadence_cycles_maps_and_clamps(shared, gap, length, expected):
    assert shared.spend.cadence_cycles(gap, length) == expected


@pytest.mark.parametrize("gap, length", [(0, 14), (-5, 14), (30, 0), (30, -1)])
def test_non_positive_inputs_fall_back_to_the_minimum(shared, gap, length):
    # A malformed cadence/length spreads over one cycle rather than crashing or returning nonsense.
    assert shared.spend.cadence_cycles(gap, length) == 1


def test_earned_sums_positive_income_posted_and_pending(shared):
    totals = shared.spend.summarise_earned(
        [_txn(2500, status="posted"), _txn(300, status="pending")],
        {"salary"},
    )
    assert totals == {"posted": Decimal("2500"), "pending": Decimal("300")}


def test_earned_ignores_non_income_categories(shared):
    # A spend category id is not in the income set, so it never contributes.
    totals = shared.spend.summarise_earned(
        [_txn(-40, category="coffee"), _txn(2500, category="salary")],
        {"salary"},
    )
    assert totals == {"posted": Decimal("2500"), "pending": Decimal("0")}


def test_earned_net_reversal_clamps_to_zero(shared):
    # A clawback bigger than the earnings can't drive earned negative.
    totals = shared.spend.summarise_earned(
        [_txn(100, status="posted"), _txn(-250, status="posted")],
        {"salary"},
    )
    assert totals == {"posted": Decimal("0"), "pending": Decimal("0")}


def test_earned_honours_budget_excluded_and_counts(shared):
    totals = shared.spend.summarise_earned(
        [
            _txn(1000),
            _txn(500, budget_excluded=True),
            _txn(400, counts=False),
        ],
        {"salary"},
    )
    assert totals == {"posted": Decimal("1000"), "pending": Decimal("0")}


def test_earned_reversal_in_one_category_reduces_the_shared_aggregate(shared):
    # summarise_earned is a SINGLE aggregate across every income id: a clawback in one
    # category eats into another category's earnings in the same bucket. 3000 - 200 = 2800.
    totals = shared.spend.summarise_earned(
        [_txn(3000, category="salary"), _txn(-200, category="dividends")],
        {"salary", "dividends"},
    )
    assert totals == {"posted": Decimal("2800"), "pending": Decimal("0")}


def test_a_sealed_cycle_counts_posted_and_pending_and_is_saved_with_the_carryover(shared):
    charges = [charge("sink", "2026-06-10", "-30"), charge("sink", "2026-06-11", "-90", status="pending")]

    carryover, cycles, earlier, persist = _seal(shared, _entry(), [SEALED], charges)

    assert carryover == Decimal(-20)
    assert cycles == [{**cycle_record(*SEALED, 120, -20), "settling": False}]
    assert earlier == Decimal(0)
    assert persist == {"carryover": Decimal(-20), "carryover_from": "2026-07-07",
                       "carryover_history": [cycle_record(*SEALED, 120, -20)]}


def test_new_seals_go_in_front_of_the_stored_history_and_the_legacy_amount_stays_earlier(shared):
    old = cycle_record("2026-05-08", "2026-06-06", 150, -50)
    entry = _entry(carryover=Decimal(-10), carryover_history=[old])  # −50 sealed + 40 from before history

    carryover, cycles, earlier, persist = _seal(shared, entry, [SEALED, SETTLING], [charge("sink", "2026-07-20", "-30")])

    assert [c["start"] for c in cycles] == ["2026-07-07", "2026-06-07", "2026-05-08"]
    assert [c["settling"] for c in cycles] == [True, False, False]
    assert earlier == Decimal(40)
    assert sum(c["leftover"] for c in cycles) + earlier == carryover == Decimal(160)
    assert persist["carryover_history"] == [cycle_record(*SEALED, 0, 100), old]


def test_only_settling_cycles_leave_the_history_unsaved(shared):
    old = cycle_record("2026-06-07", "2026-07-06", 0, 100)
    entry = _entry(carryover=Decimal(100), carryover_from="2026-07-07", carryover_history=[old])

    carryover, cycles, earlier, persist = _seal(shared, entry, [SETTLING], [])

    assert carryover == Decimal(200)
    assert cycles == [{**cycle_record(*SETTLING, 0, 100), "settling": True}, {**old, "settling": False}]
    assert earlier == Decimal(0)
    assert persist is None


def test_the_history_keeps_only_the_newest_cycles_and_the_overflow_moves_to_earlier(shared, monkeypatch):
    monkeypatch.setattr(shared.spend, "ROLLOVER_HISTORY_MAX_CYCLES", 2)
    older = [cycle_record("2026-05-08", "2026-06-06", 150, -50), cycle_record("2026-04-08", "2026-05-07", 70, 30)]
    entry = _entry(carryover=Decimal(-20), carryover_history=older)

    carryover, cycles, earlier, persist = _seal(shared, entry, [SEALED], [])

    assert [c["start"] for c in cycles] == ["2026-06-07", "2026-05-08"]
    assert earlier == Decimal(30)
    assert sum(c["leftover"] for c in cycles) + earlier == carryover == Decimal(80)
    assert len(persist["carryover_history"]) == 2


# [A1] (P0) cycles + earlier == displayed carryover for every mix of stored history,
# legacy amount, sealed and settling windows.
CHARGES = [charge("sink", "2026-05-10", "-180"), charge("sink", "2026-06-20", "-12.34", "pending"), charge("sink", "2026-07-08", "-99.99")]
OLD = [_record("2026-04-08", "2026-05-07", "-7.5"), _record("2026-03-09", "2026-04-07", "33")]


@pytest.mark.parametrize("stored, history, windows", [
    ("0", [], []),
    ("-859", [], []),
    ("-859", [], [OLDER_SEALED, SEALED, SETTLING]),
    ("25.5", OLD, [OLDER_SEALED]),
    ("25.5", OLD, [SETTLING]),
    ("-0.01", OLD, [OLDER_SEALED, SEALED, SETTLING]),
])
def test_the_listed_cycles_plus_earlier_add_up_to_the_carryover(shared, stored, history, windows):
    entry = {"target": Decimal(100), "carryover": Decimal(stored), "carryover_from": OLDER_SEALED[0],
             "carryover_history": history}

    carryover, cycles, earlier, persist = shared.spend.seal_rollover(entry, windows, {"sink"}, CHARGES, TODAY)

    assert sum((c["leftover"] for c in cycles), Decimal(0)) + earlier == carryover
    assert [c["start"] for c in cycles] == sorted((c["start"] for c in cycles), reverse=True)
    if persist is not None and "carryover_history" in persist:
        saved = persist["carryover_history"]
        assert sum((r["leftover"] for r in saved), Decimal(0)) + earlier == persist["carryover"]
        assert all("settling" not in r for r in saved)


def test_subtree_ids_of_orphan_absent_from_taxonomy_is_itself(shared):
    # An orphan budget target (id not in the taxonomy) is its own single node, so it
    # still sums as its own spend — the existing orphan behaviour.
    children = shared.spend.build_category_children([_cat("coffee")])

    assert shared.spend.subtree_ids("ghost", children) == {"ghost"}


def test_subtree_ids_three_level_includes_every_node(shared):
    # car -> daily -> {petrol, tolls}; car -> parking(leaf). The parent rolls up EVERY
    # node — itself, the intermediate `daily`, and the leaves — so a txn tagged directly
    # onto the mid-level `daily` is counted (the depth >= 3 case the leaf-only walk dropped).
    cats = [
        _cat("car"), _cat("daily", "car"), _cat("parking", "car"),
        _cat("petrol", "daily"), _cat("tolls", "daily"),
    ]
    children = shared.spend.build_category_children(cats)

    assert shared.spend.subtree_ids("car", children) == {"car", "daily", "parking", "petrol", "tolls"}
    assert shared.spend.subtree_ids("daily", children) == {"daily", "petrol", "tolls"}


def test_subtree_ids_corrupt_cycle_terminates(shared):
    # A corrupt stored cycle a<->b must not hang; the visited set stops the walk and
    # returns the nodes on the cycle once each (each summed once downstream).
    cats = [_cat("a", "b"), _cat("b", "a")]
    children = shared.spend.build_category_children(cats)

    assert shared.spend.subtree_ids("a", children) == {"a", "b"}


def test_subtree_ids_bucket_filter_keeps_same_bucket_drops_cross_bucket(shared):
    # WHIT-229: with bucket_by_id, a cross-bucket child is excluded, but a same-bucket
    # descendant UNDER it is still kept (filter on membership, not descent). Car(Living) ->
    # parking(Living); Car -> odd(Lifestyle) -> fuel(Living). Car's set is the Living ids.
    cats = [
        {"id": "car", "bucket": "Living", "parent": None},
        {"id": "parking", "bucket": "Living", "parent": "car"},
        {"id": "odd", "bucket": "Lifestyle", "parent": "car"},
        {"id": "fuel", "bucket": "Living", "parent": "odd"},
    ]
    children = shared.spend.build_category_children(cats)
    bucket_by_id = {c["id"]: c["bucket"] for c in cats}

    assert shared.spend.subtree_ids("car", children, bucket_by_id) == {"car", "parking", "fuel"}
    # The 2-arg form (no bucket map) is unchanged: the whole subtree, no filter.
    assert shared.spend.subtree_ids("car", children) == {"car", "parking", "odd", "fuel"}


def test_fold_subtree_id_absent_from_per_id_contributes_zero(shared):
    # An id in the subtree but with no spend this cycle (absent from per_id) contributes
    # 0 — no KeyError — matching the callers' `if cid in per_id` / truthiness skip.
    per_id = {"a": {"posted": Decimal("5"), "pending": Decimal("2")}}
    folded = shared.spend.fold_subtree(per_id, {"a", "ghost"})
    assert folded == {"posted": Decimal("5"), "pending": Decimal("2")}


def test_fold_subtree_posted_floors_independently_of_pending(shared):
    # posted and pending clamp SEPARATELY — a negative posted must not drag a positive
    # pending to 0. [fail-on-revert] against any "clamp the combined sum" mistake.
    per_id = {"a": {"posted": Decimal("-30"), "pending": Decimal("25")}}
    folded = shared.spend.fold_subtree(per_id, {"a"})
    assert folded == {"posted": Decimal(0), "pending": Decimal("25")}


def test_fold_subtree_nets_siblings_before_the_floor(shared):
    # The WHIT-343 headline: a net-negative sibling nets against a positive sibling
    # BEFORE the floor (aggregate-then-clamp). Per-id clamp would drop the refund and
    # give 100; netting-then-floor gives 40.
    per_id = {"a": {"posted": Decimal("100"), "pending": Decimal(0)},
              "b": {"posted": Decimal("-60"), "pending": Decimal(0)}}
    folded = shared.spend.fold_subtree(per_id, {"a", "b"})
    assert folded["posted"] == Decimal("40")


def test_unified_available_does_not_clamp_a_negative_result(shared):
    # A payback slice bigger than budget+buffer must show a real negative spendable, not
    # a clamped 0. Also catches a `budget + buffer - payback` sign flip (that would give +130
    # here). The pure primitive must not hide an overdrawn category.
    assert shared.spend.unified_available(Decimal("100"), Decimal("-50"), Decimal("-80")) == Decimal("-30")
    # a positive buffer can lift a big payback back above zero.
    assert shared.spend.unified_available(Decimal("100"), Decimal("200"), Decimal("-80")) == Decimal("220")


def test_first_prior_cycle_is_the_length_day_span_ending_the_day_before(shared):
    # Current cycle starts 2024-01-31, fortnightly → prior cycle is [2024-01-17,
    # 2024-01-30]: a full 14 inclusive days that ends the day before the current start.
    start, end = shared.spend.nth_prior_cycle_window("2024-01-31", 14, 1, "2024-01-03")
    assert (start, end) == ("2024-01-17", "2024-01-30")
    assert (date.fromisoformat(end) - date.fromisoformat(start)).days == 13  # 14 inclusive days


def test_nth_prior_steps_back_n_full_cycles_with_no_gap(shared):
    p1_start, _p1_end = shared.spend.nth_prior_cycle_window("2024-01-31", 14, 1, "2024-01-03")
    p2_start, p2_end = shared.spend.nth_prior_cycle_window("2024-01-31", 14, 2, "2024-01-03")
    assert (p2_start, p2_end) == ("2024-01-03", "2024-01-16")
    # The 2nd prior window ends exactly the day before the 1st prior window starts.
    assert (date.fromisoformat(p1_start) - date.fromisoformat(p2_end)).days == 1


def test_completed_cycle_windows_are_the_full_cycles_between_anchor_and_now(shared):
    # Anchor 3 months before the current cycle_start, monthly on the 6th → exactly 3 completed
    # cycles, oldest-first, each a calendar month abutting the next with no gap.
    windows = shared.spend.completed_cycle_windows("2026-05-06", "2026-08-06", 30, 12, PAYDAY_6TH)
    assert windows == [
        ("2026-05-06", "2026-06-05"),
        ("2026-06-06", "2026-07-05"),
        ("2026-07-06", "2026-08-05"),
    ]
    # Each window's end is the day before the next window's start (no overlap, no gap).
    for (s1, e1), (s2, _e2) in zip(windows, windows[1:]):
        assert (date.fromisoformat(s2) - date.fromisoformat(e1)).days == 1
    # The last completed window ends the day before the current cycle_start.
    assert (date.fromisoformat("2026-08-06") - date.fromisoformat(windows[-1][1])).days == 1


def test_completed_cycle_windows_empty_when_no_full_cycle_elapsed(shared):
    # current_start == anchor (still in the first cycle) → nothing to fold.
    assert shared.spend.completed_cycle_windows("2026-08-06", "2026-08-06", 30, 12, PAYDAY_6TH) == []
    # A current_start BEFORE the anchor (defensive) also yields nothing, never an inverted window.
    assert shared.spend.completed_cycle_windows("2026-08-06", "2026-07-06", 30, 12, PAYDAY_6TH) == []


def test_completed_cycle_windows_caps_to_the_most_recent_max_cycles(shared):
    # 6 full cycles have elapsed but the cap is 2 → only the 2 most-recent are returned
    # (the older leftovers are dropped; the caller advances its anchor past them).
    windows = shared.spend.completed_cycle_windows("2026-02-06", "2026-08-06", 30, 2, PAYDAY_6TH)
    assert windows == [
        ("2026-06-06", "2026-07-05"),
        ("2026-07-06", "2026-08-05"),
    ]


def test_transactions_in_window_filters_inclusive_by_date(shared):
    txns = [
        {"date": "2026-06-06", "id": "before-end"},   # on the end boundary -> kept
        {"date": "2026-06-07", "id": "after-end"},    # past the end -> dropped
        {"date": "2026-05-08", "id": "on-start"},     # on the start boundary -> kept
        {"date": "2026-05-07", "id": "before-start"}, # before the start -> dropped
        {"id": "no-date"},                            # no date -> can't place -> dropped
    ]
    kept = shared.spend.transactions_in_window(txns, "2026-05-08", "2026-06-06")
    assert [t["id"] for t in kept] == ["before-end", "on-start"]


# [A9] (P0) counts_to_budget, now in shared/spend.py: home loan never counts, a transfer /
# loan-payment category never counts, anything else (including no category) does.
@pytest.mark.parametrize(
    "account_id, category, expected",
    [
        ("up-homeloan", "groceries", False),
        ("anz-spending", "TRANSFER_IN", False),
        ("anz-spending", "TRANSFER_OUT", False),
        ("anz-spending", "LOAN_PAYMENTS", False),
        ("anz-spending", "groceries", True),
        ("anz-spending", None, True),
        ("anz-spending", "income", True),
    ],
)
def test_counts_to_budget_in_shared_spend(shared, account_id, category, expected):
    assert shared.spend.counts_to_budget(account_id, category) is expected


# --- monthly pay cycle steps by calendar month (ABU-44) --------------------------


@pytest.mark.parametrize("today, expected_start", [
    (date(2026, 2, 15), "2026-02-15"),
    (date(2026, 3, 20), "2026-03-15"),
    (date(2026, 6, 15), "2026-06-15"),
    (date(2026, 10, 15), "2026-10-15"),
    (date(2026, 10, 14), "2026-09-15"),
])
def test_a_monthly_cycle_from_the_15th_starts_on_the_15th_every_month(shared, today, expected_start):
    assert shared.spend.current_cycle_window("2026-01-15", 30, today) == (expected_start, today.isoformat())


@pytest.mark.parametrize("today, expected_start", [
    (date(2026, 2, 28), "2026-02-28"),
    (date(2026, 3, 31), "2026-03-31"),
    (date(2026, 4, 30), "2026-04-30"),
    (date(2026, 5, 31), "2026-05-31"),
])
def test_a_monthly_cycle_from_the_31st_uses_the_months_last_day(shared, today, expected_start):
    assert shared.spend.current_cycle_window("2026-01-31", 30, today) == (expected_start, today.isoformat())


@pytest.mark.parametrize("cycle_start, last_pay_date, n, expected", [
    ("2026-03-31", "2026-01-31", 1, ("2026-02-28", "2026-03-30")),
    ("2026-04-30", "2026-01-31", 1, ("2026-03-31", "2026-04-29")),
    ("2026-03-31", "2026-01-31", 2, ("2026-01-31", "2026-02-27")),
    ("2028-03-31", "2028-01-31", 1, ("2028-02-29", "2028-03-30")),   # leap year
    ("2027-01-15", "2026-01-15", 1, ("2026-12-15", "2027-01-14")),   # year end
])
def test_a_monthly_prior_cycle_is_a_calendar_month(shared, cycle_start, last_pay_date, n, expected):
    assert shared.spend.nth_prior_cycle_window(cycle_start, 30, n, last_pay_date) == expected


def test_monthly_completed_cycles_from_the_31st_follow_each_months_last_day(shared):
    assert shared.spend.completed_cycle_windows("2026-01-31", "2026-05-31", 30, 12, "2026-01-31") == [
        ("2026-01-31", "2026-02-27"),
        ("2026-02-28", "2026-03-30"),
        ("2026-03-31", "2026-04-29"),
        ("2026-04-30", "2026-05-30"),
    ]


@pytest.mark.parametrize("day, length, last_pay_date, current_start, expected", [
    ("2026-07-12", 30, "2026-01-15", "2026-10-15", "2026-07-15"),   # 3 days early -> forward
    ("2026-07-18", 30, "2026-01-15", "2026-10-15", "2026-07-15"),   # 3 days late -> back
    ("2026-06-30", 30, "2026-01-15", "2026-10-15", "2026-06-15"),   # 15 days either way -> earlier
    ("2026-07-15", 30, "2026-01-15", "2026-10-15", "2026-07-15"),   # on the grid -> unchanged
    ("2026-11-12", 30, "2026-01-15", "2026-10-15", "2026-10-15"),   # held to the current start
    ("2026-08-06", 14, "2026-07-23", "2026-08-06", "2026-08-06"),   # fortnightly on-grid -> unchanged
])
def test_snap_to_pay_cycle_moves_to_the_nearest_payday(shared, day, length, last_pay_date, current_start, expected):
    assert shared.spend.snap_to_pay_cycle(day, length, last_pay_date, current_start) == expected


@pytest.mark.parametrize("stored_paydate, last_pay_date, expected", [
    ("2026-01-15", "2026-03-15", True),    # same day of the month
    ("2026-01-31", "2026-04-30", False),   # the 31st and the 30th are different schedules
])
def test_a_monthly_plan_is_on_the_same_schedule_when_the_day_of_month_matches(shared, stored_paydate,
                                                                            last_pay_date, expected):
    assert shared.spend.same_pay_cycle(30, stored_paydate, 30, last_pay_date) is expected
