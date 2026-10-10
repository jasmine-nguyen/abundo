"""Tests for lambda_api/chat_tools.py — Ask Abundo's data tools (card 609).

The headline checks are the two definition-of-done averages: "last 3 cycles" = the last 3
completed pay cycles ÷ 3, and "last 3 months" = the last 3 completed calendar months ÷ 3, zero
periods included, computed with the Budgets rules (refunds reduce spend, pending counts,
budget-excluded rows don't, a parent includes its subcategories, the current cycle is left out).

Fixture pay cycle: fortnightly, current cycle starts 2026-09-10, today 2026-09-20. Completed
cycles: [07-30, 08-12], [08-13, 08-26], [08-27, 09-09].
"""

import json
from decimal import Decimal

import pytest

TODAY = "2026-09-20"
CYCLE_START = "2026-09-10"

CATEGORIES = [
    {"id": "eatingout", "name": "Eating Out", "bucket": "Lifestyle", "parent": None, "colorSlot": 0},
    {"id": "eatingout-sushi", "name": "Sushi", "bucket": "Lifestyle", "parent": "eatingout", "colorSlot": 3},
    # A sub filed under a spend parent but in the Income bucket: must never inflate the parent.
    {"id": "eatingout-tips", "name": "Tips", "bucket": "Income", "parent": "eatingout", "colorSlot": 5},
    # A Living-bucket sub under a Lifestyle parent: still spend, but not the parent's same-bucket
    # subtree, so it must not count toward Eating Out either.
    {"id": "eatingout-groceries", "name": "Deli", "bucket": "Living", "parent": "eatingout", "colorSlot": 9},
    {"id": "groceries", "name": "Groceries", "bucket": "Living", "parent": None, "colorSlot": 11},
    {"id": "salary", "name": "Salary", "bucket": "Income", "parent": None, "colorSlot": 5},
]


def _txn(txn_id, category, amount, date_, status="posted", counts=True, excluded=False,
         merchant=None, description="CARD PURCHASE"):
    row = {
        "transaction_id": txn_id, "category": category, "amount": Decimal(str(amount)),
        "status": status, "counts_to_budget": counts, "date": date_,
        "merchant_name": merchant or txn_id.upper(), "description": description,
        "account_id": "up-spending", "account_name": "Spending",
        "pk": "ACCT#up-spending", "sk": f"TXN#{txn_id}",
    }
    if excluded:
        row["budget_excluded"] = True
    return row


EATING_OUT = [
    # Oldest completed cycle [07-30, 08-12]: posted 40 + 10 (sub) - 15 refund = 35, pending 25.
    _txn("e1", "eatingout", -40, "2026-08-01", merchant="Grill'd"),
    _txn("e2", "eatingout-sushi", -10, "2026-08-05", merchant="Sushi Hub"),
    _txn("e3", "eatingout", 15, "2026-08-06", merchant="Grill'd"),
    _txn("e4", "eatingout", -25, "2026-08-10", status="pending", merchant="Pho Bar"),
    # Middle cycle [08-13, 08-26]: only a budget-excluded row -> $0.
    _txn("e5", "eatingout", -100, "2026-08-20", excluded=True),
    # Last completed cycle [08-27, 09-09]: 33.34.
    _txn("e6", "eatingout", -33.34, "2026-09-01", merchant="Pho Bar"),
    # Current cycle — must be left out of "last 3 completed cycles".
    _txn("e7", "eatingout", -99, "2026-09-15"),
    # June (for the months check): 20.
    _txn("e8", "eatingout", -20, "2026-06-15"),
]
OTHER = [
    _txn("g1", "groceries", -50, "2026-09-02", merchant="Coles"),
    _txn("s1", "salary", 3000, "2026-09-03", merchant="ACME PAYROLL"),
    _txn("u1", None, -12, "2026-09-04", merchant="Mystery Shop"),
    _txn("t1", None, -500, "2026-09-04", counts=False),  # transfer, never counts
]


def _data(chat_tools, transactions=None, budgets=None, length=14, cycle_start=CYCLE_START, today=TODAY):
    floor = chat_tools.lookback_floor(cycle_start, length, today)
    return chat_tools.ChatData(
        categories=CATEGORIES, budgets=budgets or {}, cycle_start=cycle_start, length=length,
        today=today, floor=floor,
        transactions=list(EATING_OUT + OTHER) if transactions is None else transactions)


# --- the two definition-of-done averages -----------------------------------------------------


def test_three_cycle_average_matches_a_hand_calculation(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"category_ids": ["eatingout"], "pay_cycles": {"last_n": 3}},
        "metric": "avg"})

    # Hand calculation: (60 + 0 + 33.34) / 3 = 31.1133... -> 31.11. Refund reduces, pending
    # counts, the sub-category counts, the excluded row and the current cycle don't.
    assert [row["value"] for row in result["rows"]] == [60.0, 0.0, 33.34]
    assert result["avg"] == 31.11
    assert result["total"] == 93.34
    assert result["period"]["pay_cycles"] == [
        {"from": "2026-07-30", "to": "2026-08-12"},
        {"from": "2026-08-13", "to": "2026-08-26"},
        {"from": "2026-08-27", "to": "2026-09-09"},
    ]
    assert result["period"]["from"] == "2026-07-30" and result["period"]["to"] == "2026-09-09"


def test_three_month_average_uses_completed_calendar_months_with_zero_months(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"category_ids": ["eatingout"], "months": {"last_n": 3}},
        "metric": "avg"})

    # June 20, July 0, August 35 + 25 = 60 -> 80 / 3 = 26.67. September (current) is left out.
    assert [(row["from"], row["to"], row["value"]) for row in result["rows"]] == [
        ("2026-06-01", "2026-06-30", 20.0),
        ("2026-07-01", "2026-07-31", 0.0),
        ("2026-08-01", "2026-08-31", 60.0),
    ]
    assert result["avg"] == 26.67


def test_include_current_adds_the_partial_period(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"category_ids": ["eatingout"], "pay_cycles": {"last_n": 1, "include_current": True}},
        "metric": "sum", "group_by": "pay_cycle"})
    assert [(row["from"], row["value"]) for row in result["rows"]] == [
        ("2026-08-27", 33.34), ("2026-09-10", 99.0)]


def test_sum_over_a_range_floors_once_so_a_refund_nets(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"category_ids": ["eatingout"], "date_from": "2026-08-01", "date_to": "2026-08-12"},
        "metric": "sum"})
    assert result["rows"] == [{"value": 60.0}]


def test_default_period_is_the_current_cycle(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {"filters": {"category_ids": ["eatingout"]}, "metric": "sum"})
    assert result["rows"] == [{"value": 99.0}]
    assert result["period"] == {"kind": "current_cycle", "from": CYCLE_START, "to": TODAY}


# --- which rows count ------------------------------------------------------------------------


def test_spend_includes_unfiled_but_not_income_or_transfers(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"date_from": "2026-09-01", "date_to": "2026-09-09"}, "metric": "sum"})
    # eating out 33.34 + groceries 50 + unfiled 12. Salary and the transfer don't count.
    assert result["rows"] == [{"value": 95.34}]


def test_uncategorized_key_selects_only_unfiled_spend(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"category_ids": ["__uncategorized__"], "pay_cycles": {"last_n": 1}},
        "metric": "list"})
    assert [row["merchant"] for row in result["rows"]] == ["Mystery Shop"]
    assert result["rows"][0]["category_id"] == "__uncategorized__"


def test_income_direction_sums_income_categories_as_positive(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"direction": "income", "pay_cycles": {"last_n": 1}}, "metric": "sum"})
    assert result["rows"] == [{"value": 3000.0}]


def test_merchant_and_amount_filters(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"merchant_contains": "pho", "min_amount": 30, "months": {"last_n": 3, "include_current": True}},
        "metric": "list"})
    assert [row["amount"] for row in result["rows"]] == [33.34]


# --- grouping and metrics --------------------------------------------------------------------


def test_group_by_category_is_per_leaf_and_sorted_biggest_first(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"date_from": "2026-08-01", "date_to": "2026-09-09"}, "metric": "sum",
        "group_by": "category"})
    assert result["rows"] == [
        {"category_id": "eatingout", "name": "Eating Out", "value": 83.34},
        {"category_id": "groceries", "name": "Groceries", "value": 50.0},
        {"category_id": "__uncategorized__", "name": "Uncategorized", "value": 12.0},
        {"category_id": "eatingout-sushi", "name": "Sushi", "value": 10.0},
    ]


def test_group_by_merchant(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"category_ids": ["eatingout"], "pay_cycles": {"last_n": 3}}, "metric": "sum",
        "group_by": "merchant"})
    assert result["rows"][0] == {"merchant": "Pho Bar", "value": 58.34}
    assert {"merchant": "Grill'd", "value": 25.0} in result["rows"]


def test_count_min_and_max(chat_tools):
    data = _data(chat_tools)
    filters = {"category_ids": ["eatingout"], "pay_cycles": {"last_n": 3}}
    count = chat_tools.query_transactions(data, {"filters": filters, "metric": "count"})
    biggest = chat_tools.query_transactions(data, {"filters": filters, "metric": "max"})
    assert count["rows"] == [{"value": 5}]
    assert biggest["rows"][0]["value"] == 40.0
    assert biggest["rows"][0]["transaction"]["merchant"] == "Grill'd"


def test_list_is_newest_first_and_truncates(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"category_ids": ["eatingout"], "pay_cycles": {"last_n": 3}}, "metric": "list", "limit": 2})
    assert [row["date"] for row in result["rows"]] == ["2026-09-01", "2026-08-10"]
    assert result["truncated"] is True and result["count"] == 5


# --- lookback bounds -------------------------------------------------------------------------


def test_last_n_is_clamped_to_twelve(chat_tools):
    result = chat_tools.query_transactions(_data(chat_tools), {
        "filters": {"pay_cycles": {"last_n": 40}}, "metric": "sum", "group_by": "pay_cycle"})
    assert len(result["rows"]) == 12 and result["clamped"] is True


def test_dates_before_the_floor_are_clamped(chat_tools):
    data = _data(chat_tools)
    result = chat_tools.query_transactions(data, {
        "filters": {"date_from": "2020-01-01", "date_to": "2030-01-01"}, "metric": "sum"})
    assert result["clamped"] is True
    assert result["period"]["from"] == data.floor and result["period"]["to"] == TODAY


@pytest.mark.parametrize("length, cycle_start, today, floor", [
    # Weekly: 12 cycles is only 84 days, so the month floor (1 Sep last year) wins.
    (7, "2026-09-17", "2026-09-20", "2025-09-01"),
    (14, CYCLE_START, TODAY, "2025-09-01"),
    # Monthly, late in the cycle, early in the month: 12 cycles reach past the month floor.
    (30, "2026-08-05", "2026-09-02", "2025-08-10"),
])
def test_lookback_floor_is_the_earlier_of_twelve_cycles_and_twelve_months(chat_tools, length, cycle_start, today, floor):
    assert chat_tools.lookback_floor(cycle_start, length, today) == floor


# --- privacy ---------------------------------------------------------------------------------


def test_safe_row_is_an_allow_list_and_redacts_numbers(chat_tools):
    transaction = _txn("p1", "groceries", -42.5, "2026-09-05", merchant="Coles 1234",
                       description="Card xx4821 transfer 063-000 1234 5678")
    transaction.update({"raw": {"balance": "8765.43", "account_number": "12345678"},
                        "notes": "secret note", "tags": ["private"], "filed_by_rule": "r1"})
    row = chat_tools.safe_row(transaction, _data(chat_tools))

    assert set(row) == {"date", "amount", "merchant", "description", "category", "category_id", "status"}
    assert row["amount"] == 42.5
    text = json.dumps(row)
    for secret in ("4821", "063-000", "1234", "5678", "8765.43", "Spending", "secret note", "private"):
        assert secret not in text
    assert row["description"] == "Card xx••• transfer •••"


def test_safe_row_names_an_unfiled_charge_once(chat_tools):
    # WHIT-846: search matches both spellings, but the model sees one plain label.
    row = chat_tools.safe_row(_txn("u1", None, -9, "2026-09-05"), _data(chat_tools))
    assert row["category"] in ("Uncategorised", "Uncategorized")


# --- budgets, pay cycles, categories ---------------------------------------------------------


def test_get_budgets_current_reads_the_budgets_rows(chat_tools):
    budgets = {"eatingout": {"target": Decimal("200"), "posted": Decimal("90"), "pending": Decimal("9"),
                             "available": Decimal("220")}}
    result = chat_tools.get_budgets(_data(chat_tools, budgets=budgets), {})
    assert result["budgets"] == [{
        "category_id": "eatingout", "name": "Eating Out", "limit": 200.0, "spent": 99.0,
        "remaining": 121.0, "color_slot": 0, "earn_target": False}]


def test_get_budgets_past_cycle_folds_the_subtree(chat_tools):
    budgets = {"eatingout": {"target": Decimal("200"), "posted": Decimal("0"), "pending": Decimal("0"),
                             "available": Decimal("200")}}
    result = chat_tools.get_budgets(_data(chat_tools, budgets=budgets), {"pay_cycle": {"offset": 3}})
    assert result["period"] == {"from": "2026-07-30", "to": "2026-08-12"}
    assert result["budgets"][0]["spent"] == 60.0 and result["budgets"][0]["remaining"] == 140.0


def test_get_pay_cycles_ends_with_the_current_cycle(chat_tools):
    cycles = chat_tools.get_pay_cycles(_data(chat_tools), {"last_n": 2})
    assert cycles == [
        {"start": "2026-08-13", "end": "2026-08-26", "is_current": False},
        {"start": "2026-08-27", "end": "2026-09-09", "is_current": False},
        {"start": CYCLE_START, "end": TODAY, "is_current": True},
    ]


# --- QA (card 609): boundaries the happy path doesn't reach ----------------------------------


def test_group_by_merchant_redacts_digit_runs_in_the_merchant_name(chat_tools):
    # [A1] group_by merchant emits the merchant label as a KEY, outside safe_row — it must be
    # redacted too, or a card/account number in merchant_name reaches the model.
    rows = [_txn("m1", "groceries", -20, "2026-09-12", merchant="TFR 062-123 12345678"),
            _txn("m2", "groceries", -5, "2026-09-13", merchant="Card xx4821 Coles")]
    result = chat_tools.query_transactions(
        _data(chat_tools, transactions=rows), {"metric": "sum", "group_by": "merchant"})
    sent = json.dumps(result)
    for secret in ("062-123", "12345678", "4821"):
        assert secret not in sent, secret
    assert {row["merchant"] for row in result["rows"]} == {"TFR •••", "Card xx••• Coles"}


def test_a_pending_refund_does_not_offset_posted_spend(chat_tools):
    # [A2] Posted and pending are floored SEPARATELY (the fold_subtree rule), so a pending +$20
    # refund can't cancel $20 of posted spend: 50 + max(0, -20) = 50, not 30.
    rows = [_txn("p1", "groceries", -50, "2026-09-12"),
            _txn("p2", "groceries", 20, "2026-09-13", status="pending")]
    result = chat_tools.query_transactions(_data(chat_tools, transactions=rows), {"metric": "sum"})
    assert result["rows"] == [{"value": 50.0}]


def test_the_average_rounds_half_up_to_the_cent(chat_tools):
    # [A3] $0.05 over two months = 0.025 -> 0.03 half-up (banker's rounding would give 0.02),
    # so the card figure matches a hand calculation.
    rows = [_txn("r1", "groceries", -0.05, "2026-08-10")]
    result = chat_tools.query_transactions(
        _data(chat_tools, transactions=rows), {"metric": "avg", "filters": {"months": {"last_n": 2}}})
    assert result["avg"] == 0.03
    assert [row["value"] for row in result["rows"]] == [0.0, 0.05]


def test_month_windows_end_on_the_real_last_day_across_a_leap_february_and_new_year(chat_tools):
    # [A4] Calendar months are variable length: Dec 31, Jan 31, Feb 29 in a leap year.
    assert chat_tools.month_windows("2028-03-10", 3, include_current=False) == [
        ("2027-12-01", "2027-12-31"), ("2028-01-01", "2028-01-31"), ("2028-02-01", "2028-02-29")]


def test_get_budgets_past_cycle_counts_an_income_target_positive_and_skips_excluded_rows(chat_tools):
    # [A5] A past-cycle earn target sums income as +amount (a spend sign would floor it to $0),
    # and a budget-excluded row never counts.
    rows = [_txn("s1", "salary", 3000, "2026-09-03"),
            _txn("s2", "salary", 500, "2026-09-04", excluded=True)]
    budgets = {"salary": {"target": Decimal("2800"), "posted": Decimal(0), "pending": Decimal(0),
                          "available": Decimal("2800")}}
    result = chat_tools.get_budgets(
        _data(chat_tools, transactions=rows, budgets=budgets), {"pay_cycle": {"offset": 1}})
    [row] = result["budgets"]
    assert row["spent"] == 3000.0 and row["earn_target"] is True


def _eating_out(chat_tools, data, filters, metric="sum", **extra):
    return chat_tools.query_transactions(
        data, {"filters": {"category_ids": ["eatingout"], **filters}, "metric": metric, **extra})


def test_the_twelfth_completed_month_is_inside_the_floor(chat_tools):
    data = _data(chat_tools, transactions=[_txn("old", "eatingout", -40, "2025-09-01")])
    result = _eating_out(chat_tools, data, {"months": {"last_n": 12}}, metric="avg", group_by="none")
    assert result["period"]["months"][0] == {"from": "2025-09-01", "to": "2025-09-30"}
    assert result["rows"][0]["value"] == 40.0
    assert "clamped" not in result


def test_a_net_refund_period_counts_as_zero_not_negative(chat_tools):
    # Cycle [08-27, 09-09] nets to a $30 refund. It floors to 0; it must not drag the average
    # below the other cycle's 60 / 2 = 30.
    data = _data(chat_tools, transactions=[
        _txn("spend", "eatingout", -60, "2026-08-20"),
        _txn("refund", "eatingout", 30, "2026-09-01"),
    ])
    result = _eating_out(chat_tools, data, {"pay_cycles": {"last_n": 2}}, metric="avg")
    assert [row["value"] for row in result["rows"]] == [60.0, 0.0]
    assert result["avg"] == 30.0


def test_a_cross_bucket_sub_never_counts_toward_its_spend_parent(chat_tools):
    data = _data(chat_tools, transactions=[
        _txn("meal", "eatingout", -40, "2026-09-12"),
        _txn("sushi", "eatingout-sushi", -10, "2026-09-12"),
        _txn("tip", "eatingout-tips", -500, "2026-09-12"),
        _txn("deli", "eatingout-groceries", -70, "2026-09-12"),
    ])
    assert _eating_out(chat_tools, data, {})["rows"] == [{"value": 50.0}]


@pytest.mark.parametrize("requested", [0, -3])
def test_last_n_outside_one_to_twelve_is_clamped_and_flagged(chat_tools, requested):
    result = _eating_out(chat_tools, _data(chat_tools), {"pay_cycles": {"last_n": requested}}, group_by="pay_cycle")
    assert len(result["rows"]) == 1
    assert result["clamped"] is True


def test_a_range_wholly_before_the_floor_is_an_error(chat_tools):
    with pytest.raises(ValueError):
        _eating_out(chat_tools, _data(chat_tools), {"date_from": "2020-01-01", "date_to": "2020-02-01"})


@pytest.mark.parametrize("raw, redacted", [
    ("Card xx4821", "Card xx•••"),
    ("4111 1111 1111 1111", "•••"),
    ("Transfer 063 000 12345678", "Transfer •••"),
    ("7-Eleven 123", "7-Eleven 123"),  # 3-digit store numbers are kept
])
def test_redact_blanks_card_account_and_bsb_digit_runs(chat_tools, raw, redacted):
    assert chat_tools.redact(raw) == redacted
