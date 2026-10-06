"""Tests for lambda_api/ai_chat.py — the Ask Abundo chat worker (card 609).

post_messages is replaced by a scripted fake that plays back model replies and records every
request, so the tool loop, reply validation, failure handling and the privacy guarantee are
tested without the network.
"""

import json
from decimal import Decimal

import pytest
from _budget_endpoint_fakes import _FakeCategoryRepo, _FakePayCycleRepo

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


class FakeJobRepo:
    def __init__(self):
        self.statuses = []
        self.finished = []

    def set_tool_status(self, job_id, text):
        self.statuses.append(text)

    def finish_chat_job(self, job_id, status, reply_json=None, error=None):
        self.finished.append({"status": status, "reply": reply_json, "error": error})


class ScriptedModel:
    """Plays back one reply per call and records each request body."""

    def __init__(self, replies):
        self._replies = list(replies)
        self.requests = []

    def __call__(self, system, messages, tools, tool_choice, max_tokens, timeout):
        self.requests.append({"system": system, "messages": json.loads(json.dumps(messages)),
                              "tool_choice": tool_choice, "timeout": timeout})
        return self._replies.pop(0)


def _tool_use(name, tool_input, call_id="c1"):
    return {"type": "tool_use", "id": call_id, "name": name, "input": tool_input}


def _reply(*blocks):
    return {"content": list(blocks), "stop_reason": "tool_use"}


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
    job_repo = FakeJobRepo()
    reply = ai_chat.run_chat("job1", messages or [{"role": "user", "text": "Average eating out, 3 cycles?"}],
                             data or _data(ai_chat), job_repo, seconds_left)
    return reply, model, job_repo


# --- the loop --------------------------------------------------------------------------------


def test_tool_call_then_respond_gives_a_camel_case_reply(ai_chat, monkeypatch):
    reply, model, job_repo = _run(ai_chat, monkeypatch, [
        _reply(_tool_use("query_transactions", AVG_QUERY)),
        _reply(_tool_use("respond", GOOD_ANSWER, "c2")),
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


def test_early_rounds_force_a_tool_and_the_last_round_forces_respond(ai_chat, monkeypatch):
    rounds = ai_chat.CHAT_MAX_TOOL_ROUNDS
    replies = [_reply(_tool_use("get_categories", {}, f"c{i}")) for i in range(rounds - 1)]
    replies.append(_reply(_tool_use("respond", {"text": "Here's what I found."}, "last")))
    reply, model, _ = _run(ai_chat, monkeypatch, replies)

    assert reply == {"text": "Here's what I found."}
    assert [request["tool_choice"] for request in model.requests[:-1]] == [{"type": "any"}] * (rounds - 1)
    assert model.requests[-1]["tool_choice"] == {"type": "tool", "name": "respond"}


def test_no_answer_by_the_last_round_fails(ai_chat, monkeypatch):
    replies = [_reply(_tool_use("get_categories", {}, f"c{i}")) for i in range(ai_chat.CHAT_MAX_TOOL_ROUNDS)]
    with pytest.raises(ai_chat.ChatError):
        _run(ai_chat, monkeypatch, replies)


def test_a_bad_tool_argument_goes_back_as_is_error(ai_chat, monkeypatch):
    _, model, _ = _run(ai_chat, monkeypatch, [
        _reply(_tool_use("query_transactions", {"filters": {"category_ids": ["nope"]}, "metric": "sum"})),
        _reply(_tool_use("respond", {"text": "I couldn't find that category."}, "c2")),
    ])
    result = model.requests[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and "get_categories" in result["content"]


# --- reply validation ------------------------------------------------------------------------


def test_a_card_with_an_invented_figure_is_dropped_but_the_text_kept(ai_chat, monkeypatch):
    invented = {**GOOD_ANSWER, "card": {**GOOD_ANSWER["card"], "value": 42.0}}
    reply, _, _ = _run(ai_chat, monkeypatch, [
        _reply(_tool_use("query_transactions", AVG_QUERY)),
        _reply(_tool_use("respond", invented, "c2")),
    ])
    assert "card" not in reply and reply["text"] == GOOD_ANSWER["text"]


def test_a_card_is_dropped_when_no_tool_ran_this_turn(ai_chat, monkeypatch):
    reply, _, _ = _run(ai_chat, monkeypatch, [_reply(_tool_use("respond", GOOD_ANSWER))])
    assert "card" not in reply


def test_a_made_up_ai_delta_amount_is_ignored(ai_chat, monkeypatch):
    made_up_delta = {**GOOD_ANSWER, "card": {**GOOD_ANSWER["card"], "delta": {"amount": 5, "vs": "budget"}}}
    reply, _, _ = _run(ai_chat, monkeypatch, [
        _reply(_tool_use("query_transactions", AVG_QUERY)),
        _reply(_tool_use("respond", made_up_delta, "c2")),
    ])
    assert reply["card"]["delta"] == {"amount": -28.89, "vs": "budget"}


@pytest.mark.parametrize("action", [
    {"kind": "deeplink", "label": "x", "category_id": "nope", "date_from": "2026-08-01", "date_to": "2026-08-31"},
    {"kind": "deeplink", "label": "x", "category_id": "eatingout", "date_from": "2026-08-31", "date_to": "2026-08-01"},
    {"kind": "deeplink", "label": "x", "category_id": "eatingout", "date_from": "2020-01-01", "date_to": "2026-08-31"},
    {"kind": "deeplink", "label": "x", "category_id": "eatingout", "date_from": "2026-08-01", "date_to": "2026-12-31"},
    {"kind": "deeplink", "label": "x", "category_id": "eatingout", "date_from": "2026-02-30", "date_to": "2026-08-31"},
    {"kind": "prompt", "label": "x", "text": ""},
    {"kind": "teleport", "label": "x"},
])
def test_bad_actions_are_dropped(ai_chat, action):
    reply = ai_chat.validate_reply({"text": "Hi", "actions": [action]}, _data(ai_chat), set())
    assert "actions" not in reply


def test_at_most_two_actions(ai_chat):
    prompt = {"kind": "prompt", "label": "Ask", "text": "More?"}
    reply = ai_chat.validate_reply({"text": "Hi", "actions": [prompt] * 4}, _data(ai_chat), set())
    assert len(reply["actions"]) == 2


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
        _reply(_tool_use("query_transactions", {"filters": {"months": {"last_n": 3, "include_current": True}},
                                                "metric": "list"})),
        _reply(_tool_use("query_transactions", {"filters": {"months": {"last_n": 3}}, "metric": "max"}, "c2")),
        _reply(_tool_use("respond", {"text": "Done."}, "c3")),
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
    job_repo = FakeJobRepo()
    monkeypatch.setattr(ai_chat, "JobRepository", lambda: job_repo)
    for name in ("TransactionRepository", "CategoryRepository", "BudgetRepository", "PayCycleRepository"):
        monkeypatch.setattr(ai_chat, name, lambda: object())
    monkeypatch.setattr(ai_chat, "load_chat_data", lambda *repos: _data(ai_chat))
    return job_repo


EVENT = {"jobId": "job1", "messages": [{"role": "user", "text": "Average eating out?"}]}


def test_worker_stores_the_reply_as_json_and_succeeds(ai_chat, monkeypatch, worker):
    monkeypatch.setattr(ai_chat, "post_messages", ScriptedModel([
        _reply(_tool_use("query_transactions", AVG_QUERY)),
        _reply(_tool_use("respond", GOOD_ANSWER, "c2")),
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


def test_worker_marks_any_other_failure_failed(ai_chat, monkeypatch, worker):
    def broken(*repos):
        raise RuntimeError("db down")
    monkeypatch.setattr(ai_chat, "load_chat_data", broken)
    assert ai_chat.lambda_handler(EVENT, FakeContext())["status"] == "failed"
    assert worker.finished[0]["error"] == "could not answer"


def test_load_chat_data_fetches_back_to_the_lookback_floor(ai_chat, monkeypatch):
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: __import__("datetime").date(2026, 9, 20))

    class BudgetRepo:
        def list_budgets(self):
            return {}

    class TransactionRepo:
        def __init__(self):
            self.calls = []

        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
            self.calls.append((start, end))
            return [], None

    transaction_repo = TransactionRepo()
    data = ai_chat.load_chat_data(
        transaction_repo, _FakeCategoryRepo(CATEGORIES), BudgetRepo(), _FakePayCycleRepo(length=14, last_pay_date="2026-09-10"))
    assert data.floor == "2025-09-01" and data.today == TODAY
    assert transaction_repo.calls[0] == ("2025-09-01", TODAY)


def test_load_chat_data_works_out_budgets_from_its_own_read_without_saving(ai_chat, monkeypatch):
    # WHIT-622: the chat shows the same budget rows as /budgets (rollover included) from its one
    # transaction read, and never writes the settlements — only GET /budgets saves those.
    import spend
    monkeypatch.setattr(spend, "melbourne_today", lambda: __import__("datetime").date(2026, 9, 20))

    class BudgetRepo:
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

    def row(txn_id, amount, day):
        return {"transaction_id": txn_id, "account_id": "up-spending", "category": "groceries",
                "amount": Decimal(amount), "status": "posted", "counts_to_budget": True, "date": day}

    stored = [row("old", "-500", "2025-10-01"), row("prior", "-60", "2026-08-30"),
              row("now", "-25", "2026-09-15")]

    class TransactionRepo:
        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
            if account_id != "up-spending":
                return [], None
            return [r for r in stored if start <= r["date"] <= end], None

    budget_repo = BudgetRepo()
    data = ai_chat.load_chat_data(
        TransactionRepo(), _FakeCategoryRepo(CATEGORIES), budget_repo, _FakePayCycleRepo(length=14, last_pay_date="2026-09-10"))

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
        _reply(_tool_use("get_budgets", {"pay_cycle": {"cycles_back": 2}})),
        _reply(_tool_use("respond", {"text": "Sorted."}, "c2")),
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
        _reply(_tool_use("query_transactions", AVG_QUERY)),
        _reply(_tool_use("respond", GOOD_ANSWER, "c2")),
    ], seconds_left=lambda: 1000)
    assert [request["timeout"] for request in model.requests] == [60, 60]


def test_too_little_time_left_fails_before_calling_the_model(ai_chat, monkeypatch):
    model = ScriptedModel([_reply(_tool_use("respond", GOOD_ANSWER))])
    monkeypatch.setattr(ai_chat, "post_messages", model)
    # 19.9s left - 10s margin = 9.9s, just under the 10s minimum for a call.
    with pytest.raises(ai_chat.ChatError):
        ai_chat.run_chat("job1", EVENT["messages"], _data(ai_chat), FakeJobRepo(), lambda: 19.9)
    assert model.requests == []
