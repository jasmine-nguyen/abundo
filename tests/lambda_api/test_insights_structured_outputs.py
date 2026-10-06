"""Acceptance tests for WHIT-779: insights asks the API for structured outputs.

  - anthropic_client.post sends the caller's reply schema as
    output_config.format, leaving model, max_tokens and thinking unchanged.
  - insights_ai.generate_suggestions sends its reply schema, parses a JSON reply,
    and degrades a truncated or non-JSON reply to the empty result.

urllib.request.urlopen is faked — no network, no AWS.
"""

import json

from _anthropic_fakes import messages_payload, text_payload
from _http_fakes import FakeResponse


def test_post_sends_the_reply_schema_as_structured_output(anthropic_client, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data.decode())
        return FakeResponse(messages_payload([{"type": "text", "text": '{"x": 1}'}]))

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", fake_urlopen)
    schema = {
        "type": "object",
        "properties": {"x": {"type": "integer"}},
        "required": ["x"],
        "additionalProperties": False,
    }

    text = anthropic_client.post("SYS", "Prefix:\n", {"a": 1}, schema)

    assert text == '{"x": 1}'
    body = captured["body"]
    assert body["output_config"] == {"format": {"type": "json_schema", "schema": schema}}
    assert body["model"] == "claude-sonnet-5"
    assert body["max_tokens"] == 700
    assert body["thinking"] == {"type": "disabled"}
    assert body["system"] == "SYS"
    assert body["messages"][0]["content"] == 'Prefix:\n{"a":1}'


def test_insights_request_a_schema_shaped_reply_and_degrade_on_bad_replies(insights_ai, monkeypatch):
    import anthropic_client as ac

    captured = {}
    reply = {"text": '{"summary": "Solid cycle.", "suggestions": ["Cut coffee $20", "Watch groceries"]}'}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data.decode())
        return FakeResponse(text_payload(reply["text"]))

    monkeypatch.setattr(ac.urllib.request, "urlopen", fake_urlopen)

    result = insights_ai.generate_suggestions({"cycle": {"length": 14}})

    assert result == {"summary": "Solid cycle.", "suggestions": ["Cut coffee $20", "Watch groceries"]}
    output_format = captured["body"]["output_config"]["format"]
    assert output_format["type"] == "json_schema"
    schema = output_format["schema"]
    assert schema == insights_ai._REPLY_SCHEMA
    assert schema["type"] == "object"
    assert schema["properties"]["summary"]["type"] == "string"
    assert schema["properties"]["suggestions"]["type"] == "array"
    assert schema["properties"]["suggestions"]["items"] == {"type": "string"}
    assert sorted(schema["required"]) == ["suggestions", "summary"]
    assert schema["additionalProperties"] is False
    # The prose JSON instruction is gone: the API enforces the shape now.
    assert "STRICT JSON" not in captured["body"]["system"]
    assert captured["body"]["thinking"] == {"type": "disabled"}

    # A reply cut off at max_tokens degrades to the empty result.
    reply["text"] = '{"summary": "ok", "suggestions": ["a'
    assert insights_ai.generate_suggestions({}) == {"summary": None, "suggestions": []}

    # So does a non-JSON reply.
    reply["text"] = "I could not analyse that."
    assert insights_ai.generate_suggestions({}) == {"summary": None, "suggestions": []}
