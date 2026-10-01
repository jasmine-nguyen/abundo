"""QA edge cases for card 613: the server works out the answer card's delta line. The AI sends
only `vs`; every amount comes from the card's own (tool-checked) figures.

Every assertion is against the real exported production code.
"""

from decimal import Decimal

import pytest

TODAY = "2026-09-20"
CYCLE_START = "2026-09-10"

CATEGORIES = [
    {"id": "eatingout", "name": "Eating Out", "bucket": "Lifestyle", "parent": None, "colorSlot": 0},
]

TRANSACTIONS = [
    {"transaction_id": "t1", "category": "eatingout", "amount": Decimal("-60"), "status": "posted",
     "counts_to_budget": True, "date": "2026-08-01", "merchant_name": "Pho Bar", "description": "PHO BAR"},
    {"transaction_id": "t2", "category": "eatingout", "amount": Decimal("-33.34"), "status": "posted",
     "counts_to_budget": True, "date": "2026-09-01", "merchant_name": "Grill'd", "description": "GRILLD"},
]

AVG_QUERY = {"filters": {"category_ids": ["eatingout"], "pay_cycles": {"last_n": 3}}, "metric": "avg"}

TOOL_NUMBERS = {Decimal("31.11"), Decimal("60.00"), Decimal("0.00"), Decimal("33.34")}


def _data():
    import chat_tools
    return chat_tools.ChatData(
        categories=CATEGORIES, budgets={}, cycle_start=CYCLE_START, length=14, today=TODAY,
        floor=chat_tools.lookback_floor(CYCLE_START, 14, TODAY), transactions=list(TRANSACTIONS))


def _bars(*values):
    return [{"label": f"p{index}", "value": value} for index, value in enumerate(values)]


def _card(**overrides):
    return {"type": "metric_bars", "label": "Eating Out", "value": 31.11, "series": [], **overrides}


def _delta(ai_chat, card):
    out = ai_chat.validate_reply({"text": "ok", "card": card}, _data(), TOOL_NUMBERS)
    return out["card"].get("delta")


class FakeJobRepo:
    def set_tool_status(self, job_id, text):
        pass

    def finish_chat_job(self, job_id, status, reply_json=None, error=None):
        pass


class ScriptedModel:
    def __init__(self, replies):
        self._replies = list(replies)

    def __call__(self, system, messages, tools, tool_choice, max_tokens, timeout):
        return self._replies.pop(0)


def _tool_use(name, tool_input, call_id):
    return {"type": "tool_use", "id": call_id, "name": name, "input": tool_input}


def _reply(block):
    return {"content": [block], "stop_reason": "tool_use"}


# --- what the AI is asked to send ------------------------------------------------------------


def _respond_delta_schema(ai_chat):
    respond = next(tool for tool in ai_chat.TOOLS if tool["name"] == "respond")
    return respond["input_schema"]["properties"]["card"]["properties"]["delta"]


def test_the_respond_tool_asks_only_for_vs(ai_chat):  # [A1]
    schema = _respond_delta_schema(ai_chat)
    assert set(schema["properties"]) == {"vs"}
    assert schema["required"] == ["vs"]
    assert schema["properties"]["vs"]["enum"] == ["budget", "previous"]


def test_the_instructions_tell_the_ai_the_server_works_out_the_amount(ai_chat):  # [A2]
    prompt = ai_chat.system_prompt(TODAY)
    assert "card.delta.vs" in prompt
    assert "The server works out the amount." in prompt


# --- vs previous -----------------------------------------------------------------------------


def test_vs_previous_compares_only_the_last_two_bars(ai_chat):  # [A3]
    # 31.11 (last) vs 33.34 (the bar before) → -2.23, never vs the 60 two bars back.
    assert _delta(ai_chat, _card(series=_bars(60, 33.34, 31.11), delta={"vs": "previous"})) == {
        "amount": -2.23, "vs": "previous"}


def test_vs_previous_ignores_an_ai_amount_against_some_other_tool_number(ai_chat):  # [A4]
    # The old loose check kept -28.89 (31.11 − 60, a tool number). The server's figure wins.
    card = _card(series=_bars(60, 33.34, 31.11), delta={"amount": -28.89, "vs": "previous"})
    assert _delta(ai_chat, card) == {"amount": -2.23, "vs": "previous"}


def test_vs_previous_up_from_a_zero_bar_is_positive(ai_chat):  # [A5]
    assert _delta(ai_chat, _card(series=_bars(0, 31.11), delta={"vs": "previous"})) == {
        "amount": 31.11, "vs": "previous"}


def test_vs_previous_with_two_equal_bars_is_dropped(ai_chat):  # [A6]
    assert _delta(ai_chat, _card(series=_bars(31.11, 31.11), delta={"vs": "previous"})) is None


def test_vs_previous_with_no_bars_is_dropped(ai_chat):  # [A7]
    assert _delta(ai_chat, _card(delta={"vs": "previous"})) is None


def test_vs_previous_when_value_matches_an_earlier_bar_but_not_the_last_is_dropped(ai_chat):  # [A7]
    # The value is a bar, just not the last one: there's no clear "previous".
    assert _delta(ai_chat, _card(series=_bars(31.11, 33.34, 60), delta={"vs": "previous"})) is None


def test_vs_previous_uses_the_bars_shown_after_the_thirteen_bar_cap(ai_chat):  # [A12]
    # 14 bars sent; the 14th (the value) is cut, so the last bar shown isn't the value → dropped.
    series = _bars(*([60] * 13), 31.11)
    out = ai_chat.validate_reply({"text": "ok", "card": _card(series=series, delta={"vs": "previous"})},
                                 _data(), TOOL_NUMBERS)
    assert len(out["card"]["series"]) == 13
    assert "delta" not in out["card"]


# --- vs budget -------------------------------------------------------------------------------


def test_vs_budget_ignores_the_bars(ai_chat):  # [A9]
    # Bars that would give a "previous" figure don't leak into the budget one.
    card = _card(budget_line=60, series=_bars(33.34, 31.11), delta={"vs": "budget"})
    assert _delta(ai_chat, card) == {"amount": -28.89, "vs": "budget"}


def test_vs_budget_rounds_float_noise_to_the_cent(ai_chat):  # [A10]
    card = _card(value=31.110000001, budget_line=59.999999, delta={"vs": "budget"})
    delta = _delta(ai_chat, card)
    assert delta == {"amount": -28.89, "vs": "budget"}
    assert type(delta["amount"]) is float


def test_vs_budget_with_a_zero_budget_line_is_the_whole_value(ai_chat):  # [A10]
    # budget_line 0 is set (not missing), so the gap is the full value, over.
    assert _delta(ai_chat, _card(budget_line=0, delta={"vs": "budget"})) == {"amount": 31.11, "vs": "budget"}


# --- malformed deltas ------------------------------------------------------------------------


@pytest.mark.parametrize("delta", [None, {}, {"vs": "average"}, {"amount": -28.89}])
def test_a_delta_without_a_known_vs_is_dropped(ai_chat, delta):  # [A8]
    card = _card(budget_line=60, series=_bars(33.34, 31.11), delta=delta)
    assert _delta(ai_chat, card) is None


def test_the_delta_carries_only_amount_and_vs(ai_chat):  # [A11]
    card = _card(budget_line=60, delta={"vs": "budget", "amount": 5, "note": "x"})
    assert set(_delta(ai_chat, card)) == {"amount", "vs"}


# --- end to end ------------------------------------------------------------------------------


def test_run_chat_carries_the_servers_vs_previous_figure(ai_chat, monkeypatch):  # [A13]
    # The 3-cycle query returns per-cycle bars 60, 0, 33.34. A card for the latest cycle
    # (33.34, its last bar) vs previous is +33.34 over the 0 cycle, whatever the AI claims.
    answer = {
        "text": "You spent **$33.34** last cycle on Eating Out.",
        "card": {"type": "metric_bars", "label": "Eating Out · last cycle", "value": 33.34,
                 "category_id": "eatingout", "delta": {"amount": -26.66, "vs": "previous"},
                 "series": [{"label": "30 Jul", "value": 60}, {"label": "13 Aug", "value": 0},
                            {"label": "27 Aug", "value": 33.34}]},
    }
    monkeypatch.setattr(ai_chat, "post_messages", ScriptedModel([
        _reply(_tool_use("query_transactions", AVG_QUERY, "c1")),
        _reply(_tool_use("respond", answer, "c2")),
    ]))

    reply = ai_chat.run_chat("job1", [{"role": "user", "text": "Eating out last cycle?"}],
                             _data(), FakeJobRepo(), lambda: 200)

    assert reply["card"]["value"] == 33.34
    assert reply["card"]["delta"] == {"amount": 33.34, "vs": "previous"}
