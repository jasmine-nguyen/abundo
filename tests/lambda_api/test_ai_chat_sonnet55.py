"""WHIT-807: the chat tool loop on Sonnet 5.5.

No forced tool_choice: on the last round the loop adds a system turn telling the model to call
respond now. Thinking blocks in a reply go back to the model unchanged, and a refusal fails the
job even if the reply also carries an answer. post_messages is replaced by the shared ScriptedModel.
"""

import pytest

from _anthropic_fakes import ScriptedModel, tool_reply, tool_use_block
from _job_fakes import FakeChatJobRepo

TODAY = "2026-09-20"
CYCLE_START = "2026-09-10"
CATEGORIES = [{"id": "groceries", "name": "Groceries", "bucket": "Living", "parent": None, "colorSlot": 11}]
QUESTION = [{"role": "user", "text": "What are my categories?"}]
THINKING = {"type": "thinking", "thinking": "Look up the categories first.", "signature": "sig-1"}


def _data():
    import chat_tools
    return chat_tools.ChatData(
        categories=CATEGORIES, budgets={}, cycle_start=CYCLE_START, length=14, today=TODAY,
        floor=chat_tools.lookback_floor(CYCLE_START, 14, TODAY), transactions=[])


def _run(ai_chat, monkeypatch, replies):
    model = ScriptedModel(replies)
    monkeypatch.setattr(ai_chat, "post_messages", model)
    reply = ai_chat.run_chat("job1", QUESTION, _data(), FakeChatJobRepo(), lambda: 200)
    return reply, model


def test_last_round_asks_for_an_answer_and_thinking_blocks_go_back_unchanged(ai_chat, monkeypatch):
    rounds = ai_chat.CHAT_MAX_TOOL_ROUNDS
    first_content = [THINKING, tool_use_block("get_categories", {}, "c0")]
    replies = [{"content": first_content, "stop_reason": "tool_use"}]
    replies += [tool_reply(tool_use_block("get_categories", {}, f"c{i}")) for i in range(1, rounds - 1)]
    replies.append(tool_reply(tool_use_block("respond", {"text": "You have one category."}, "last")))

    reply, model = _run(ai_chat, monkeypatch, replies)

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


@pytest.mark.parametrize("bad_reply", [
    tool_reply(tool_use_block("respond", {"text": "Here you go."}), stop_reason="refusal"),
    tool_reply({"type": "text", "text": "Your categories are Groceries."}, stop_reason="end_turn"),
], ids=["refusal", "no tool call"])
def test_a_refusal_or_a_reply_without_a_tool_call_fails_the_job(ai_chat, monkeypatch, bad_reply):
    with pytest.raises(ai_chat.ChatError):
        _run(ai_chat, monkeypatch, [bad_reply])
