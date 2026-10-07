"""WHIT-807 QA: edges of the Sonnet 5.5 move the proof tests leave open.

The chat call's token log must never carry the chat text, the final-round system turn must follow
a user turn even when the first round is the last, and the trimmed chat prompt keeps its rules.
"""

import logging

import pytest

from _anthropic_fakes import ScriptedModel, capture_urlopen, tool_reply, tool_use_block
from _job_fakes import FakeChatJobRepo

SENTINEL = "SENTINEL-CHAT-TEXT"


def test_a_chat_call_logs_token_counts_but_never_the_chat_text(anthropic_client, monkeypatch, caplog):  # [A2]
    reply = {
        "model": "claude-sonnet-5-5-20261001",
        "stop_reason": "tool_use",
        "content": [{"type": "thinking", "thinking": SENTINEL, "signature": "s"},
                    {"type": "text", "text": SENTINEL}],
        "usage": {"input_tokens": 9876, "output_tokens": 54},
    }
    capture_urlopen(anthropic_client, monkeypatch, reply)
    messages = [{"role": "user", "content": f"How much on {SENTINEL}?"}]

    with caplog.at_level(logging.INFO):
        assert anthropic_client.post_messages(SENTINEL, messages, [], 10, 5) == reply

    logged = [record.getMessage() for record in caplog.records]
    assert any("9876" in line and "54" in line and "claude-sonnet-5-5-20261001" in line for line in logged)
    assert all(SENTINEL not in line for line in logged)


@pytest.mark.parametrize("history", [
    [{"role": "user", "text": "Hi?"}],
    [{"role": "assistant", "text": "Insights summary."}, {"role": "user", "text": "Why?"}],
], ids=["one question", "insights seed"])
def test_with_one_round_the_nudge_follows_the_users_question(ai_chat, monkeypatch, history):  # [A3]
    import chat_tools
    monkeypatch.setattr(ai_chat, "CHAT_MAX_TOOL_ROUNDS", 1)
    model = ScriptedModel([tool_reply(tool_use_block("respond", {"text": "Hello."}))])
    monkeypatch.setattr(ai_chat, "post_messages", model)
    data = chat_tools.ChatData(
        categories=[], budgets={}, cycle_start="2026-09-10", length=14, today="2026-09-20",
        floor=chat_tools.lookback_floor("2026-09-10", 14, "2026-09-20"), transactions=[])

    assert ai_chat.run_chat("job1", history, data, FakeChatJobRepo(), lambda: 200) == {"text": "Hello."}

    roles = [message["role"] for message in model.requests[0]["messages"]]
    assert roles[-2:] == ["user", "system"]
    assert roles.count("system") == 1


@pytest.mark.parametrize("rule", [
    "copied exactly",
    "No investment, tax or credit advice",
    "Don't mention tools or internal ids",
    "Always finish by calling `respond`",
])
def test_the_trimmed_chat_prompt_keeps_its_safety_rules(ai_chat, rule):  # [A4]
    assert rule in ai_chat.system_prompt("2026-09-20")
