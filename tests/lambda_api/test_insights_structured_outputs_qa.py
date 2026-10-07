"""QA edges for WHIT-779 (insights structured outputs + de-shouted prompt).

urllib.request.urlopen is faked — no network, no AWS.
"""

import json
import re

import pytest

from _anthropic_fakes import capture_urlopen, messages_payload, text_payload
from _insight_fakes import insight_puts, insight_repo


def _fake_reply(monkeypatch, envelope):
    import anthropic_client as ac
    return capture_urlopen(ac, monkeypatch, envelope)


def _assert_strict_object(schema):
    # Structured outputs need every object closed and every property required.
    if schema.get("type") == "object":
        assert schema["additionalProperties"] is False
        assert set(schema["required"]) == set(schema["properties"])
        for child in schema["properties"].values():
            _assert_strict_object(child)
    if schema.get("type") == "array":
        _assert_strict_object(schema["items"])


# [A1] (P0) the reply schema is a closed, fully-required object the API accepts.
def test_reply_schema_is_strict_and_json_serialisable(insights_ai):
    schema = insights_ai._REPLY_SCHEMA
    _assert_strict_object(schema)
    assert set(schema["properties"]) == {"summary", "suggestions"}
    assert json.loads(json.dumps(schema)) == schema


# [A2] (P0) a cut-off reply through the real endpoint → 502 "try again", nothing cached, no 500.
@pytest.mark.parametrize("reply_text", [
    '{"summary": "ok", "suggestions": ["a',
    '{"summary": "Solid cycle.", "suggestions": ["Cut coffee $20", ',
    '{"summary": "Solid',
    "",
])
def test_endpoint_truncated_reply_soft_fails_without_caching(handler, monkeypatch, reply_text):
    _fake_reply(monkeypatch, text_payload(reply_text))
    monkeypatch.setattr(handler, "assemble_insight_input", lambda *a: ({"categories": []}, "2026-06-25"))
    repo = insight_repo(existing=None)

    resp = handler.generate_ai_insights(None, None, None, None, repo)

    assert resp["statusCode"] == 502
    assert json.loads(resp["body"])["error"]
    assert insight_puts(repo) == []


# [A3] (P0) a schema-valid reply through the real endpoint → 200, cached, and the schema was sent.
def test_endpoint_valid_reply_is_served_and_cached(handler, monkeypatch, insights_ai):
    captured = _fake_reply(monkeypatch, text_payload(
        '{"summary": "Solid cycle.", "suggestions": ["Cut coffee $20"]}'))
    monkeypatch.setattr(handler, "assemble_insight_input", lambda *a: ({"categories": []}, "2026-06-25"))
    repo = insight_repo(existing=None)

    resp = handler.generate_ai_insights(None, None, None, None, repo)

    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["summary"] == "Solid cycle." and body["suggestions"] == ["Cut coffee $20"]
    assert len(insight_puts(repo)) == 1
    assert captured["body"]["output_config"]["format"]["schema"] == insights_ai._REPLY_SCHEMA


# [A4] (P1) no text block at all (e.g. a refusal envelope) → empty result, never raises.
def test_reply_with_no_text_block_degrades(insights_ai, monkeypatch):
    _fake_reply(monkeypatch, messages_payload([]))
    assert insights_ai.generate_suggestions({}) == {"summary": None, "suggestions": []}


# [A5] (P1) prose around the JSON is no longer dug out: the API enforces the shape, so the
# old {...}-span search is really gone.
def test_prose_wrapped_json_is_not_extracted_any_more(insights_ai, monkeypatch):
    _fake_reply(monkeypatch, text_payload('Sure!\n{"summary": "ok", "suggestions": ["a"]}\nBye.'))
    assert insights_ai.generate_suggestions({}) == {"summary": None, "suggestions": []}


# [A6] (P1) pretty-printed / whitespace-padded JSON still parses, with coercion kept.
def test_whitespace_padded_json_parses_and_coerces(insights_ai, monkeypatch):
    _fake_reply(monkeypatch, text_payload(
        '\n  {\n  "summary": "Good.",\n  "suggestions": ["a", "  ", "b"]\n}\n'))
    assert insights_ai.generate_suggestions({}) == {"summary": "Good.", "suggestions": ["a", "b"]}


# [A7] (P1) the prompt no longer asks for JSON in words and no longer shouts.
def test_system_prompt_drops_json_instruction_and_shouting(insights_ai):
    prompt = insights_ai._SYSTEM_PROMPT
    assert "Reply with" not in prompt
    assert '"summary":' not in prompt and "<tip>" not in prompt
    shouted = {"REAL", "ONLY", "TOTAL", "NOT", "ONE", "TWO", "IS", "NEVER"}
    assert shouted.isdisjoint(re.findall(r"\b[A-Z]{2,}\b", prompt))
    assert prompt.rstrip().endswith("do not mention the loan at all.")


# [A8] (P1) every rule survives the de-shouting.
@pytest.mark.parametrize("rule", [
    "Use only the numbers provided",
    "never round beyond cents",
    "total already summed across its child categories",
    "don't add it on top of the individual category rows",
    "never sum two \"budgeted_parents\" rows together",
    "for one or two suggestions",
    "use only the fields it actually contains",
    "the loan is on track",
    "never scale it up for larger amounts",
    "the loan will not be paid off",
    "don't mention a projected mortgage-free date",
    "Never mention a goal field that isn't present",
])
def test_system_prompt_keeps_every_rule(insights_ai, rule):
    assert rule in insights_ai._SYSTEM_PROMPT


# [A9] (P1) the chat's tool-calling request gets low effort but no output format.
def test_post_messages_sends_effort_but_no_output_format(anthropic_client, monkeypatch):
    captured = capture_urlopen(anthropic_client, monkeypatch, {"content": [], "stop_reason": "tool_use"})
    anthropic_client.post_messages("s", [{"role": "user", "content": "q"}], [], 10, 5)

    assert captured["body"]["output_config"] == {"effort": "low"}
    assert captured["body"]["tool_choice"] == {"type": "auto"}


# [A10] (P2) post sends the schema it was given verbatim (not a module default).
def test_post_forwards_each_callers_schema(anthropic_client, monkeypatch):
    captured = capture_urlopen(anthropic_client, monkeypatch, text_payload("{}"))
    first = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
    second = {"type": "object", "properties": {"n": {"type": "integer"}},
              "required": ["n"], "additionalProperties": False}
    schemas = []
    for schema in (first, second):
        anthropic_client.post("s", "p", {}, schema)
        schemas.append(captured["body"]["output_config"]["format"]["schema"])

    assert schemas == [first, second]
