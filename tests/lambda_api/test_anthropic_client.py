"""Tests for the shared Anthropic client (WHIT-388).

Direct unit tests for the plumbing extracted out of insights_ai:
the request build + headers, the error taxonomy, key caching, and first-text-block
extraction. urllib.request.urlopen is
monkeypatched — no network, no AWS. The `anthropic_client` fixture imports the
module in isolation and pins a fake key.
"""

import logging
import urllib.error

import pytest

from _anthropic_fakes import capture_urlopen, messages_payload
from _http_fakes import FakeResponse, http_error


# --- post: request shape + success -------------------------------------------


def test_post_builds_request_and_returns_first_text(anthropic_client, monkeypatch):
    captured = capture_urlopen(anthropic_client, monkeypatch,
                               messages_payload([{"type": "text", "text": "hello"}]))

    text = anthropic_client.post("SYS", "Prefix:\n", {"a": 1}, {})

    assert text == "hello"
    assert captured["url"].endswith("/v1/messages")
    # urllib title-cases header keys. The Cloudflare-load-bearing UA + key + version.
    assert captured["headers"]["X-api-key"] == "test-anthropic-key"
    assert captured["headers"]["Anthropic-version"]
    assert captured["headers"]["User-agent"] == "abundo-app-api"
    # System prompt + prefix + compact-JSON model_input reach the model.
    assert captured["body"]["system"] == "SYS"
    assert captured["body"]["messages"][0]["content"] == 'Prefix:\n{"a":1}'
    assert captured["body"]["thinking"] == {"type": "between_tools"}
    assert captured["headers"]["Anthropic-beta"] == "server-side-fallback-2026-07-01"
    assert captured["timeout"] == anthropic_client.ANTHROPIC_TIMEOUT_SECONDS


def test_post_returns_first_text_block_when_several(anthropic_client, monkeypatch):
    monkeypatch.setattr(
        anthropic_client.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(messages_payload([
            {"type": "thinking", "text": "ignored"},
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
        ])))
    assert anthropic_client.post("s", "p", {}, {}) == "first"


def test_post_returns_empty_string_when_no_text_block(anthropic_client, monkeypatch):
    # A malformed/empty envelope degrades to "" so the caller's parser soft-fails
    # rather than the endpoint 500ing.
    monkeypatch.setattr(
        anthropic_client.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(messages_payload([])))
    assert anthropic_client.post("s", "p", {}, {}) == ""

    monkeypatch.setattr(
        anthropic_client.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse({"content": None}))
    assert anthropic_client.post("s", "p", {}, {}) == ""


# --- post: error taxonomy ----------------------------------------------------


def test_post_http_error_raises_with_status(anthropic_client, monkeypatch):
    def boom(req, timeout=None):
        raise http_error(429)

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", boom)
    with pytest.raises(anthropic_client.AnthropicError) as ei:
        anthropic_client.post("s", "p", {}, {})
    assert ei.value.upstream_status == 429


def _raise_url_error(monkeypatch, anthropic_client):
    def boom(req, timeout=None):
        raise urllib.error.URLError("down")
    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", boom)


def _raise_bare_timeout(monkeypatch, anthropic_client):
    # urllib wraps connect errors in URLError, but a timeout while WAITING for the reply is bare.
    def slow(req, timeout=None):
        raise TimeoutError("timed out")
    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", slow)


def _fail_the_ssm_key_read(monkeypatch, anthropic_client):
    def unreachable(req, timeout=None):
        raise AssertionError("urlopen must not run when the key can't be read")

    import api_key
    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", unreachable)
    monkeypatch.setattr(api_key, "get_param", lambda path: (_ for _ in ()).throw(ValueError("no such param")))


@pytest.mark.parametrize("fail", [_raise_url_error, _raise_bare_timeout, _fail_the_ssm_key_read],
                         ids=["url-error", "bare-timeout", "ssm-key-read-fails"])
def test_transport_and_key_failures_are_anthropic_error_with_no_status(anthropic_client, monkeypatch, fail):
    # Callers catch only AnthropicError (-> 502); anything else would 500.
    fail(monkeypatch, anthropic_client)
    with pytest.raises(anthropic_client.AnthropicError) as ei:
        anthropic_client.post("s", "p", {}, {})
    assert ei.value.upstream_status is None


# --- get_api_key -------------------------------------------------------------


def test_get_api_key_reads_the_anthropic_path(anthropic_client, monkeypatch):
    # The wrapper must pass the ANTHROPIC key path to the shared fetch — the two
    # lambda_api callers share one process, so the wrong path would fetch the
    # BankSync key instead (WHIT-454). Caching itself is covered in tests/shared.
    import api_key
    calls = []
    monkeypatch.setattr(api_key, "get_param", lambda path: calls.append(path) or "k")
    assert anthropic_client.get_api_key() == "k"
    assert calls == [anthropic_client.ANTHROPIC_API_KEY_PATH]


# --- post_messages: the chat's tool-calling request (card 609) --------------------------------


def test_post_messages_sends_tools_and_returns_the_whole_reply(anthropic_client, monkeypatch):
    envelope = {"content": [{"type": "tool_use", "id": "c1", "name": "respond", "input": {"text": "hi"}}],
                "stop_reason": "tool_use"}
    captured = capture_urlopen(anthropic_client, monkeypatch, envelope)
    tools = [{"name": "respond", "input_schema": {"type": "object"}}]
    messages = [{"role": "user", "content": "q"}]

    reply = anthropic_client.post_messages("SYS", messages, tools, 1500, 60)

    assert reply == envelope
    assert captured["body"]["messages"] == messages
    assert captured["body"]["tools"] == tools
    assert captured["body"]["tool_choice"] == {"type": "auto"}
    assert captured["body"]["max_tokens"] == 1500
    assert captured["body"]["thinking"] == {"type": "between_tools"}
    assert captured["timeout"] == 60
    assert captured["headers"]["User-agent"] == "abundo-app-api"


# --- WHIT-807: Sonnet 5.5 -------------------------------------------------------------------


SCHEMA = {"type": "object"}
CHAT_MESSAGES = [{"role": "user", "content": "q"}]
TOOLS = [{"name": "respond", "description": "d", "input_schema": {"type": "object"}}]


@pytest.mark.parametrize("call, extra", [
    (lambda client: client.post("SYS", "Prefix:\n", {"a": 1}, SCHEMA),
     {"output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}}}),
    (lambda client: client.post_messages("SYS", CHAT_MESSAGES, TOOLS, 10, 5),
     {"output_config": {"effort": "low"}, "tool_choice": {"type": "auto"}, "tools": TOOLS}),
], ids=["tips post", "chat post_messages"])
def test_every_request_uses_the_sonnet_5_5_shape(anthropic_client, monkeypatch, call, extra):
    captured = capture_urlopen(anthropic_client, monkeypatch, messages_payload([{"type": "text", "text": "{}"}]))

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
    capture_urlopen(anthropic_client, monkeypatch, refusal)

    with caplog.at_level(logging.INFO):
        result = anthropic_client.post("SYS", f"{sentinel}:\n", {"note": sentinel}, SCHEMA)

    assert result == ""
    usage_lines = [record.getMessage() for record in caplog.records if "4321" in record.getMessage()]
    assert len(usage_lines) == 1
    assert "87" in usage_lines[0]
    # The model named in the log is the one that answered (from the reply envelope).
    assert "claude-sonnet-5-5-20261001" in usage_lines[0]
    assert all(sentinel not in record.getMessage() for record in caplog.records)
