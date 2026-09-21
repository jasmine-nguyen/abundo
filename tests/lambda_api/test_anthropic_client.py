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

    import api_key
    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", unreachable)
    monkeypatch.setattr(api_key, "get_param",
                        lambda path: (_ for _ in ()).throw(ValueError("no such param")))

    with pytest.raises(anthropic_client.AnthropicError) as ei:
        anthropic_client.post("s", "p", {})
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


# === WHIT-388 adversarial gaps (folded from test_anthropic_client_gaps.py) — request-body
# parity (model + max_tokens), the compact-JSON comma, a text block missing "text", the greedy
# extract_first_json span, and the shared-AnthropicError done-criterion. ====================


# --- request-body parity: model + max_tokens ---------------------------------
# [A-G1] The originals shipped model + a 700-token cap in every body. The shared
# client's own suite asserts headers/thinking/timeout but NOT these two, so dropping
# either would ship silently. Assert against the module's real constants.


def test_post_body_carries_model_and_max_tokens(anthropic_client, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data.decode())
        return FakeResponse(messages_payload([{"type": "text", "text": "ok"}]))

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", fake_urlopen)
    anthropic_client.post("SYS", "P:\n", {"a": 1})

    assert captured["body"]["model"] == anthropic_client.ANTHROPIC_MODEL
    assert captured["body"]["max_tokens"] == anthropic_client.ANTHROPIC_MAX_TOKENS


# --- compact-JSON separators: the COMMA, not just the colon ------------------
# [A-G2] json.dumps default is (", ", ": ") — spaces after BOTH. The implementer's
# single-key {"a":1} only proves no space after ':'. A 2-key input proves the comma
# is compact too; dropping separators=(",", ":") reintroduces "…1, \"b\"…".


def test_post_user_turn_is_compact_json_including_commas(anthropic_client, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["content"] = json.loads(req.data.decode())["messages"][0]["content"]
        return FakeResponse(messages_payload([{"type": "text", "text": "ok"}]))

    monkeypatch.setattr(anthropic_client.urllib.request, "urlopen", fake_urlopen)
    anthropic_client.post("s", "P:\n", {"a": 1, "b": 2})

    assert captured["content"] == 'P:\n{"a":1,"b":2}'
    assert ", " not in captured["content"]
    assert ": " not in captured["content"].split("\n", 1)[1]  # ignore the prefix's own ":\n"


# --- post: a text block missing the "text" key -------------------------------
# [A-G3] block.get("type") == "text" but no "text" key -> "" (the .get default), never
# a KeyError. block["text"] would 500 here.


def test_post_text_block_without_text_key_returns_empty(anthropic_client, monkeypatch):
    monkeypatch.setattr(
        anthropic_client.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse(messages_payload([{"type": "text"}])))
    assert anthropic_client.post("s", "p", {}) == ""


# --- extract_first_json: GREEDY span parity with the 3 originals -------------
# The originals all used re.search(r"\{.*\}", text, DOTALL) — GREEDY: first "{" to the
# LAST "}". A non-greedy "fix" (\{.*?\}) would silently change all three callers.


def test_extract_first_json_multiple_objects_is_none(anthropic_client):
    # [A-G4] first-{ to last-} spans BOTH objects -> invalid JSON -> None (not the first).
    assert anthropic_client.extract_first_json('{"a":1} {"b":2}') is None
    assert anthropic_client.extract_first_json('x {"a":1} y {"b":2} z') is None


def test_extract_first_json_nested_object_returns_full_outer(anthropic_client):
    # [A-G5] greedy captures the WHOLE outer object, not the inner one. A non-greedy
    # regex would grab '{"outer": {"inner": 1}' -> invalid -> None.
    assert anthropic_client.extract_first_json('{"outer": {"inner": 1}}') == {"outer": {"inner": 1}}


def test_extract_first_json_array_wrapped_object_is_none(anthropic_client):
    # [A-G6] a top-level JSON ARRAY: the span is '{"a":1},{"b":2}' (brace-to-brace,
    # dropping the [ ]) -> invalid -> None. Parity with the originals' brace-only search.
    assert anthropic_client.extract_first_json('[{"a":1},{"b":2}]') is None


# --- done-criterion: one file owns AnthropicError ----------------------------
# [A-G7] "handler.py imports AnthropicError from the new module." The class the handler
# catches must BE the class the shared client raises, else a real upstream error would
# escape the except and 500. insights_ai must not re-derive its own.


def test_handler_shares_the_shared_anthropic_error(handler):
    import anthropic_client as ac
    import insights_ai

    assert handler.AnthropicError is ac.AnthropicError
    # The caller doesn't re-declare its own copy (it delegates to the shared one).
    assert getattr(insights_ai, "AnthropicError", ac.AnthropicError) is ac.AnthropicError
