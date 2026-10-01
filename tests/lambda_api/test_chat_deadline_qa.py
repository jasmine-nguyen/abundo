"""WHIT-612 QA: the edges of the chat worker's shared time budget."""

import json

import pytest


class _JobRepo:
    def __init__(self):
        self.finished = []

    def set_tool_status(self, job_id, text):
        pass

    def finish_chat_job(self, job_id, status, reply_json=None, error=None):
        self.finished.append({"status": status, "reply": reply_json, "error": error})


class _Model:
    def __init__(self, replies):
        self._replies = list(replies)
        self.timeouts = []

    def __call__(self, system, messages, tools, tool_choice, max_tokens, timeout):
        self.timeouts.append(timeout)
        return self._replies.pop(0)


class _Context:
    def __init__(self, remaining_ms):
        self.remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self):
        return self.remaining_ms


def _respond(text="Hi"):
    return {"content": [{"type": "tool_use", "id": "c1", "name": "respond", "input": {"text": text}}],
            "stop_reason": "tool_use"}


def _data():
    import chat_tools
    categories = [{"id": "eatingout", "name": "Eating Out", "bucket": "Lifestyle", "parent": None,
                   "colorSlot": 0}]
    return chat_tools.ChatData(
        categories=categories, budgets={}, cycle_start="2026-09-10", length=14, today="2026-09-20",
        floor=chat_tools.lookback_floor("2026-09-10", 14, "2026-09-20"), transactions=[])


@pytest.fixture
def worker(ai_chat, monkeypatch):
    job_repo = _JobRepo()
    monkeypatch.setattr(ai_chat, "JobRepository", lambda: job_repo)
    for name in ("TransactionRepository", "CategoryRepository", "BudgetRepository", "PayCycleRepository"):
        monkeypatch.setattr(ai_chat, name, lambda: object())
    monkeypatch.setattr(ai_chat, "load_chat_data", lambda *repos: _data())
    return job_repo


EVENT = {"jobId": "job1", "messages": [{"role": "user", "text": "Average eating out?"}]}


def test_worker_gives_the_call_the_lambda_time_left_in_seconds(ai_chat, monkeypatch, worker):  # [A1]
    model = _Model([_respond()])
    monkeypatch.setattr(ai_chat, "post_messages", model)
    # 45,000 ms left → 45s - 10s margin = 35s for the call.
    assert ai_chat.lambda_handler(EVENT, _Context(45_000)) == {"jobId": "job1", "status": "succeeded"}
    assert model.timeouts == [35]
    assert json.loads(worker.finished[0]["reply"]) == {"text": "Hi"}


def test_exactly_the_minimum_call_time_left_still_makes_the_call(ai_chat, monkeypatch):  # [A2]
    model = _Model([_respond()])
    monkeypatch.setattr(ai_chat, "post_messages", model)
    exactly = ai_chat.CHAT_DEADLINE_MARGIN_SECONDS + ai_chat.CHAT_MIN_CALL_SECONDS
    reply = ai_chat.run_chat("job1", EVENT["messages"], _data(), _JobRepo(), lambda: exactly)
    assert reply == {"text": "Hi"}
    assert model.timeouts == [ai_chat.CHAT_MIN_CALL_SECONDS]


def test_the_per_call_cap_is_60_seconds(ai_chat, monkeypatch):  # [A3]
    model = _Model([_respond()])
    monkeypatch.setattr(ai_chat, "post_messages", model)
    ai_chat.run_chat("job1", EVENT["messages"], _data(), _JobRepo(), lambda: 205)
    assert model.timeouts == [60]
