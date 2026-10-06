"""QA gap tests for WHIT-765: the shared helpers that replaced the server's copies.

Covers what the acceptance tests don't: banksync_request's defaults and error path,
push's Expo token going through the real shared api_key cache, and the exact
batch boundaries now that itertools.batched does the chunking.
"""

import json

import pytest

from _http_fakes import FakeResponse, http_error


def _capture_urlopen(module, monkeypatch, reply):
    captured = []

    def fake_urlopen(req, timeout=None):
        captured.append((req, timeout))
        return FakeResponse(reply(req) if callable(reply) else reply)

    monkeypatch.setattr(module.urllib.request, "urlopen", fake_urlopen)
    return captured


# [A1] (P0) default call is a GET with no body
def test_banksync_request_defaults_to_a_get_with_no_body(shared, monkeypatch):
    captured = _capture_urlopen(shared.balance_fetch, monkeypatch, {"success": True})

    shared.balance_fetch.banksync_request("https://example.test/x", "k", user_agent="ua", timeout=3)

    [(req, _timeout)] = captured
    assert req.get_method() == "GET"
    assert req.data is None


# [A2] (P0) an HTTP error reaches the caller (sync trigger's 409 skip depends on it)
def test_banksync_request_lets_http_errors_through(shared, monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise http_error(409)

    monkeypatch.setattr(shared.balance_fetch.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(shared.balance_fetch.urllib.error.HTTPError) as raised:
        shared.balance_fetch.banksync_request("https://example.test/x", "k", user_agent="ua", timeout=3)
    assert raised.value.code == 409


def _api_key_globals(push):
    """The globals of the api_key module push actually imported from."""
    return push.get_api_key.__globals__


# [A3] (P0) push's token comes from the shared cache: read once, from the Expo path
def test_push_access_token_is_read_once_through_the_shared_cache(shared, monkeypatch):
    push = shared.push
    api_key_globals = _api_key_globals(push)
    monkeypatch.setitem(api_key_globals, "_cache", {})
    reads = []
    monkeypatch.setitem(api_key_globals, "get_param", lambda path: reads.append(path) or "expo-pat")

    assert push.get_access_token() == "expo-pat"
    assert push.get_access_token() == "expo-pat"
    assert reads == [push.EXPO_ACCESS_TOKEN_PATH]


# [A4] (P1) the Expo token doesn't collide with another key cached in the same process
def test_push_access_token_does_not_reuse_another_paths_cached_value(shared, monkeypatch):
    push = shared.push
    api_key_globals = _api_key_globals(push)
    monkeypatch.setitem(api_key_globals, "_cache", {"/abundo/banksync-api-key": "banksync-key"})
    monkeypatch.setitem(api_key_globals, "get_param", lambda path: f"value-of-{path}")

    assert push.get_access_token() == f"value-of-{push.EXPO_ACCESS_TOKEN_PATH}"


# [A5] (P0) exactly a full batch of tokens → one Expo request; one more → a second with 1
@pytest.mark.parametrize(("extra", "sizes"), [(0, [100]), (1, [100, 1])])
def test_send_push_batches_at_exactly_the_expo_limit(shared, monkeypatch, extra, sizes):
    push = shared.push
    captured = _capture_urlopen(
        push, monkeypatch, lambda req: {"data": [{"status": "ok"}] * len(json.loads(req.data))},
    )
    tokens = [f"ExponentPushToken[{i}]" for i in range(push.EXPO_PUSH_BATCH_MAX + extra)]

    result = push.send_push("T", "B", tokens, access_token="k", device_repo=object(), receipt_repo=object())

    bodies = [json.loads(req.data) for req, _ in captured]
    assert [len(body) for body in bodies] == sizes
    assert [message["to"] for body in bodies for message in body] == tokens
    assert result == {"sent": len(tokens), "ok": len(tokens), "pruned": []}


# [A6] (P0) exactly 1000 receipt ids → one request; 1001 → a second with 1, ids sent as a JSON list
@pytest.mark.parametrize(("extra", "sizes"), [(0, [1000]), (1, [1000, 1])])
def test_get_receipts_batches_at_exactly_the_expo_limit(shared, monkeypatch, extra, sizes):
    push = shared.push
    captured = _capture_urlopen(
        push, monkeypatch, lambda req: {"data": {i: {"status": "ok"} for i in json.loads(req.data)["ids"]}},
    )
    ids = [f"r{i}" for i in range(push.EXPO_RECEIPTS_MAX + extra)]

    receipts = push.get_receipts(ids, access_token="k")

    bodies = [json.loads(req.data) for req, _ in captured]
    assert [len(body["ids"]) for body in bodies] == sizes
    assert all(isinstance(body["ids"], list) for body in bodies)
    assert sorted(receipts) == sorted(ids)
