"""WHIT-612 — the chat worker shares one time budget across its model calls.

Each model call gets min(60s, time left - 10s margin); with under 10s of call time left the run
fails cleanly before paying for a call it couldn't finish.
"""

import pytest


class FakeJobRepo:
    def __init__(self):
        self.statuses = []
        self.finished = []

    def set_tool_status(self, job_id, text):
        self.statuses.append(text)

    def finish_chat_job(self, job_id, status, reply_json=None, error=None):
        self.finished.append({"status": status, "reply": reply_json, "error": error})


class ScriptedModel:
    """Plays back one reply per call and records the timeout each call was given."""

    def __init__(self, replies):
        self._replies = list(replies)
        self.timeouts = []

    def __call__(self, system, messages, tools, tool_choice, max_tokens, timeout):
        self.timeouts.append(timeout)
        return self._replies.pop(0)


class FakeContext:
    def __init__(self, remaining_ms=200_000):
        self.remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self):
        return self.remaining_ms


def _tool_use(name, tool_input, call_id):
    return {"content": [{"type": "tool_use", "id": call_id, "name": name, "input": tool_input}],
            "stop_reason": "tool_use"}


def _data():
    import chat_tools
    categories = [{"id": "eatingout", "name": "Eating Out", "bucket": "Lifestyle", "parent": None,
                   "colorSlot": 0}]
    return chat_tools.ChatData(
        categories=categories, budgets={}, cycle_start="2026-09-10", length=14, today="2026-09-20",
        floor=chat_tools.lookback_floor("2026-09-10", 14, "2026-09-20"), transactions=[])


def _clock(*readings):
    remaining = list(readings)
    return lambda: remaining.pop(0)


def test_each_model_call_gets_the_time_left_and_fails_cleanly_when_it_runs_out(ai_chat, monkeypatch):
    model = ScriptedModel([
        _tool_use("get_categories", {}, "c1"),
        _tool_use("get_categories", {}, "c2"),
        _tool_use("respond", {"text": "never reached"}, "c3"),
    ])
    monkeypatch.setattr(ai_chat, "post_messages", model)

    # 200s left → capped at 60s; 45s left → 45 - 10 margin = 35s; 15s left → under the 10s minimum.
    with pytest.raises(ai_chat.ChatError):
        ai_chat.run_chat("job1", [{"role": "user", "text": "What are my categories?"}], _data(),
                         FakeJobRepo(), _clock(200, 45, 15))

    assert model.timeouts == [60, 35]


def test_worker_with_almost_no_time_left_marks_the_job_could_not_answer(ai_chat, monkeypatch):
    job_repo = FakeJobRepo()
    monkeypatch.setattr(ai_chat, "JobRepository", lambda: job_repo)
    for name in ("TransactionRepository", "CategoryRepository", "BudgetRepository", "PayCycleRepository"):
        monkeypatch.setattr(ai_chat, name, lambda: object())
    monkeypatch.setattr(ai_chat, "load_chat_data", lambda *repos: _data())
    model = ScriptedModel([_tool_use("respond", {"text": "Hi"}, "c1")])
    monkeypatch.setattr(ai_chat, "post_messages", model)

    event = {"jobId": "job1", "messages": [{"role": "user", "text": "Average eating out?"}]}
    result = ai_chat.lambda_handler(event, FakeContext(remaining_ms=5_000))

    assert result == {"jobId": "job1", "status": "failed"}
    assert job_repo.finished == [{"status": "failed", "reply": None, "error": "could not answer"}]
    assert model.timeouts == []
