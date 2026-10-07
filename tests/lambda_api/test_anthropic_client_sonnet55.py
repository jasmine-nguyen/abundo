"""WHIT-807: the Anthropic client speaks Sonnet 5.5.

Every request (tips `post` and chat `post_messages`) carries the Sonnet 5.5 shape: no `disabled`
thinking, no forced tool_choice, low effort, the server-side refusal fallback. A refusal gives the
tips caller an empty result, and each call logs its token counts but never the message text.
urllib.request.urlopen is faked; no network.
"""

import json
import logging

import pytest

from _anthropic_fakes import messages_payload
from _http_fakes import FakeResponse

SCHEMA = {"type": "object"}
CHAT_MESSAGES = [{"role": "user", "content": "q"}]
TOOLS = [{"name": "respond", "description": "d", "input_schema": {"type": "object"}}]


def _capture(anthropic_client, monkeypatch, payload):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["headers"] = req.headers
        captured["body"] = json.loads(req.data.decode())
        return FakeResponse(payload)

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", fake_urlopen)
    return captured


@pytest.mark.parametrize("call, extra", [
    (lambda client: client.post("SYS", "Prefix:\n", {"a": 1}, SCHEMA),
     {"output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}}}),
    (lambda client: client.post_messages("SYS", CHAT_MESSAGES, TOOLS, 10, 5),
     {"output_config": {"effort": "low"}, "tool_choice": {"type": "auto"}, "tools": TOOLS}),
], ids=["tips post", "chat post_messages"])
def test_every_request_uses_the_sonnet_5_5_shape(anthropic_client, monkeypatch, call, extra):
    captured = _capture(anthropic_client, monkeypatch, messages_payload([{"type": "text", "text": "{}"}]))

    call(anthropic_client)

    body = captured["body"]
    assert body["model"] == "claude-sonnet-5-5"
    assert body["thinking"] == {"type": "between_tools"}
    assert body["fallbacks"] == "default"
    for key, value in extra.items():
        assert body[key] == value
    # urllib title-cases header keys.
    assert captured["headers"]["Anthropic-beta"] == "server-side-fallback-2026-07-01"


def test_a_refusal_gives_tips_nothing_and_each_call_logs_counts_not_text(
        anthropic_client, monkeypatch, caplog):
    sentinel = "SENTINEL-PRIVATE-TEXT"
    refusal = {
        "model": "claude-sonnet-5-5-20261001",
        "stop_reason": "refusal",
        "content": [{"type": "text", "text": f'{{"summary": "{sentinel}"}}'}],
        "usage": {"input_tokens": 4321, "output_tokens": 87},
    }
    _capture(anthropic_client, monkeypatch, refusal)

    with caplog.at_level(logging.INFO):
        result = anthropic_client.post("SYS", f"{sentinel}:\n", {"note": sentinel}, SCHEMA)

    assert result == ""
    usage_lines = [record.getMessage() for record in caplog.records if "4321" in record.getMessage()]
    assert len(usage_lines) == 1
    assert "87" in usage_lines[0]
    # The model named in the log is the one that answered (from the reply envelope).
    assert "claude-sonnet-5-5-20261001" in usage_lines[0]
    assert all(sentinel not in record.getMessage() for record in caplog.records)
