"""Adversarial gap tests for the WHIT-139 receipt sweep's Expo poll (shared/push.py
get_receipts) — the boundaries the implementer's happy-path suite (test_push.py) leaves open.

Covers: [A20] data present WITH a top-level errors array still yields the data;
[A21] a later chunk's key overwrites an earlier chunk's (update() last-wins);
[A22] the unauthenticated (access_token="") poll sends no Authorization header.
No network: push.urllib.request.urlopen is monkeypatched.
"""

import json


class _FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


# WHIT-139 — [A20] a chunk with both `data` and a top-level `errors` array keeps the data
def test_get_receipts_data_alongside_errors_still_returns_data(shared, monkeypatch, caplog):
    # Expo can return resolved receipts in `data` AND a non-fatal `errors` array in the
    # same body. The errors are logged, but the data must NOT be dropped.
    push = shared.push
    body = {"data": {"rcpt-a": {"status": "ok"}},
            "errors": [{"code": "SOME_WARNING"}]}
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(body))
    out = push.get_receipts(["rcpt-a"], access_token="k")
    assert out == {"rcpt-a": {"status": "ok"}}   # data survived despite errors present


# WHIT-139 — [A21] a later chunk's key overwrites an earlier chunk's on merge
def test_get_receipts_later_chunk_overwrites_duplicate_key(shared, monkeypatch):
    # Merge is receipts.update(chunk) in ID order → last write wins for a repeated key.
    push = shared.push
    monkeypatch.setattr(push, "EXPO_RECEIPTS_MAX", 1)

    def fake_urlopen(req, timeout=None):
        ids = json.loads(req.data)["ids"]
        if ids == ["a"]:
            return _FakeResponse({"data": {"a": {"status": "ok"},
                                           "dup": {"status": "ok"}}})
        return _FakeResponse({"data": {"b": {"status": "ok"},
                                       "dup": {"status": "error"}}})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.get_receipts(["a", "b"], access_token="k")
    assert out["a"] == {"status": "ok"}
    assert out["b"] == {"status": "ok"}
    assert out["dup"] == {"status": "error"}     # the b-chunk (later) won


# WHIT-139 — [A22] access_token="" polls unauthenticated (no Authorization header)
def test_get_receipts_empty_token_sends_no_auth_header(shared, monkeypatch):
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["auth"] = req.get_header("Authorization")
        return _FakeResponse({"data": {"a": {"status": "ok"}}})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.get_receipts(["a"], access_token="")
    assert captured["auth"] is None              # empty token → no header, not "Bearer "
    assert out == {"a": {"status": "ok"}}
