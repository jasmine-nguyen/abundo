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


class _RecordingReceiptRepo:
    """Records the (receipt_id, token) pairs send_push stashed (WHIT-139)."""

    def __init__(self):
        self.put_calls = []

    def put(self, receipt_id, token):
        self.put_calls.append((receipt_id, token))


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


def test_data_payload_is_attached_to_every_message(shared, monkeypatch):
    # WHIT-321: an optional `data` rides on every message (deep-links a tap to a screen).
    # The no-data case above is the backward-compat guard: callers that pass none are
    # unchanged; this one proves the key appears on each message when passed.
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data)
        return _FakeResponse(_tickets("ok", "ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    push.send_push(
        "Nice one", "$3,573 toward the mortgage",
        ["ExpoPushToken[a]", "ExpoPushToken[b]"],
        data={"type": "repayment"}, access_token="k", device_repo=_RecordingRepo(),
    )
    assert [m.get("data") for m in captured["body"]] == [
        {"type": "repayment"}, {"type": "repayment"}
    ]


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


def test_stashes_receipt_ids_for_accepted_pushes(shared, monkeypatch):
    # WHIT-139: each accepted push returns a receipt id; stash it with the token it
    # went to so a later sweep can poll Expo for the true delivery outcome.
    push = shared.push
    receipt_repo = _RecordingReceiptRepo()
    body = {"data": [{"status": "ok", "id": "rcpt-a"}, {"status": "ok", "id": "rcpt-b"}]}
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(body))
    out = push.send_push("T", "B", ["ExpoPushToken[a]", "ExpoPushToken[b]"],
                         access_token="k", device_repo=_RecordingRepo(),
                         receipt_repo=receipt_repo)
    assert out["ok"] == 2
    assert receipt_repo.put_calls == [("rcpt-a", "ExpoPushToken[a]"),
                                      ("rcpt-b", "ExpoPushToken[b]")]


def test_does_not_stash_receipts_for_dead_or_id_less_tickets(shared, monkeypatch):
    # Only ACCEPTED tickets carrying a receipt id are stashed — a pruned (dead) token
    # and an ok ticket with no id both contribute nothing.
    push = shared.push
    receipt_repo = _RecordingReceiptRepo()
    body = {"data": [
        {"status": "ok", "id": "rcpt-live"},                              # stored
        {"status": "error", "details": {"error": "DeviceNotRegistered"}},  # pruned, not stored
        {"status": "ok"},                                                 # ok but no id → not stored
    ]}
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(body))
    out = push.send_push(
        "T", "B", ["ExpoPushToken[live]", "ExpoPushToken[dead]", "ExpoPushToken[noid]"],
        access_token="k", device_repo=_RecordingRepo(), receipt_repo=receipt_repo)
    assert out["pruned"] == ["ExpoPushToken[dead]"]
    assert receipt_repo.put_calls == [("rcpt-live", "ExpoPushToken[live]")]


def test_receipt_store_failure_is_swallowed(shared, monkeypatch):
    # A failing receipt store must never break the send (best-effort, never raises).
    push = shared.push

    class _BoomReceiptRepo:
        def put(self, receipt_id, token):
            raise RuntimeError("dynamo down")

    monkeypatch.setattr(
        push.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse({"data": [{"status": "ok", "id": "r"}]}))
    out = push.send_push("T", "B", ["ExpoPushToken[a]"], access_token="k",
                         device_repo=_RecordingRepo(), receipt_repo=_BoomReceiptRepo())
    assert out == {"sent": 1, "ok": 1, "pruned": []}


def test_uses_the_default_receipt_repo_when_none_injected(shared, monkeypatch):
    # Production callers (budget/repayment alerts) call send_push WITHOUT a receipt_repo,
    # so the default PushReceiptRepository is the real capture path — lock that it's used.
    push = shared.push
    default = _RecordingReceiptRepo()
    monkeypatch.setattr(push, "_default_receipt_repo", lambda: default)
    monkeypatch.setattr(
        push.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse({"data": [{"status": "ok", "id": "r1"}]}))
    push.send_push("T", "B", ["ExpoPushToken[a]"], access_token="k", device_repo=_RecordingRepo())
    assert default.put_calls == [("r1", "ExpoPushToken[a]")]


def test_default_receipt_repo_is_the_push_receipt_store(shared):
    push = shared.push
    assert isinstance(push._default_receipt_repo(), shared.push_receipt.PushReceiptRepository)


def test_receipt_store_open_failure_is_swallowed(shared, monkeypatch):
    # Even if opening the store fails, the send must still complete cleanly.
    push = shared.push

    def boom():
        raise RuntimeError("no store")

    monkeypatch.setattr(push, "_default_receipt_repo", boom)
    monkeypatch.setattr(
        push.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse({"data": [{"status": "ok", "id": "r"}]}))
    out = push.send_push("T", "B", ["ExpoPushToken[a]"], access_token="k", device_repo=_RecordingRepo())
    assert out == {"sent": 1, "ok": 1, "pruned": []}


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


def test_post_expo_empty_body_decodes_to_empty_dict(shared, monkeypatch):
    # The shared POST helper's `json.loads(raw) if raw else {}` else-branch: an empty HTTP
    # body must decode to {}, NOT call json.loads(b"") (which raises). Tested directly on
    # _post_expo because both public callers swallow a decode error, so the branch is
    # unobservable — and untestable to the fail-on-revert bar — through them.
    push = shared.push

    class _EmptyResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b""

    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _EmptyResponse())

    assert push._post_expo(push.EXPO_PUSH_URL, [], "k") == {}


def test_post_expo_builds_the_shared_request_shape(shared, monkeypatch):
    # Lock the plumbing the two callers now share: URL passthrough, POST, Bearer header,
    # timeout, and the JSON-encoded body — so a regression in the extracted helper is
    # caught here, not only transitively through send/getReceipts.
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.method
        captured["auth"] = req.get_header("Authorization")
        captured["timeout"] = timeout
        captured["body"] = json.loads(req.data)
        return _FakeResponse({"data": {"ok": True}})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push._post_expo(push.EXPO_RECEIPTS_URL, {"ids": ["r1"]}, "secret")

    assert captured["url"] == push.EXPO_RECEIPTS_URL
    assert captured["method"] == "POST"
    assert captured["auth"] == "Bearer secret"
    assert captured["timeout"] == push.EXPO_PUSH_TIMEOUT_SECONDS
    assert captured["body"] == {"ids": ["r1"]}
    assert out == {"data": {"ok": True}}


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


# --- get_receipts: the sweep's Expo poll (WHIT-139) --------------------------


def test_get_receipts_posts_ids_and_returns_the_data_dict(shared, monkeypatch):
    # getReceipts POSTs {"ids":[...]} and its `data` is a DICT keyed by receipt id
    # (unlike send, whose data is a list) — get_receipts returns that dict as-is.
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.method
        captured["auth"] = req.get_header("Authorization")
        captured["timeout"] = timeout
        captured["body"] = json.loads(req.data)
        return _FakeResponse({"data": {"rcpt-a": {"status": "ok"},
                                       "rcpt-b": {"status": "error",
                                                  "details": {"error": "DeviceNotRegistered"}}}})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.get_receipts(["rcpt-a", "rcpt-b"], access_token="secret")
    assert captured["url"] == push.EXPO_RECEIPTS_URL
    assert captured["method"] == "POST"
    assert captured["auth"] == "Bearer secret"
    assert captured["timeout"] == push.EXPO_PUSH_TIMEOUT_SECONDS
    assert captured["body"] == {"ids": ["rcpt-a", "rcpt-b"]}
    assert out == {"rcpt-a": {"status": "ok"},
                   "rcpt-b": {"status": "error", "details": {"error": "DeviceNotRegistered"}}}


def test_get_receipts_empty_ids_makes_no_request(shared, monkeypatch):
    push = shared.push
    calls = []
    monkeypatch.setattr(push.urllib.request, "urlopen", lambda *a, **k: calls.append(1))
    assert push.get_receipts([], access_token="k") == {}
    assert push.get_receipts(None, access_token="k") == {}
    assert calls == []


def test_get_receipts_chunks_over_the_max_and_merges(shared, monkeypatch):
    # >EXPO_RECEIPTS_MAX ids → multiple POSTs, whose data dicts are merged into one.
    push = shared.push
    monkeypatch.setattr(push, "EXPO_RECEIPTS_MAX", 2)
    seen = []

    def fake_urlopen(req, timeout=None):
        ids = json.loads(req.data)["ids"]
        seen.append(list(ids))
        return _FakeResponse({"data": {i: {"status": "ok"} for i in ids}})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.get_receipts(["a", "b", "c"], access_token="k")
    assert seen == [["a", "b"], ["c"]]                 # chunked at 2
    assert out == {"a": {"status": "ok"}, "b": {"status": "ok"}, "c": {"status": "ok"}}


def test_get_receipts_one_bad_chunk_does_not_lose_the_others(shared, monkeypatch):
    # A per-chunk transport error is swallowed; the surviving chunks' ids still return.
    push = shared.push
    monkeypatch.setattr(push, "EXPO_RECEIPTS_MAX", 1)

    def fake_urlopen(req, timeout=None):
        ids = json.loads(req.data)["ids"]
        if ids == ["b"]:
            raise urllib.error.URLError("down")
        return _FakeResponse({"data": {ids[0]: {"status": "ok"}}})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.get_receipts(["a", "b", "c"], access_token="k")
    assert out == {"a": {"status": "ok"}, "c": {"status": "ok"}}   # b's chunk dropped, rest kept


def test_get_receipts_absent_data_and_top_level_errors_yield_empty(shared, monkeypatch):
    # A request-level rejection returns {"errors":[...]} with no `data`; get_receipts
    # surfaces {} for that chunk rather than raising on a missing key.
    push = shared.push
    monkeypatch.setattr(
        push.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse({"errors": [{"code": "RATE_LIMIT"}]}))
    assert push.get_receipts(["a"], access_token="k") == {}


def test_get_receipts_reads_token_from_ssm_when_not_passed(shared, monkeypatch):
    push = shared.push
    monkeypatch.setattr(push, "_access_token", None, raising=False)
    monkeypatch.setattr(push, "get_param", lambda path: "ssm-token")
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["auth"] = req.get_header("Authorization")
        return _FakeResponse({"data": {"a": {"status": "ok"}}})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    push.get_receipts(["a"])
    assert captured["auth"] == "Bearer ssm-token"


def test_get_receipts_surfaces_request_level_errors_as_a_warning(shared, monkeypatch, caplog):
    # WHIT-246 — [A-warn] The refactor left getReceipts' request-level `errors` handling
    # OUTSIDE _post_expo, in _get_receipts_batch. Expo can 200 with a top-level {"errors":[...]}
    # (rate-limit / malformed) and NO `data`; the module logs a WARNING so that rejection
    # isn't silently indistinguishable from an empty result. The existing
    # test_get_receipts_absent_data_and_top_level_errors_yield_empty EXECUTES this branch
    # but only asserts the {} return — the warning itself is unasserted. Lock it here.
    import logging
    push = shared.push
    monkeypatch.setattr(
        push.urllib.request, "urlopen",
        lambda req, timeout=None: _FakeResponse({"errors": [{"code": "RATE_LIMIT"}]}))
    with caplog.at_level(logging.WARNING, logger=push.logger.name):
        out = push.get_receipts(["a"], access_token="k")
    assert out == {}
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("request-level errors" in m and "RATE_LIMIT" in m for m in warnings), warnings
