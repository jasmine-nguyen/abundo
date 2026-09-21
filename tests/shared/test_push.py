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


# --- folded from test_push_data_edges.py (WHIT-463) ---


def test_data_is_attached_to_every_message_across_multiple_batches(shared, monkeypatch):
    push = shared.push
    bodies = []

    def fake_urlopen(req, timeout=None):
        batch = json.loads(req.data)
        bodies.append(batch)
        return _FakeResponse(_tickets(*(["ok"] * len(batch))))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)

    # One more than a full batch → forces >= 2 Expo requests.
    n = push.EXPO_PUSH_BATCH_MAX + 1
    tokens = [f"ExpoPushToken[{i}]" for i in range(n)]
    push.send_push(
        "Nice one", "$3,573 toward the mortgage", tokens,
        data={"type": "repayment"}, access_token="k", device_repo=_RecordingRepo(),
    )

    assert len(bodies) >= 2  # actually chunked
    every_message = [m for batch in bodies for m in batch]
    assert len(every_message) == n
    assert all(m.get("data") == {"type": "repayment"} for m in every_message)


def test_falsy_empty_data_is_omitted_entirely(shared, monkeypatch):
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data)
        return _FakeResponse(_tickets("ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    push.send_push(
        "Title", "Body", ["ExpoPushToken[a]"],
        data={}, access_token="k", device_repo=_RecordingRepo(),
    )
    # {} is falsy → no `data` key at all (byte-identical to the pre-WHIT-321 message).
    assert "data" not in captured["body"][0]
    assert captured["body"][0] == {"to": "ExpoPushToken[a]", "title": "Title", "body": "Body"}


# --- folded from test_push_edge.py (WHIT-463) ---


def _resp(data):
    """Wrap an explicit Expo ``data`` value (list, dict, whatever) in a response."""
    return _FakeResponse({"data": data})


def _tok(n):
    return [f"ExpoPushToken[{i}]" for i in range(n)]


def test_more_tickets_than_messages_does_not_over_count_or_mis_prune(shared, monkeypatch):
    # Expo returns 2 tickets for a single message; zip truncates to the batch,
    # so the extra DNR ticket must NOT prune a token that wasn't sent.
    push = shared.push
    repo = _RecordingRepo()
    extra = [{"status": "ok", "id": "r"},
             {"status": "error", "details": {"error": "DeviceNotRegistered"}}]
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _resp(extra))
    out = push.send_push("T", "B", ["ExpoPushToken[0]"], access_token="k", device_repo=repo)
    assert out == {"sent": 1, "ok": 1, "pruned": []}
    assert repo.removed == []


def test_fewer_tickets_than_messages_counts_only_what_returned(shared, monkeypatch):
    # Partial response: 2 tokens sent, 1 ticket back. zip truncates, no crash,
    # only the returned ticket is counted; the un-ticketed token isn't pruned.
    push = shared.push
    repo = _RecordingRepo()
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _resp([{"status": "ok", "id": "r"}]))
    out = push.send_push("T", "B", _tok(2), access_token="k", device_repo=repo)
    assert out == {"sent": 2, "ok": 1, "pruned": []}
    assert repo.removed == []


def test_data_not_a_list_is_swallowed(shared, monkeypatch):
    # A dict where a list is expected is truthy, so `data or []` keeps it; zip then
    # iterates its keys (strings), the isinstance guard skips them, nothing crashes.
    push = shared.push
    repo = _RecordingRepo()
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _resp({"weird": "shape"}))
    out = push.send_push("T", "B", ["ExpoPushToken[0]"], access_token="k", device_repo=repo)
    assert out == {"sent": 1, "ok": 0, "pruned": []}
    assert repo.removed == []


def test_non_dict_tickets_are_skipped(shared, monkeypatch):
    # Bare string / None tickets must not raise on .get(); isinstance guard skips them.
    push = shared.push
    repo = _RecordingRepo()
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _resp([None, "oops"]))
    out = push.send_push("T", "B", _tok(2), access_token="k", device_repo=repo)
    assert out == {"sent": 2, "ok": 0, "pruned": []}
    assert repo.removed == []


def test_error_ticket_other_than_DNR_is_not_pruned(shared, monkeypatch):
    # Only DeviceNotRegistered prunes. A live token that hit MessageRateExceeded /
    # MessageTooBig must be KEPT, or a transient error would delete a good device.
    push = shared.push
    repo = _RecordingRepo()
    for err in ("MessageRateExceeded", "MessageTooBig", "InvalidCredentials"):
        repo.removed.clear()
        monkeypatch.setattr(
            push.urllib.request, "urlopen",
            lambda req, timeout=None, e=err: _resp([{"status": "error", "details": {"error": e}}]),
        )
        out = push.send_push("T", "B", ["ExpoPushToken[live]"], access_token="k", device_repo=repo)
        assert out == {"sent": 1, "ok": 0, "pruned": []}, err
        assert repo.removed == [], err


def test_error_ticket_with_no_details_is_not_pruned(shared, monkeypatch):
    # status:"error" but no details dict — (details or {}).get(...) must yield None,
    # not raise, and must not prune.
    push = shared.push
    repo = _RecordingRepo()
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _resp([{"status": "error", "message": "boom"}]))
    out = push.send_push("T", "B", ["ExpoPushToken[live]"], access_token="k", device_repo=repo)
    assert out == {"sent": 1, "ok": 0, "pruned": []}
    assert repo.removed == []


def test_http_error_is_swallowed(shared, monkeypatch):
    # test_push.py covers URLError; HTTPError is the 4xx/5xx case and must also
    # be swallowed (best-effort), leaving the send clean.
    push = shared.push

    def boom(req, timeout=None):
        raise urllib.error.HTTPError(push.EXPO_PUSH_URL, 500, "server error", {}, None)

    monkeypatch.setattr(push.urllib.request, "urlopen", boom)
    out = push.send_push("T", "B", ["ExpoPushToken[a]"], access_token="k",
                         device_repo=_RecordingRepo())
    assert out == {"sent": 1, "ok": 0, "pruned": []}


def test_first_batch_failure_does_not_stop_later_batches(shared, monkeypatch):
    # 150 tokens -> 2 batches. The FIRST request raises; the second must still be
    # sent and counted (the continue keeps the loop going).
    push = shared.push
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("first batch down")
        msgs = json.loads(req.data)
        return _resp([{"status": "ok", "id": "r"} for _ in msgs])

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.send_push("T", "B", _tok(150), access_token="k", device_repo=_RecordingRepo())
    assert calls["n"] == 2                       # both batches attempted
    assert out == {"sent": 150, "ok": 50, "pruned": []}  # only the 2nd batch's 50 landed


# --- folded from test_push_receipt_capture_edge.py (WHIT-463) ---


def test_receipt_capture_correlates_across_two_batches(shared, monkeypatch):
    # WHIT-139 [A20]: 150 tokens -> batches of 100 + 50. Each batch's ok tickets carry
    # an id derived from the token they were sent to; the last token of EACH batch is
    # DeviceNotRegistered. Proves batch-2 receipt ids map to batch-2 tokens (not batch-1),
    # i.e. the zip is re-scoped per batch and captures the right (id, token) pairs.
    push = shared.push
    receipt_repo = _RecordingReceiptRepo()

    def fake_urlopen(req, timeout=None):
        msgs = json.loads(req.data)
        data = []
        for i, m in enumerate(msgs):
            if i == len(msgs) - 1:  # last of the batch is dead
                data.append({"status": "error", "details": {"error": "DeviceNotRegistered"}})
            else:
                data.append({"status": "ok", "id": f"r-{m['to']}"})
        return _FakeResponse({"data": data})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.send_push("T", "B", _tok(150), access_token="k",
                         device_repo=_RecordingRepo(), receipt_repo=receipt_repo)

    # token 99 (last of batch 1) and 149 (last of batch 2) are pruned, not stashed.
    assert out["pruned"] == ["ExpoPushToken[99]", "ExpoPushToken[149]"]
    expected = [(f"r-ExpoPushToken[{i}]", f"ExpoPushToken[{i}]")
                for i in range(150) if i not in (99, 149)]
    assert receipt_repo.put_calls == expected
    assert out["ok"] == 148


def test_dropped_batch_stashes_only_the_surviving_batch(shared, monkeypatch):
    # WHIT-139 [A21]: the FIRST batch's request raises (transport error); the second
    # succeeds. Only the second batch's receipts must be stashed — no batch-1 ids leak
    # in, no misalignment, no crash.
    push = shared.push
    receipt_repo = _RecordingReceiptRepo()
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("first batch down")
        msgs = json.loads(req.data)
        return _FakeResponse({"data": [{"status": "ok", "id": f"r-{m['to']}"} for m in msgs]})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.send_push("T", "B", _tok(150), access_token="k",
                         device_repo=_RecordingRepo(), receipt_repo=receipt_repo)

    assert calls["n"] == 2
    assert out == {"sent": 150, "ok": 50, "pruned": []}
    # Only tokens 100..149 (batch 2) were stashed; none of batch 1 (0..99).
    assert receipt_repo.put_calls == [(f"r-ExpoPushToken[{i}]", f"ExpoPushToken[{i}]")
                                      for i in range(100, 150)]


def test_one_raising_put_does_not_drop_the_other_puts(shared, monkeypatch):
    # WHIT-139 [A22]: the store fails on the 2nd of 3 receipts. The per-item swallow must
    # still ATTEMPT the 1st and 3rd (one bad row can't sink its neighbours), and the send
    # returns cleanly.
    push = shared.push

    class _FlakyReceiptRepo:
        def __init__(self):
            self.attempts = []

        def put(self, receipt_id, token):
            self.attempts.append((receipt_id, token))
            if len(self.attempts) == 2:
                raise RuntimeError("transient dynamo blip")

    repo = _FlakyReceiptRepo()
    body = {"data": [{"status": "ok", "id": "r0"},
                     {"status": "ok", "id": "r1"},
                     {"status": "ok", "id": "r2"}]}
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(body))
    out = push.send_push("T", "B", _tok(3), access_token="k",
                         device_repo=_RecordingRepo(), receipt_repo=repo)

    assert out == {"sent": 3, "ok": 3, "pruned": []}
    # All three were attempted despite the middle one raising.
    assert repo.attempts == [("r0", "ExpoPushToken[0]"),
                             ("r1", "ExpoPushToken[1]"),
                             ("r2", "ExpoPushToken[2]")]


def test_empty_or_none_receipt_id_is_not_stashed(shared, monkeypatch):
    # WHIT-139 [A23]: an ok ticket whose id is "" or None is falsy — the guard must skip
    # it (no blank sk stashed), while a real id alongside is still captured.
    push = shared.push
    receipt_repo = _RecordingReceiptRepo()
    body = {"data": [
        {"status": "ok", "id": ""},        # empty string → skipped
        {"status": "ok", "id": None},      # explicit None → skipped
        {"status": "ok", "id": "r-real"},  # real id → stashed
    ]}
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _FakeResponse(body))
    out = push.send_push("T", "B", _tok(3), access_token="k",
                         device_repo=_RecordingRepo(), receipt_repo=receipt_repo)

    assert out["ok"] == 3  # all three ACCEPTED; ok counts acceptance, not capture
    assert receipt_repo.put_calls == [("r-real", "ExpoPushToken[2]")]
