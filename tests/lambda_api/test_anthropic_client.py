"""Tests for the shared Anthropic client (WHIT-388).

Direct unit tests for the plumbing extracted out of insights_ai / milestone_ai:
the request build + headers, the error taxonomy, key caching, first-text-block
extraction, and the first-{...}-span JSON parse. urllib.request.urlopen is
monkeypatched — no network, no AWS. The `anthropic_client` fixture imports the
module in isolation and pins a fake key.
"""

import io
import json
import urllib.error

import pytest

from _anthropic_fakes import FakeResponse, messages_payload


# --- post: request shape + success -------------------------------------------


def test_post_builds_request_and_returns_first_text(anthropic_client, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = req.headers
        captured["body"] = json.loads(req.data.decode())
        captured["timeout"] = timeout
        return FakeResponse(messages_payload([{"type": "text", "text": "hello"}]))

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", fake_urlopen)

    text = anthropic_client.post("SYS", "Prefix:\n", {"a": 1})

    assert text == "hello"
    assert captured["url"].endswith("/v1/messages")
    # urllib title-cases header keys. The Cloudflare-load-bearing UA + key + version.
    assert captured["headers"]["X-api-key"] == "test-anthropic-key"
    assert captured["headers"]["Anthropic-version"]
    assert captured["headers"]["User-agent"] == "abundo-app-api"
    # System prompt + prefix + compact-JSON model_input reach the model.
    assert captured["body"]["system"] == "SYS"
    assert captured["body"]["messages"][0]["content"] == 'Prefix:\n{"a":1}'
    # Thinking disabled so a single-shot JSON reply can't be truncated by reasoning.
    assert captured["body"]["thinking"] == {"type": "disabled"}
    assert captured["timeout"] == anthropic_client.ANTHROPIC_TIMEOUT_SECONDS


def test_post_returns_first_text_block_when_several(anthropic_client, monkeypatch):
    monkeypatch.setattr(
        anthropic_client.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(messages_payload([
            {"type": "thinking", "text": "ignored"},
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
        ])))
    assert anthropic_client.post("s", "p", {}) == "first"


def test_post_returns_empty_string_when_no_text_block(anthropic_client, monkeypatch):
    # A malformed/empty envelope degrades to "" so the caller's parser soft-fails
    # rather than the endpoint 500ing.
    monkeypatch.setattr(
        anthropic_client.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(messages_payload([])))
    assert anthropic_client.post("s", "p", {}) == ""

    monkeypatch.setattr(
        anthropic_client.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse({"content": None}))
    assert anthropic_client.post("s", "p", {}) == ""


# --- post: error taxonomy ----------------------------------------------------


def test_post_http_error_raises_with_status(anthropic_client, monkeypatch):
    def boom(req, timeout=None):
        raise urllib.error.HTTPError("u", 429, "rate", None, io.BytesIO(b""))

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", boom)
    with pytest.raises(anthropic_client.AnthropicError) as ei:
        anthropic_client.post("s", "p", {})
    assert ei.value.upstream_status == 429


def test_post_url_error_is_none_status(anthropic_client, monkeypatch):
    def boom(req, timeout=None):
        raise urllib.error.URLError("down")

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", boom)
    with pytest.raises(anthropic_client.AnthropicError) as ei:
        anthropic_client.post("s", "p", {})
    assert ei.value.upstream_status is None


def test_post_non_json_envelope_is_none_status(anthropic_client, monkeypatch):
    # A 2xx body that isn't JSON -> json.loads raises ValueError -> AnthropicError(None),
    # never an uncaught 500.
    class _BadBody:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b"not json at all"

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen",
                        lambda req, timeout=None: _BadBody())
    with pytest.raises(anthropic_client.AnthropicError) as ei:
        anthropic_client.post("s", "p", {})
    assert ei.value.upstream_status is None


def test_post_ssm_failure_degrades_to_anthropic_error(anthropic_client, monkeypatch):
    # A missing/denied SSM key raises ValueError inside get_api_key(); it must surface as
    # AnthropicError(None) (-> 502), never an uncaught 500, and urlopen must never run.
    def unreachable(req, timeout=None):
        raise AssertionError("urlopen must not run when the key can't be read")

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", unreachable)
    monkeypatch.setattr(anthropic_client, "get_param",
                        lambda path: (_ for _ in ()).throw(ValueError("no such param")))
    anthropic_client._api_key = None

    with pytest.raises(anthropic_client.AnthropicError) as ei:
        anthropic_client.post("s", "p", {})
    assert ei.value.upstream_status is None


# --- get_api_key: caching ----------------------------------------------------


def test_get_api_key_is_cached(anthropic_client, monkeypatch):
    calls = []
    monkeypatch.setattr(anthropic_client, "get_param", lambda path: calls.append(path) or "k")
    anthropic_client._api_key = None
    assert anthropic_client.get_api_key() == "k"
    anthropic_client.get_api_key()
    assert len(calls) == 1  # SSM read once, then served from the module cache


# --- extract_first_json ------------------------------------------------------


def test_extract_first_json_from_prose(anthropic_client):
    parsed = anthropic_client.extract_first_json('Sure!\n{"a": 1, "b": [2]}\nHope that helps.')
    assert parsed == {"a": 1, "b": [2]}


def test_extract_first_json_no_braces_is_none(anthropic_client):
    assert anthropic_client.extract_first_json("just prose, no object here") is None


def test_extract_first_json_empty_or_none_text_is_none(anthropic_client):
    assert anthropic_client.extract_first_json("") is None
    assert anthropic_client.extract_first_json(None) is None


def test_extract_first_json_bad_json_is_none(anthropic_client):
    # A {...} span that isn't valid JSON -> None, never a crash.
    assert anthropic_client.extract_first_json("{not: valid, json}") is None
