"""QA edge cases for Ask Abundo (card 609) — the boundaries and failure paths the happy-path
tests in test_chat_tools.py / test_ai_chat.py / test_ai_chat_routes.py don't reach.

Every assertion is against the real exported production function; nothing here re-implements
the maths.
"""

import json
from decimal import Decimal

import pytest

CATEGORIES = [
    {"id": "eatingout", "name": "Eating Out", "bucket": "Lifestyle", "parent": None, "colorSlot": 0},
    {"id": "eatingout-sushi", "name": "Sushi", "bucket": "Lifestyle", "parent": "eatingout", "colorSlot": 3},
    # A sub filed under a spend parent but in the Income bucket: must never inflate the parent.
    {"id": "eatingout-tips", "name": "Tips", "bucket": "Income", "parent": "eatingout", "colorSlot": 5},
    # A Living-bucket sub under a Lifestyle parent: still spend, but not the parent's same-bucket
    # subtree, so it must not count toward Eating Out either.
    {"id": "eatingout-groceries", "name": "Deli", "bucket": "Living", "parent": "eatingout", "colorSlot": 9},
    {"id": "salary", "name": "Salary", "bucket": "Income", "parent": None, "colorSlot": 7},
]


def _txn(txn_id, category, amount, date_, status="posted", merchant=None, description="CARD PURCHASE"):
    return {
        "transaction_id": txn_id, "category": category, "amount": Decimal(str(amount)),
        "status": status, "counts_to_budget": True, "date": date_,
        "merchant_name": merchant or txn_id.upper(), "description": description,
    }


def _data(chat_tools, transactions=(), cycle_start="2026-09-10", length=14, today="2026-09-20"):
    return chat_tools.ChatData(
        categories=CATEGORIES, budgets={}, cycle_start=cycle_start, length=length, today=today,
        floor=chat_tools.lookback_floor(cycle_start, length, today), transactions=list(transactions))


def _eating_out(chat_tools, data, filters, metric="sum", **extra):
    return chat_tools.query_transactions(
        data, {"filters": {"category_ids": ["eatingout"], **filters}, "metric": metric, **extra})


# --- period windows --------------------------------------------------------------------------


def test_month_windows_cross_the_year_boundary(chat_tools):  # [A1]
    assert chat_tools.month_windows("2026-01-15", 3, include_current=False) == [
        ("2025-10-01", "2025-10-31"), ("2025-11-01", "2025-11-30"), ("2025-12-01", "2025-12-31")]


def test_month_windows_end_on_a_leap_day(chat_tools):  # [A1]
    assert chat_tools.month_windows("2028-03-10", 1, include_current=True) == [
        ("2028-02-01", "2028-02-29"), ("2028-03-01", "2028-03-10")]


def test_weekly_cycle_floor_reaches_back_twelve_calendar_months(chat_tools):  # [A2]
    # 12 weekly cycles is only 84 days; the floor must still cover "last 12 months".
    assert chat_tools.lookback_floor("2026-09-17", 7, "2026-09-20") == "2025-09-01"


def test_the_twelfth_completed_month_is_inside_the_floor(chat_tools):  # [A2]
    data = _data(chat_tools, [_txn("old", "eatingout", -40, "2025-09-01")])
    result = _eating_out(chat_tools, data, {"months": {"last_n": 12}}, metric="avg", group_by="none")
    assert result["period"]["months"][0] == {"from": "2025-09-01", "to": "2025-09-30"}
    assert result["rows"][0]["value"] == 40.0
    assert "clamped" not in result


# --- rounding and flooring -------------------------------------------------------------------


def test_average_rounds_half_up_at_the_half_cent(chat_tools):  # [A3]
    # $0.05 over 2 months = 0.025 -> 0.03 half-up (banker's rounding would give 0.02).
    data = _data(chat_tools, [_txn("a", "eatingout", -0.05, "2026-08-10")])
    result = _eating_out(chat_tools, data, {"months": {"last_n": 2}}, metric="avg")
    assert result["avg"] == 0.03


def test_a_net_refund_period_counts_as_zero_not_negative(chat_tools):  # [A7]
    # Cycle [08-27, 09-09] nets to a $30 refund. It floors to 0; it must not drag the average
    # below the other cycle's 60 / 2 = 30.
    data = _data(chat_tools, [
        _txn("spend", "eatingout", -60, "2026-08-20"),
        _txn("refund", "eatingout", 30, "2026-09-01"),
    ])
    result = _eating_out(chat_tools, data, {"pay_cycles": {"last_n": 2}}, metric="avg")
    assert [row["value"] for row in result["rows"]] == [60.0, 0.0]
    assert result["avg"] == 30.0


def test_a_pending_refund_does_not_cancel_posted_spend(chat_tools):  # [A8]
    # Posted and pending floor SEPARATELY (the Budgets bar rule): 50 posted + max(0, -20) = 50,
    # not 50 - 20 = 30.
    data = _data(chat_tools, [
        _txn("p", "eatingout", -50, "2026-09-12"),
        _txn("r", "eatingout", 20, "2026-09-13", status="pending"),
    ])
    assert _eating_out(chat_tools, data, {})["rows"] == [{"value": 50.0}]


# --- which rows count ------------------------------------------------------------------------


def test_a_cross_bucket_sub_never_counts_toward_its_spend_parent(chat_tools):  # [A9]
    data = _data(chat_tools, [
        _txn("meal", "eatingout", -40, "2026-09-12"),
        _txn("sushi", "eatingout-sushi", -10, "2026-09-12"),
        _txn("tip", "eatingout-tips", -500, "2026-09-12"),
        _txn("deli", "eatingout-groceries", -70, "2026-09-12"),
    ])
    assert _eating_out(chat_tools, data, {})["rows"] == [{"value": 50.0}]


def test_income_direction_ignores_spend_and_unfiled_rows(chat_tools):  # [A9]
    data = _data(chat_tools, [
        _txn("pay", "salary", 3000, "2026-09-12"),
        _txn("meal", "eatingout", 40, "2026-09-12"),
        _txn("mystery", None, 99, "2026-09-12"),
    ])
    result = chat_tools.query_transactions(data, {"filters": {"direction": "income"}, "metric": "sum"})
    assert result["rows"] == [{"value": 3000.0}]


# --- clamping --------------------------------------------------------------------------------


@pytest.mark.parametrize("kind, requested, used", [
    ("pay_cycles", 0, 1), ("pay_cycles", -3, 1), ("months", 13, 12), ("months", 100, 12)])
def test_last_n_outside_one_to_twelve_is_clamped_and_flagged(chat_tools, kind, requested, used):  # [A4]
    group_by = {"pay_cycles": "pay_cycle", "months": "month"}[kind]
    result = _eating_out(chat_tools, _data(chat_tools), {kind: {"last_n": requested}}, group_by=group_by)
    assert len(result["rows"]) == used
    assert result["clamped"] is True


def test_a_range_ending_after_today_is_clamped_to_today(chat_tools):  # [A5]
    result = _eating_out(chat_tools, _data(chat_tools), {"date_from": "2026-09-01", "date_to": "2026-12-31"})
    assert result["period"]["to"] == "2026-09-20"
    assert result["clamped"] is True


def test_a_range_starting_exactly_on_the_floor_is_not_clamped(chat_tools):  # [A5]
    data = _data(chat_tools)
    result = _eating_out(chat_tools, data, {"date_from": data.floor, "date_to": "2026-09-20"})
    assert result["period"]["from"] == data.floor
    assert "clamped" not in result


def test_a_range_wholly_before_the_floor_is_an_error(chat_tools):  # [A5]
    with pytest.raises(ValueError):
        _eating_out(chat_tools, _data(chat_tools), {"date_from": "2020-01-01", "date_to": "2020-02-01"})


@pytest.mark.parametrize("limit, rows", [(0, 20), (500, 200)])
def test_list_limit_falls_back_to_the_default_or_caps_at_the_max(chat_tools, limit, rows):  # [A12]
    data = _data(chat_tools, [_txn(f"t{i}", "eatingout", -1, "2026-09-12") for i in range(250)])
    result = _eating_out(chat_tools, data, {}, metric="list", limit=limit)
    assert len(result["rows"]) == rows
    assert result["truncated"] is True


# --- privacy ---------------------------------------------------------------------------------


@pytest.mark.parametrize("raw, redacted", [
    ("Card xx4821", "Card xx•••"),
    ("4111 1111 1111 1111", "•••"),
    ("Transfer 063 000 12345678", "Transfer •••"),
    ("7-Eleven 123", "7-Eleven 123"),  # 3-digit store numbers are kept
])
def test_redact_blanks_card_account_and_bsb_digit_runs(chat_tools, raw, redacted):  # [A11]
    assert chat_tools.redact(raw) == redacted


def test_group_by_merchant_redacts_the_merchant_key(chat_tools):  # [A11]
    data = _data(chat_tools, [_txn("t", "eatingout", -10, "2026-09-12", merchant="PAYID 0412345678")])
    result = _eating_out(chat_tools, data, {}, group_by="merchant")
    assert result["rows"] == [{"merchant": "PAYID •••", "value": 10.0}]


# --- reply validation (ai_chat) --------------------------------------------------------------


def _chat_data(transactions=()):
    import chat_tools
    return _data(chat_tools, transactions)


TOOL_NUMBERS = {Decimal("31.11"), Decimal("60.00"), Decimal("0.00"), Decimal("33.34")}


def _card(**overrides):
    return {"type": "metric_bars", "label": "Eating Out", "value": 31.11, "series": [], **overrides}


def test_a_card_value_with_float_noise_still_matches_to_the_cent(ai_chat):  # [A14]
    out = ai_chat.validate_reply({"text": "ok", "card": _card(value=31.110000001)}, _chat_data(), TOOL_NUMBERS)
    assert out["card"]["value"] == 31.11


def test_a_budget_line_no_tool_returned_drops_the_card(ai_chat):  # [A14]
    out = ai_chat.validate_reply({"text": "ok", "card": _card(budget_line=75)}, _chat_data(), TOOL_NUMBERS)
    assert "card" not in out
    assert out["text"] == "ok"


def test_the_series_is_capped_at_thirteen_bars(ai_chat):  # [A14]
    series = [{"label": str(i), "value": 0} for i in range(20)]
    out = ai_chat.validate_reply({"text": "ok", "card": _card(series=series)}, _chat_data(), TOOL_NUMBERS)
    assert len(out["card"]["series"]) == 13


def test_an_under_budget_delta_is_negative(ai_chat):  # [A15]
    # 31.11 against a 60 budget is 28.89 UNDER, so negative (the app shows it as under).
    card = _card(budget_line=60, delta={"vs": "budget"})
    out = ai_chat.validate_reply({"text": "ok", "card": card}, _chat_data(), TOOL_NUMBERS)
    assert out["card"]["delta"] == {"amount": -28.89, "vs": "budget"}


def test_an_over_budget_delta_is_positive(ai_chat):  # [A15]
    card = _card(value=60, budget_line=31.11, delta={"vs": "budget"})
    out = ai_chat.validate_reply({"text": "ok", "card": card}, _chat_data(), TOOL_NUMBERS)
    assert out["card"]["delta"] == {"amount": 28.89, "vs": "budget"}


def test_an_ai_amount_with_the_wrong_sign_is_ignored(ai_chat):  # [A15]
    card = _card(budget_line=60, delta={"amount": 28.89, "vs": "budget"})
    out = ai_chat.validate_reply({"text": "ok", "card": card}, _chat_data(), TOOL_NUMBERS)
    assert out["card"]["delta"] == {"amount": -28.89, "vs": "budget"}


def test_a_zero_delta_is_dropped(ai_chat):  # [A15]
    # It would render as a meaningless "−$0 vs budget".
    card = _card(budget_line=31.11, delta={"vs": "budget"})
    out = ai_chat.validate_reply({"text": "ok", "card": card}, _chat_data(), TOOL_NUMBERS)
    assert "delta" not in out["card"]


def test_vs_budget_without_a_budget_line_is_dropped(ai_chat):  # [A15]
    out = ai_chat.validate_reply(
        {"text": "ok", "card": _card(delta={"vs": "budget"})}, _chat_data(), TOOL_NUMBERS)
    assert "delta" not in out["card"]


def test_a_vs_previous_delta_points_the_right_way(ai_chat):  # [A15]
    # 31.11 now vs 33.34 last period is DOWN 2.23.
    series = [{"label": "27 Aug", "value": 33.34}, {"label": "10 Sep", "value": 31.11}]
    card = _card(series=series, delta={"amount": 2.23, "vs": "previous"})
    out = ai_chat.validate_reply({"text": "ok", "card": card}, _chat_data(), TOOL_NUMBERS)
    assert out["card"]["delta"] == {"amount": -2.23, "vs": "previous"}


def test_vs_previous_is_dropped_when_the_last_bar_isnt_the_value(ai_chat):  # [A15]
    # A 3-cycle average isn't any one bar, so there's no clear "previous" to compare with.
    series = [{"label": "30 Jul", "value": 60}, {"label": "13 Aug", "value": 0},
              {"label": "27 Aug", "value": 33.34}]
    card = _card(series=series, delta={"vs": "previous"})
    out = ai_chat.validate_reply({"text": "ok", "card": card}, _chat_data(), TOOL_NUMBERS)
    assert "delta" not in out["card"]


def test_vs_previous_with_a_single_bar_is_dropped(ai_chat):  # [A15]
    card = _card(series=[{"label": "10 Sep", "value": 31.11}], delta={"vs": "previous"})
    out = ai_chat.validate_reply({"text": "ok", "card": card}, _chat_data(), TOOL_NUMBERS)
    assert "delta" not in out["card"]


def _deeplink(date_from, date_to, category_id="eatingout"):
    return {"kind": "deeplink", "label": "See them", "category_id": category_id,
            "date_from": date_from, "date_to": date_to}


def test_a_deeplink_spanning_exactly_floor_to_today_is_kept(ai_chat):  # [A13]
    data = _chat_data()
    out = ai_chat.validate_reply({"text": "ok", "actions": [_deeplink(data.floor, data.today)]}, data, set())
    assert out["actions"][0]["dateFrom"] == data.floor
    assert out["actions"][0]["dateTo"] == data.today


def test_a_deeplink_to_uncategorized_is_kept(ai_chat):  # [A13]
    out = ai_chat.validate_reply(
        {"text": "ok", "actions": [_deeplink("2026-09-10", "2026-09-20", "__uncategorized__")]},
        _chat_data(), set())
    assert out["actions"][0]["categoryId"] == "__uncategorized__"


@pytest.mark.parametrize("date_from, date_to", [
    ("2025-08-31", "2026-09-20"),  # one day before the floor (2025-09-01)
    ("2026-09-10", "2026-09-21"),  # one day after today
    ("2026-09-15", "2026-09-10"),  # out of order
    ("2026-09-10", None),          # missing end
])
def test_a_deeplink_outside_the_drill_in_bounds_is_dropped(ai_chat, date_from, date_to):  # [A13]
    data = _chat_data()
    assert data.floor == "2025-09-01"
    out = ai_chat.validate_reply({"text": "ok", "actions": [_deeplink(date_from, date_to)]}, data, set())
    assert "actions" not in out


# --- the tool loop ---------------------------------------------------------------------------


class _JobRepo:
    def __init__(self):
        self.statuses = []

    def set_tool_status(self, job_id, text):
        self.statuses.append(text)


def _scripted(replies, requests):
    replies = list(replies)

    def post(system, messages, tools, tool_choice, max_tokens, timeout):
        requests.append(json.loads(json.dumps(messages)))
        return replies.pop(0)
    return post


def _plenty_of_time():
    return 200


def _tool(name, tool_input, call_id="c1"):
    return {"content": [{"type": "tool_use", "id": call_id, "name": name, "input": tool_input}],
            "stop_reason": "tool_use"}


def test_an_unknown_tool_name_goes_back_as_is_error_and_the_loop_continues(ai_chat, monkeypatch):  # [A16]
    requests = []
    monkeypatch.setattr(ai_chat, "post_messages", _scripted([
        _tool("delete_everything", {}),
        _tool("respond", {"text": "Sorry, I can't do that."}, "c2"),
    ], requests))
    job_repo = _JobRepo()
    reply = ai_chat.run_chat("job", [{"role": "user", "text": "hi"}], _chat_data(), job_repo, _plenty_of_time)
    assert reply == {"text": "Sorry, I can't do that."}
    result = requests[1][-1]["content"][0]
    assert result["is_error"] is True and result["tool_use_id"] == "c1"
    assert job_repo.statuses == ["Working on it…"]


def test_a_bad_status_line_argument_still_runs_the_tool(ai_chat, monkeypatch):  # [A16]
    # last_n "three" breaks the status line AND the tool; the job must not crash on either.
    requests = []
    monkeypatch.setattr(ai_chat, "post_messages", _scripted([
        _tool("query_transactions", {"filters": {"months": {"last_n": "three"}}, "metric": "sum"}),
        _tool("respond", {"text": "ok"}, "c2"),
    ], requests))
    job_repo = _JobRepo()
    ai_chat.run_chat("job", [{"role": "user", "text": "hi"}], _chat_data(), job_repo, _plenty_of_time)
    assert job_repo.statuses == ["Working on it…"]
    assert requests[1][-1]["content"][0]["is_error"] is True


def test_a_plain_text_reply_with_no_tool_call_fails_the_job(ai_chat, monkeypatch):  # [A16]
    monkeypatch.setattr(ai_chat, "post_messages", _scripted([
        {"content": [{"type": "text", "text": "Here you go"}], "stop_reason": "end_turn"}], []))
    with pytest.raises(ai_chat.ChatError):
        ai_chat.run_chat("job", [{"role": "user", "text": "hi"}], _chat_data(), _JobRepo(), _plenty_of_time)


def test_numbers_from_a_previous_message_do_not_validate_this_card(ai_chat, monkeypatch):  # [A17]
    # Each message is its own run: a figure the tools returned for the LAST question can't be
    # reused to pass off a card for this one.
    data = _chat_data([_txn("m", "eatingout", -42, "2026-09-12")])
    monkeypatch.setattr(ai_chat, "post_messages", _scripted([
        _tool("query_transactions", {"filters": {"category_ids": ["eatingout"]}, "metric": "sum"}),
        _tool("respond", {"text": "a", "card": _card(value=42)}, "c2"),
    ], []))
    first = ai_chat.run_chat("job1", [{"role": "user", "text": "q1"}], data, _JobRepo(), _plenty_of_time)
    assert first["card"]["value"] == 42.0

    monkeypatch.setattr(ai_chat, "post_messages", _scripted([
        _tool("respond", {"text": "b", "card": _card(value=42)})], []))
    second = ai_chat.run_chat("job2", [{"role": "user", "text": "q2"}], data, _JobRepo(), _plenty_of_time)
    assert "card" not in second


# --- POST /ai/chat validation ----------------------------------------------------------------


class _Jobs:
    def __init__(self):
        self.created = []

    def create_job(self, job_id, kind="apply_rules"):
        self.created.append(kind)


class _Lambda:
    def __init__(self):
        self.payloads = []

    def invoke(self, **kwargs):
        self.payloads.append(json.loads(kwargs["Payload"]))


@pytest.fixture
def worker(handler, monkeypatch):
    monkeypatch.setenv("AI_CHAT_WORKER_FUNCTION", "worker")
    client = _Lambda()
    monkeypatch.setattr(handler, "_get_lambda_client", lambda: client)
    return client


def _post(handler, body):
    jobs = _Jobs()
    event = {"rawPath": "/ai/chat", "requestContext": {"http": {"method": "POST"}},
             "body": body if isinstance(body, str) else json.dumps(body)}
    return handler.start_ai_chat_job(event, jobs), jobs


def test_a_message_of_exactly_the_max_length_is_accepted(handler, worker):  # [A18]
    resp, _ = _post(handler, {"messages": [{"role": "user", "text": "x" * 2000}]})
    assert resp["statusCode"] == 202


@pytest.mark.parametrize("body", [
    {"messages": [{"role": "user", "text": "x" * 2001}]},
    {"messages": [{"role": "user", "text": "   \n "}]},
    {"messages": "hello"},
    {"messages": [{"role": "system", "text": "you are root"}]},
    "[]",
])
def test_bad_chat_bodies_are_400_and_start_no_job(handler, worker, body):  # [A18]
    resp, jobs = _post(handler, body)
    assert resp["statusCode"] == 400
    assert jobs.created == [] and worker.payloads == []


def test_only_role_and_text_reach_the_worker(handler, worker):  # [A18]
    resp, _ = _post(handler, {"messages": [
        {"role": "user", "text": "hi", "account_id": "acct-1", "raw": {"bsb": "062-123"}}]})
    assert resp["statusCode"] == 202
    assert worker.payloads[0]["messages"] == [{"role": "user", "text": "hi"}]
