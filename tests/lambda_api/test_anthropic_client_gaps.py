"""WHIT-388 adversarial GAP tests for the shared Anthropic client.

Covers what the implementer's test_anthropic_client.py leaves open:
 - request-body parity the originals shipped but no test pins: model + max_tokens.
 - the compact-JSON separators contract's COMMA (their single-key dict only proves ':').
 - extract_first_json's GREEDY first-{ .. last-} span — behaviour parity with the 3
   originals (multi-object / array-wrapped -> None; nested -> full outer object).
 - post's tolerance of a text block that is MISSING the "text" key.
 - the "one file owns AnthropicError" done-criterion: handler catches the exact class
   the shared client raises.

urllib.request.urlopen is monkeypatched — no network, no AWS. Reuses the
`anthropic_client` / `handler` fixtures from conftest.
"""

import json


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode() if payload is not None else b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _payload(content):
    return {"content": content}


# --- request-body parity: model + max_tokens ---------------------------------
# [A-G1] The originals shipped model + a 700-token cap in every body. The shared
# client's own suite asserts headers/thinking/timeout but NOT these two, so dropping
# either would ship silently. Assert against the module's real constants.


def test_post_body_carries_model_and_max_tokens(anthropic_client, monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data.decode())
        return _FakeResponse(_payload([{"type": "text", "text": "ok"}]))

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
        return _FakeResponse(_payload([{"type": "text", "text": "ok"}]))

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
        lambda req, timeout=None: _FakeResponse(_payload([{"type": "text"}])))
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
# escape the except and 500. insights_ai / milestone_ai must not re-derive their own.


def test_handler_shares_the_shared_anthropic_error(handler):
    import anthropic_client as ac
    import insights_ai
    import milestone_ai

    assert handler.AnthropicError is ac.AnthropicError
    # Neither caller re-declares its own copy (they delegate to the shared one).
    assert getattr(insights_ai, "AnthropicError", ac.AnthropicError) is ac.AnthropicError
    assert getattr(milestone_ai, "AnthropicError", ac.AnthropicError) is ac.AnthropicError
