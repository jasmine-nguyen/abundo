"""Tests for lambda_api/ai_chat.py — the Ask Abundo chat worker (card 609).

post_messages is replaced by the shared ScriptedModel that plays back model replies and records every
request, so the tool loop, reply validation, failure handling and the privacy guarantee are
tested without the network.
"""

import json
from decimal import Decimal

import pytest
from _anthropic_fakes import ScriptedModel, tool_reply, tool_use_block
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo
from _job_fakes import FakeChatJobRepo
from _transaction_range_fakes import _AccountTransactionRepo, _DateFilteringTransactionRepo

TODAY = "2026-09-20"
CYCLE_START = "2026-09-10"

CATEGORIES = [
    {"id": "eatingout", "name": "Eating Out", "bucket": "Lifestyle", "parent": None, "colorSlot": 0},
    {"id": "groceries", "name": "Groceries", "bucket": "Living", "parent": None, "colorSlot": 11},
]

# Rows carrying every kind of secret the model must never see.
SECRET_ROWS = [
    {
        "transaction_id": "t1", "category": "eatingout", "amount": Decimal("-60"), "status": "posted",
        "counts_to_budget": True, "date": "2026-08-01", "merchant_name": "Pho Bar",
        "description": "Card xx4821 Pho Bar", "account_id": "acct-98765432",
        "account_name": "Jas Everyday 4444", "raw": {"balance": "8765.43", "bsb": "062-123"},
        "pk": "ACCT#acct-98765432", "sk": "TXN#t1",
    },
    {
        "transaction_id": "t2", "category": "eatingout", "amount": Decimal("-33.34"), "status": "posted",
        "counts_to_budget": True, "date": "2026-09-01", "merchant_name": "Grill'd",
        "description": "Transfer to 062-123 12345678", "account_id": "acct-98765432",
        "account_name": "Jas Everyday 4444", "raw": {"balance": "8765.43"},
    },
]
SECRETS = ("4821", "98765432", "12345678", "062-123", "8765.43", "4444", "Jas Everyday")


def _data(ai_chat, transactions=SECRET_ROWS):
    import chat_tools
    return chat_tools.ChatData(
        categories=CATEGORIES, budgets={}, cycle_start=CYCLE_START, length=14, today=TODAY,
        floor=chat_tools.lookback_floor(CYCLE_START, 14, TODAY), transactions=list(transactions))


AVG_QUERY = {"filters": {"category_ids": ["eatingout"], "pay_cycles": {"last_n": 3}}, "metric": "avg"}
GOOD_ANSWER = {
    "text": "You spent **$31.11** per cycle on Eating Out.",
    "card": {"type": "metric_bars", "label": "Eating Out · 3-cycle average", "value": 31.11,
             "category_id": "eatingout", "budget_line": 60,
             "delta": {"vs": "budget"},
             "series": [{"label": "30 Jul", "value": 60}, {"label": "13 Aug", "value": 0},
                        {"label": "27 Aug", "value": 33.34}]},
    "source": "3 completed pay cycles · 30 Jul – 9 Sep",
    "actions": [
        {"kind": "deeplink", "label": "See Eating Out transactions", "category_id": "eatingout",
         "date_from": "2026-07-30", "date_to": "2026-09-09"},
        {"kind": "prompt", "label": "Compare to Groceries", "text": "Compare that to Groceries"},
    ],
}


class FakeContext:
    """The Lambda context: only the remaining time is read."""

    def __init__(self, remaining_ms=200_000):
        self.remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self):
        return self.remaining_ms


def _run(ai_chat, monkeypatch, replies, messages=None, data=None, seconds_left=lambda: 200):
    model = ScriptedModel(replies)
    monkeypatch.setattr(ai_chat, "post_messages", model)
    job_repo = FakeChatJobRepo()
    reply = ai_chat.run_chat("job1", messages or [{"role": "user", "text": "Average eating out, 3 cycles?"}],
                             data or _data(ai_chat), job_repo, seconds_left)
    return reply, model, job_repo


# --- the loop --------------------------------------------------------------------------------


def test_tool_call_then_respond_gives_a_camel_case_reply(ai_chat, monkeypatch):
    reply, model, job_repo = _run(ai_chat, monkeypatch, [
        tool_reply(tool_use_block("query_transactions", AVG_QUERY)),
        tool_reply(tool_use_block("respond", GOOD_ANSWER, "c2")),
    ])

    assert reply["text"] == GOOD_ANSWER["text"]
    assert reply["source"] == GOOD_ANSWER["source"]
    assert reply["card"] == {
        "type": "metric_bars", "label": "Eating Out · 3-cycle average", "value": 31.11,
        "series": [{"label": "30 Jul", "value": 60.0}, {"label": "13 Aug", "value": 0.0},
                   {"label": "27 Aug", "value": 33.34}],
        "categoryId": "eatingout", "budgetLine": 60.0, "delta": {"amount": -28.89, "vs": "budget"},
    }
    assert reply["actions"] == [
        {"kind": "deeplink", "label": "See Eating Out transactions", "categoryId": "eatingout",
         "dateFrom": "2026-07-30", "dateTo": "2026-09-09"},
        {"kind": "prompt", "label": "Compare to Groceries", "text": "Compare that to Groceries"},
    ]
    # The status line was written from the tool's arguments before it ran.
    assert job_repo.statuses == ["Looking at Eating Out, last 3 cycles…"]
    # The tool result went back to the model, tied to the call id.
    result_turn = model.requests[1]["messages"][-1]
    assert result_turn["role"] == "user"
    assert result_turn["content"][0]["tool_use_id"] == "c1"
    assert json.loads(result_turn["content"][0]["content"])["avg"] == 31.11


def test_no_answer_by_the_last_round_fails(ai_chat, monkeypatch):
    replies = [tool_reply(tool_use_block("get_categories", {}, f"c{i}")) for i in range(ai_chat.CHAT_MAX_TOOL_ROUNDS)]
    with pytest.raises(ai_chat.ChatError):
        _run(ai_chat, monkeypatch, replies)


def test_a_bad_tool_argument_goes_back_as_is_error(ai_chat, monkeypatch):
    _, model, _ = _run(ai_chat, monkeypatch, [
        tool_reply(tool_use_block("query_transactions", {"filters": {"category_ids": ["nope"]}, "metric": "sum"})),
        tool_reply(tool_use_block("respond", {"text": "I couldn't find that category."}, "c2")),
    ])
    result = model.requests[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and "get_categories" in result["content"]


def test_an_unknown_tool_name_goes_back_as_is_error_and_the_loop_continues(ai_chat, monkeypatch):
    reply, model, job_repo = _run(ai_chat, monkeypatch, [
        tool_reply(tool_use_block("delete_everything", {})),
        tool_reply(tool_use_block("respond", {"text": "Sorry, I can't do that."}, "c2")),
    ])
    assert reply == {"text": "Sorry, I can't do that."}
    result = model.requests[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and result["tool_use_id"] == "c1"
    assert job_repo.statuses == ["Working on it…"]


def test_a_bad_status_line_argument_still_runs_the_tool(ai_chat, monkeypatch):
    # last_n "three" breaks the status line AND the tool; the job must not crash on either.
    _, model, job_repo = _run(ai_chat, monkeypatch, [
        tool_reply(tool_use_block("query_transactions", {"filters": {"months": {"last_n": "three"}}, "metric": "sum"})),
        tool_reply(tool_use_block("respond", {"text": "ok"}, "c2")),
    ])
    assert job_repo.statuses == ["Working on it…"]
    assert model.requests[1]["messages"][-1]["content"][0]["is_error"] is True


def test_a_plain_text_reply_with_no_tool_call_fails_the_job(ai_chat, monkeypatch):
    with pytest.raises(ai_chat.ChatError):
        _run(ai_chat, monkeypatch, [tool_reply({"type": "text", "text": "Here you go"}, stop_reason="end_turn")])


THINKING = {"type": "thinking", "thinking": "Look up the categories first.", "signature": "sig-1"}


def test_last_round_asks_for_an_answer_and_thinking_blocks_go_back_unchanged(ai_chat, monkeypatch):
    # WHIT-807: no forced tool_choice; the last round adds a system turn telling the model to respond.
    rounds = ai_chat.CHAT_MAX_TOOL_ROUNDS
    first_content = [THINKING, tool_use_block("get_categories", {}, "c0")]
    replies = [{"content": first_content, "stop_reason": "tool_use"}]
    replies += [tool_reply(tool_use_block("get_categories", {}, f"c{i}")) for i in range(1, rounds - 1)]
    replies.append(tool_reply(tool_use_block("respond", {"text": "You have one category."}, "last")))

    reply, model, _ = _run(ai_chat, monkeypatch, replies)

    assert reply == {"text": "You have one category."}
    assert len(model.requests) == rounds
    for request in model.requests[:-1]:
        assert all(message["role"] != "system" for message in request["messages"])
    last_messages = model.requests[-1]["messages"]
    assert last_messages[-1]["role"] == "system"
    assert "respond" in last_messages[-1]["content"]
    assert last_messages[-2]["role"] == "user"
    # The first assistant turn is replayed exactly as the model sent it, thinking block included.
    assistant_turns = [m for m in model.requests[1]["messages"] if m["role"] == "assistant"]
    assert assistant_turns == [{"role": "assistant", "content": first_content}]


def test_chat_tool_result_renders_decimals_as_numbers(ai_chat, monkeypatch):
    # WHIT-765: a chat tool's Decimal output reaches the model as plain JSON numbers.
    monkeypatch.setitem(ai_chat.TOOL_FUNCTIONS, "qa_tool", lambda data, args: {"spent": Decimal("60.5")})

    block = ai_chat._run_tool({"name": "qa_tool", "id": "call-1"}, None, set())

    assert block["type"] == "tool_result"
    assert block["tool_use_id"] == "call-1"
    assert json.loads(block["content"]) == {"spent": 60.5}


# --- reply validation ------------------------------------------------------------------------


def test_a_card_with_an_invented_figure_is_dropped_but_the_text_kept(ai_chat, monkeypatch):
    invented = {**GOOD_ANSWER, "card": {**GOOD_ANSWER["card"], "value": 42.0}}
    reply, _, _ = _run(ai_chat, monkeypatch, [
        tool_reply(tool_use_block("query_transactions", AVG_QUERY)),
        tool_reply(tool_use_block("respond", invented, "c2")),
    ])
    assert "card" not in reply and reply["text"] == GOOD_ANSWER["text"]


def test_a_card_is_dropped_when_no_tool_ran_this_turn(ai_chat, monkeypatch):
    reply, _, _ = _run(ai_chat, monkeypatch, [tool_reply(tool_use_block("respond", GOOD_ANSWER))])
    assert "card" not in reply


def test_a_made_up_ai_delta_amount_is_ignored(ai_chat, monkeypatch):
    made_up_delta = {**GOOD_ANSWER, "card": {**GOOD_ANSWER["card"], "delta": {"amount": 5, "vs": "budget"}}}
    reply, _, _ = _run(ai_chat, monkeypatch, [
        tool_reply(tool_use_block("query_transactions", AVG_QUERY)),
        tool_reply(tool_use_block("respond", made_up_delta, "c2")),
    ])
    assert reply["card"]["delta"] == {"amount": -28.89, "vs": "budget"}


@pytest.mark.parametrize("action", [
    {"kind": "deeplink", "label": "x", "category_id": "nope", "date_from": "2026-08-01", "date_to": "2026-08-31"},
    {"kind": "deeplink", "label": "x", "category_id": "eatingout", "date_from": "2026-08-31", "date_to": "2026-08-01"},
    {"kind": "deeplink", "label": "x", "category_id": "eatingout", "date_from": "2020-01-01", "date_to": "2026-08-31"},
    {"kind": "deeplink", "label": "x", "category_id": "eatingout", "date_from": "2026-08-01", "date_to": "2026-12-31"},
    {"kind": "deeplink", "label": "x", "category_id": "eatingout", "date_from": "2026-02-30", "date_to": "2026-08-31"},
    {"kind": "deeplink", "label": "x", "category_id": "eatingout", "date_from": "2026-09-10", "date_to": None},
    {"kind": "prompt", "label": "x", "text": ""},
    {"kind": "teleport", "label": "x"},
])
def test_bad_actions_are_dropped(ai_chat, action):
    reply = ai_chat.validate_reply({"text": "Hi", "actions": [action]}, _data(ai_chat), set())
    assert "actions" not in reply


def test_a_deeplink_to_uncategorized_is_kept(ai_chat):
    action = {"kind": "deeplink", "label": "See them", "category_id": "__uncategorized__",
              "date_from": "2026-09-10", "date_to": "2026-09-20"}
    reply = ai_chat.validate_reply({"text": "ok", "actions": [action]}, _data(ai_chat), set())
    assert reply["actions"][0]["categoryId"] == "__uncategorized__"


TOOL_NUMBERS = {Decimal("31.11"), Decimal("60.00"), Decimal("0.00"), Decimal("33.34")}


def _card(**overrides):
    return {"type": "metric_bars", "label": "Eating Out", "value": 31.11, "series": [], **overrides}


def _bars(*values):
    return [{"label": f"p{index}", "value": value} for index, value in enumerate(values)]


def test_a_card_value_with_float_noise_still_matches_to_the_cent(ai_chat):
    reply = ai_chat.validate_reply({"text": "ok", "card": _card(value=31.110000001)}, _data(ai_chat), TOOL_NUMBERS)
    assert reply["card"]["value"] == 31.11


def test_a_budget_line_no_tool_returned_drops_the_card(ai_chat):
    reply = ai_chat.validate_reply({"text": "ok", "card": _card(budget_line=75)}, _data(ai_chat), TOOL_NUMBERS)
    assert "card" not in reply
    assert reply["text"] == "ok"


@pytest.mark.parametrize(("card", "delta"), [
    (_card(budget_line=60, delta={"vs": "budget"}), {"amount": -28.89, "vs": "budget"}),
    (_card(value=60, budget_line=31.11, delta={"vs": "budget"}), {"amount": 28.89, "vs": "budget"}),
    (_card(budget_line=60, delta={"amount": 28.89, "vs": "budget"}), {"amount": -28.89, "vs": "budget"}),
    (_card(budget_line=0, delta={"vs": "budget"}), {"amount": 31.11, "vs": "budget"}),
    (_card(value=31.110000001, budget_line=59.999999, delta={"vs": "budget"}), {"amount": -28.89, "vs": "budget"}),
    (_card(budget_line=31.11, delta={"vs": "budget"}), None),
    (_card(delta={"vs": "budget"}), None),
    (_card(series=_bars(60, 33.34, 31.11), delta={"vs": "previous"}), {"amount": -2.23, "vs": "previous"}),
    (_card(series=_bars(31.11, 33.34, 60), delta={"vs": "previous"}), None),
    (_card(series=_bars(31.11), delta={"vs": "previous"}), None),
    (_card(budget_line=60, series=_bars(33.34, 31.11), delta={"vs": "average"}), None),
    (_card(budget_line=60, series=_bars(33.34, 31.11), delta={"amount": -28.89}), None),
], ids=["under-budget", "over-budget", "ai-wrong-sign", "zero-budget-line", "float-noise", "zero-delta",
        "no-budget-line", "vs-previous", "value-not-last-bar", "single-bar", "unknown-vs", "no-vs"])
def test_the_server_works_out_the_delta(ai_chat, card, delta):
    # Card 613: the AI only says what to compare against; every amount comes from the card's figures.
    reply = ai_chat.validate_reply({"text": "ok", "card": card}, _data(ai_chat), TOOL_NUMBERS)
    assert reply["card"].get("delta") == delta


def test_empty_text_fails_the_answer(ai_chat):
    with pytest.raises(ai_chat.ChatError):
        ai_chat.validate_reply({"text": "  "}, _data(ai_chat), set())


# --- turning the history into model turns ----------------------------------------------------


def test_a_follow_up_seed_gets_a_user_turn_in_front(ai_chat):
    turns = ai_chat.to_model_messages([
        {"role": "assistant", "text": "You're on track this cycle."},
        {"role": "user", "text": "What about eating out?"},
    ])
    assert [turn["role"] for turn in turns] == ["user", "assistant", "user"]
    assert turns[1]["content"] == "You're on track this cycle."


def test_consecutive_same_role_turns_are_merged(ai_chat):
    turns = ai_chat.to_model_messages([
        {"role": "user", "text": "First"}, {"role": "user", "text": "Second"},
    ])
    assert turns == [{"role": "user", "content": "First\n\nSecond"}]


# --- privacy (definition of done #6, automated) ----------------------------------------------


def test_no_request_to_the_model_carries_account_card_bsb_or_balance(ai_chat, monkeypatch):
    _, model, _ = _run(ai_chat, monkeypatch, [
        tool_reply(tool_use_block("query_transactions", {"filters": {"months": {"last_n": 3, "include_current": True}},
                                                "metric": "list"})),
        tool_reply(tool_use_block("query_transactions", {"filters": {"months": {"last_n": 3}}, "metric": "max"}, "c2")),
        tool_reply(tool_use_block("respond", {"text": "Done."}, "c3")),
    ])
    sent = json.dumps(model.requests)
    # The rows did reach the model (so the check isn't vacuous)...
    assert "Pho Bar" in sent and "Grill'd" in sent
    # ...but none of the secrets did.
    for secret in SECRETS:
        assert secret not in sent, secret


# --- the worker entry point ------------------------------------------------------------------


@pytest.fixture
def worker(ai_chat, monkeypatch):
    job_repo = FakeChatJobRepo()
    monkeypatch.setattr(ai_chat, "JobRepository", lambda: job_repo)
    for name in ("TransactionRepository", "CategoryRepository", "BudgetRepository", "PayCycleRepository"):
        monkeypatch.setattr(ai_chat, name, lambda: object())
    monkeypatch.setattr(ai_chat, "load_chat_data", lambda *repos: _data(ai_chat))
    return job_repo


EVENT = {"jobId": "job1", "messages": [{"role": "user", "text": "Average eating out?"}]}


def test_worker_stores_the_reply_as_json_and_succeeds(ai_chat, monkeypatch, worker):
    monkeypatch.setattr(ai_chat, "post_messages", ScriptedModel([
        tool_reply(tool_use_block("query_transactions", AVG_QUERY)),
        tool_reply(tool_use_block("respond", GOOD_ANSWER, "c2")),
    ]))
    assert ai_chat.lambda_handler(EVENT, FakeContext()) == {"jobId": "job1", "status": "succeeded"}
    finished = worker.finished[0]
    assert finished["status"] == "succeeded"
    assert json.loads(finished["reply"])["card"]["value"] == 31.11


def test_worker_marks_an_anthropic_failure_as_assistant_unavailable(ai_chat, monkeypatch, worker):
    def down(*args):
        raise ai_chat.AnthropicError(529, "overloaded")
    monkeypatch.setattr(ai_chat, "post_messages", down)
    assert ai_chat.lambda_handler(EVENT, FakeContext())["status"] == "failed"
    assert worker.finished == [{"status": "failed", "reply": None, "error": "assistant unavailable"}]


def test_worker_marks_a_refusal_could_not_answer_even_with_an_answer_attached(ai_chat, monkeypatch, worker):  # [A1]
    monkeypatch.setattr(ai_chat, "post_messages", ScriptedModel([
        tool_reply(tool_use_block("respond", {"text": "Hi"}), stop_reason="refusal"),
    ]))
    assert ai_chat.lambda_handler(EVENT, FakeContext())["status"] == "failed"
    assert worker.finished == [{"status": "failed", "reply": None, "error": "could not answer"}]


def test_worker_marks_any_other_failure_failed(ai_chat, monkeypatch, worker):
    def broken(*repos):
        raise RuntimeError("db down")
    monkeypatch.setattr(ai_chat, "load_chat_data", broken)
    assert ai_chat.lambda_handler(EVENT, FakeContext())["status"] == "failed"
    assert worker.finished[0]["error"] == "could not answer"


class RolloverBudgetRepo:
    """Groceries $100 with rollover on, anchored on the 2026-08-27 cycle; records any write."""

    def __init__(self):
        self.writes = []

    def list_budgets(self):
        return {"groceries": {
            "target": Decimal("100"), "rollover": True, "carryover": Decimal("0"),
            "carryover_from": "2026-08-27", "carryover_len": Decimal("14"),
            "carryover_paydate": "2026-09-10",
        }}

    def settle_carryover(self, *args):
        self.writes.append(("settle_carryover", args))

    def clear_spread(self, *args):
        self.writes.append(("clear_spread", args))

    def set_spread(self, *args):
        self.writes.append(("set_spread", args))


def _groceries_row(txn_id, amount, day):
    return {"transaction_id": txn_id, "account_id": "up-spending", "category": "groceries",
            "amount": Decimal(amount), "status": "posted", "counts_to_budget": True, "date": day}


def _load_chat_data(ai_chat, monkeypatch, transaction_repo, budget_repo):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: __import__("datetime").date(2026, 9, 20))
    return ai_chat.load_chat_data(
        transaction_repo, _FakeCategoryRepo(CATEGORIES), budget_repo,
        _FakePayCycleRepo(length=14, last_pay_date="2026-09-10"))


def test_load_chat_data_fetches_back_to_the_lookback_floor(ai_chat, monkeypatch):
    transaction_repo = _DateFilteringTransactionRepo([])
    data = _load_chat_data(ai_chat, monkeypatch, transaction_repo, RolloverBudgetRepo())
    assert data.floor == "2025-09-01" and data.today == TODAY
    assert transaction_repo.calls[0][1:3] == ("2025-09-01", TODAY)


def test_rollover_history_older_than_the_chat_floor_still_counts(ai_chat, monkeypatch):
    # WHIT-622: if the chat's floor ever sits later than the rollover read start, the read still
    # reaches back for the carryover, but the chat's own transactions stop at the floor.
    # Prior cycle 2026-08-27..09-09 spent $60 of $100 → carryover $40.
    monkeypatch.setattr(ai_chat, "lookback_floor", lambda cycle_start, length, today: cycle_start)
    rows = [_groceries_row("prior", "-60", "2026-08-30"), _groceries_row("now", "-25", "2026-09-15")]
    data = _load_chat_data(ai_chat, monkeypatch, _AccountTransactionRepo(rows), RolloverBudgetRepo())

    assert data.floor == "2026-09-10"
    assert data.budgets["groceries"]["carryover"] == Decimal("40")
    assert data.budgets["groceries"]["available"] == Decimal("140")
    assert [t["transaction_id"] for t in data.transactions] == ["now"]


def test_load_chat_data_works_out_budgets_from_its_own_read_without_saving(ai_chat, monkeypatch):
    # WHIT-622: the chat shows the same budget rows as /budgets (rollover included) from its one
    # transaction read, and never writes the settlements — only GET /budgets saves those.
    stored = [_groceries_row("old", "-500", "2025-10-01"), _groceries_row("prior", "-60", "2026-08-30"),
              _groceries_row("now", "-25", "2026-09-15")]

    budget_repo = RolloverBudgetRepo()
    data = _load_chat_data(ai_chat, monkeypatch, _AccountTransactionRepo(stored), budget_repo)

    assert data.budgets == {"groceries": {
        "target": Decimal("100"), "posted": Decimal("25"), "pending": Decimal("0"),
        "rollover": True, "carryover": Decimal("40"),
        "carryover_cycles": [{"start": "2026-08-27", "end": "2026-09-09", "target": Decimal("100"),
                              "spent": Decimal("60"), "leftover": Decimal("40"), "settling": False}],
        "carryover_earlier": Decimal("0"), "available": Decimal("140"),
    }}
    assert budget_repo.writes == []
    assert {t["transaction_id"] for t in data.transactions} == {"old", "prior", "now"}


# --- QA (card 609): boundaries the happy path doesn't reach ----------------------------------


def test_a_deeplink_exactly_at_the_lookback_floor_and_today_is_kept(ai_chat):
    # [A6] Both ends are inclusive — the drill-in accepts [floor, today], so the chat must too.
    data = _data(ai_chat)
    action = {"kind": "deeplink", "label": "See all", "category_id": "eatingout",
              "date_from": data.floor, "date_to": data.today}
    reply = ai_chat.validate_reply({"text": "Hi", "actions": [action]}, data, set())
    assert reply["actions"] == [{"kind": "deeplink", "label": "See all", "categoryId": "eatingout",
                                 "dateFrom": data.floor, "dateTo": data.today}]


def test_a_tool_that_raises_a_non_value_error_goes_back_as_is_error(ai_chat, monkeypatch):
    # [A7] get_budgets({"pay_cycle": {"cycles_back": 2}}) raises KeyError, not ValueError. It must still come back
    # to the model as is_error (so it can fix the call), not fail the whole job.
    reply, model, _ = _run(ai_chat, monkeypatch, [
        tool_reply(tool_use_block("get_budgets", {"pay_cycle": {"cycles_back": 2}})),
        tool_reply(tool_use_block("respond", {"text": "Sorted."}, "c2")),
    ])
    [result] = model.requests[1]["messages"][-1]["content"]
    assert result["is_error"] is True and result["tool_use_id"] == "c1"
    assert reply["text"] == "Sorted."


def test_worker_still_returns_failed_when_marking_the_job_failed_also_fails(ai_chat, monkeypatch, worker):
    # [A8] A DynamoDB error while recording the failure must not escape — an escaped exception
    # would make AWS treat the async invoke as failed (and log a crash), with no status for the app.
    def boom(*args, **kwargs):
        raise RuntimeError("model blew up")

    def db_down(job_id, status, reply_json=None, error=None):
        raise ai_chat.DatabaseError("throttled")

    monkeypatch.setattr(ai_chat, "run_chat", boom)
    monkeypatch.setattr(worker, "finish_chat_job", db_down)
    assert ai_chat.lambda_handler(EVENT, FakeContext()) == {"jobId": "job1", "status": "failed"}


# --- the time budget (WHIT-612) --------------------------------------------------------------


def test_each_model_call_is_capped_at_the_per_call_limit(ai_chat, monkeypatch):
    _, model, _ = _run(ai_chat, monkeypatch, [
        tool_reply(tool_use_block("query_transactions", AVG_QUERY)),
        tool_reply(tool_use_block("respond", GOOD_ANSWER, "c2")),
    ], seconds_left=lambda: 1000)
    assert [request["timeout"] for request in model.requests] == [60, 60]


def test_too_little_time_left_fails_before_calling_the_model(ai_chat, monkeypatch):
    model = ScriptedModel([tool_reply(tool_use_block("respond", GOOD_ANSWER))])
    monkeypatch.setattr(ai_chat, "post_messages", model)
    # 19.9s left - 10s margin = 9.9s, just under the 10s minimum for a call.
    with pytest.raises(ai_chat.ChatError):
        ai_chat.run_chat("job1", EVENT["messages"], _data(ai_chat), FakeChatJobRepo(), lambda: 19.9)
    assert model.requests == []
