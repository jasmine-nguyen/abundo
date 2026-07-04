"""Tests for the Expo Push sender (shared/push.py).

No network: ``push.urllib.request.urlopen`` is monkeypatched with a fake response,
and a recording fake stands in for DeviceRepository. Locks the request shape, the
ticket→token pruning, batching over 100, the never-raises swallow, and the auth
header (present only with an access token; read from SSM when not passed).
"""

import json
import urllib.error


class _FakeResponse:
    """urlopen() stand-in used as a context manager; .read() -> bytes."""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


class _RecordingRepo:
    """Records which tokens send_push asked to prune."""

    def __init__(self):
        self.removed = []

    def remove(self, token):
        self.removed.append(token)


def _tickets(*statuses):
    """Build an Expo response body from a list of "ok" / "dnr" ticket statuses."""
    data = []
    for s in statuses:
        if s == "ok":
            data.append({"status": "ok", "id": "receipt-id"})
        else:
            data.append({"status": "error", "message": "gone",
                         "details": {"error": "DeviceNotRegistered"}})
    return {"data": data}


def test_empty_tokens_is_a_noop_and_makes_no_request(shared, monkeypatch):
    push = shared.push
    calls = []
    monkeypatch.setattr(push.urllib.request, "urlopen", lambda *a, **k: calls.append(1))
    out = push.send_push("T", "B", [], access_token="k")
    assert out == {"sent": 0, "ok": 0, "pruned": []}
    assert calls == []   # never touched the network


def test_none_tokens_is_a_noop_and_never_raises(shared, monkeypatch):
    # The "never raises" contract must hold even for a None token list.
    push = shared.push
    calls = []
    monkeypatch.setattr(push.urllib.request, "urlopen", lambda *a, **k: calls.append(1))
    out = push.send_push("T", "B", None, access_token="k")
    assert out == {"sent": 0, "ok": 0, "pruned": []}
    assert calls == []


def test_builds_the_expo_request_and_counts_ok(shared, monkeypatch):
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.method
        captured["auth"] = req.get_header("Authorization")
        captured["timeout"] = timeout
        captured["body"] = json.loads(req.data)
        return _FakeResponse(_tickets("ok", "ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.send_push(
        "Heads up", "Coffee at 80%",
        ["ExpoPushToken[a]", "ExpoPushToken[b]"],
        access_token="secret", device_repo=_RecordingRepo(),
    )
    assert captured["url"] == push.EXPO_PUSH_URL
    assert captured["method"] == "POST"
    assert captured["auth"] == "Bearer secret"
    assert captured["timeout"] == push.EXPO_PUSH_TIMEOUT_SECONDS
    assert captured["body"] == [
        {"to": "ExpoPushToken[a]", "title": "Heads up", "body": "Coffee at 80%"},
        {"to": "ExpoPushToken[b]", "title": "Heads up", "body": "Coffee at 80%"},
    ]
    assert out["ok"] == 2
    assert out["pruned"] == []


def test_prunes_device_not_registered_tokens(shared, monkeypatch):
    push = shared.push
    repo = _RecordingRepo()
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(_tickets("ok", "dnr")))
    out = push.send_push("T", "B", ["ExpoPushToken[good]", "ExpoPushToken[dead]"],
                         access_token="k", device_repo=repo)
    assert out["ok"] == 1
    assert out["pruned"] == ["ExpoPushToken[dead]"]
    assert repo.removed == ["ExpoPushToken[dead]"]


def test_transport_error_is_swallowed(shared, monkeypatch):
    push = shared.push

    def boom(req, timeout=None):
        raise urllib.error.URLError("down")

    monkeypatch.setattr(push.urllib.request, "urlopen", boom)
    out = push.send_push("T", "B", ["ExpoPushToken[a]"], access_token="k",
                         device_repo=_RecordingRepo())
    assert out == {"sent": 1, "ok": 0, "pruned": []}   # never raised


def test_malformed_response_is_swallowed(shared, monkeypatch):
    push = shared.push

    class _Bad:
        def __enter__(self): return self
        def __exit__(self, *e): return False
        def read(self): return b"not json"

    monkeypatch.setattr(push.urllib.request, "urlopen", lambda req, timeout=None: _Bad())
    out = push.send_push("T", "B", ["ExpoPushToken[a]"], access_token="k")
    assert out["ok"] == 0 and out["pruned"] == []


def test_batches_over_100_and_prunes_in_the_second_batch(shared, monkeypatch):
    push = shared.push
    sizes = []

    def fake_urlopen(req, timeout=None):
        msgs = json.loads(req.data)
        sizes.append(len(msgs))
        # last token of each batch comes back DeviceNotRegistered
        return _FakeResponse(_tickets(*(["ok"] * (len(msgs) - 1) + ["dnr"])))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    tokens = [f"ExpoPushToken[{i}]" for i in range(150)]
    repo = _RecordingRepo()
    out = push.send_push("T", "B", tokens, access_token="k", device_repo=repo)
    assert sizes == [100, 50]   # 100-per-request batching
    # ticket↔token zipping holds per batch: the last of each batch is pruned.
    assert out["pruned"] == ["ExpoPushToken[99]", "ExpoPushToken[149]"]
    assert repo.removed == ["ExpoPushToken[99]", "ExpoPushToken[149]"]


def test_no_auth_header_when_access_token_is_empty(shared, monkeypatch):
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["auth"] = req.get_header("Authorization")
        return _FakeResponse(_tickets("ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    push.send_push("T", "B", ["ExpoPushToken[a]"], access_token="", device_repo=_RecordingRepo())
    assert captured["auth"] is None


def test_access_token_read_from_ssm_when_not_passed(shared, monkeypatch):
    push = shared.push
    monkeypatch.setattr(push, "_access_token", None, raising=False)
    monkeypatch.setattr(push, "get_param", lambda path: "ssm-token")
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["auth"] = req.get_header("Authorization")
        return _FakeResponse(_tickets("ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    push.send_push("T", "B", ["ExpoPushToken[a]"], device_repo=_RecordingRepo())
    assert captured["auth"] == "Bearer ssm-token"


def test_unreadable_ssm_token_does_not_crash_the_send(shared, monkeypatch):
    push = shared.push
    monkeypatch.setattr(push, "_access_token", None, raising=False)

    def boom(path):
        raise RuntimeError("ssm down")

    monkeypatch.setattr(push, "get_param", boom)
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["auth"] = req.get_header("Authorization")
        return _FakeResponse(_tickets("ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.send_push("T", "B", ["ExpoPushToken[a]"], device_repo=_RecordingRepo())
    assert captured["auth"] is None      # fell back to no header, didn't raise
    assert out["ok"] == 1


def test_prune_uses_default_repo_when_none_injected(shared, monkeypatch):
    push = shared.push
    repo = _RecordingRepo()
    monkeypatch.setattr(push, "_default_repo", lambda: repo)
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(_tickets("dnr")))
    push.send_push("T", "B", ["ExpoPushToken[dead]"], access_token="k")
    assert repo.removed == ["ExpoPushToken[dead]"]


def test_prune_failure_is_swallowed(shared, monkeypatch):
    push = shared.push

    class _AngryRepo:
        def remove(self, token):
            raise RuntimeError("db down")

    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(_tickets("dnr")))
    out = push.send_push("T", "B", ["ExpoPushToken[dead]"], access_token="k",
                         device_repo=_AngryRepo())
    # prune raised internally but send_push still returns cleanly
    assert out["pruned"] == ["ExpoPushToken[dead]"]


def test_duplicate_and_empty_tokens_are_dropped(shared, monkeypatch):
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data)
        return _FakeResponse(_tickets("ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.send_push("T", "B", ["ExpoPushToken[a]", "ExpoPushToken[a]", "", None],
                         access_token="k", device_repo=_RecordingRepo())
    assert [m["to"] for m in captured["body"]] == ["ExpoPushToken[a]"]
    assert out["sent"] == 1
