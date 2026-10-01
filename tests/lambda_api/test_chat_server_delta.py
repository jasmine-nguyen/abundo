"""Ask Abundo (card 613): the server works out the answer card's delta line itself. The AI only
says what to compare against (`vs`); any amount it sends is ignored.
"""

from decimal import Decimal

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


def _data():
    import chat_tools
    return chat_tools.ChatData(
        categories=CATEGORIES, budgets={}, cycle_start=CYCLE_START, length=14, today=TODAY,
        floor=chat_tools.lookback_floor(CYCLE_START, 14, TODAY), transactions=list(TRANSACTIONS))


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


def test_vs_previous_is_worked_out_from_the_last_two_bars(ai_chat):
    # The AI sends only "vs". 31.11 now (the last bar) vs 33.34 the bar before → down 2.23.
    tool_numbers = {Decimal("31.11"), Decimal("33.34")}
    card = {"type": "metric_bars", "label": "Eating Out", "value": 31.11,
            "series": [{"label": "27 Aug", "value": 33.34}, {"label": "10 Sep", "value": 31.11}],
            "delta": {"vs": "previous"}}

    out = ai_chat.validate_reply({"text": "ok", "card": card}, _data(), tool_numbers)

    assert out.get("card", {}).get("delta") == {"amount": -2.23, "vs": "previous"}


def test_a_made_up_ai_amount_is_replaced_by_the_servers_vs_budget_figure(ai_chat, monkeypatch):
    answer = {
        "text": "You spent **$31.11** per cycle on Eating Out.",
        "card": {"type": "metric_bars", "label": "Eating Out · 3-cycle average", "value": 31.11,
                 "category_id": "eatingout", "budget_line": 60,
                 "delta": {"amount": 5, "vs": "budget"},
                 "series": [{"label": "30 Jul", "value": 60}, {"label": "13 Aug", "value": 0},
                            {"label": "27 Aug", "value": 33.34}]},
    }
    monkeypatch.setattr(ai_chat, "post_messages", ScriptedModel([
        _reply(_tool_use("query_transactions", AVG_QUERY, "c1")),
        _reply(_tool_use("respond", answer, "c2")),
    ]))

    reply = ai_chat.run_chat("job1", [{"role": "user", "text": "Average eating out, 3 cycles?"}],
                             _data(), FakeJobRepo(), lambda: 200)

    assert reply["card"].get("delta") == {"amount": -28.89, "vs": "budget"}
