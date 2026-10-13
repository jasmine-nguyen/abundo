"""Tests for the Expo Push sender (shared/push.py).

No network: ``push.urllib.request.urlopen`` is monkeypatched with a fake response, and
the ``stores`` fixture swaps push's SSM read and its DeviceRepository /
PushReceiptRepository for recording fakes. Locks the request shape, the ticket→token
pruning, batching over 100, the never-raises swallow, and the auth header (present only
with an access token, read from SSM).
"""

import json
import types
import urllib.error

import pytest

from _http_fakes import FakeResponse
from _milestone_fakes import FakeDeviceRepo


class _RecordingReceiptRepo:
    """Records the (receipt_id, token) pairs send_push stashed (WHIT-139)."""

    def __init__(self):
        self.put_calls = []

    def put(self, receipt_id, token):
        self.put_calls.append((receipt_id, token))


def _stub_ssm_token(push, monkeypatch, read):
    """Stand in for the shared SSM read, checking push asks for the Expo token's path."""

    def get_api_key(path):
        assert path == push.EXPO_ACCESS_TOKEN_PATH
        return read(path)

    monkeypatch.setattr(push, "get_api_key", get_api_key)


@pytest.fixture
def stores(shared, monkeypatch):
    """Token "k" from SSM, and recording fakes behind push's device + receipt stores."""
    push = shared.push
    devices = FakeDeviceRepo()
    receipts = _RecordingReceiptRepo()
    _stub_ssm_token(push, monkeypatch, lambda path: "k")
    monkeypatch.setattr(push, "DeviceRepository", lambda: devices)
    monkeypatch.setattr(push, "PushReceiptRepository", lambda: receipts)
    return types.SimpleNamespace(devices=devices, receipts=receipts)


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


@pytest.mark.parametrize("tokens", [[], None])
def test_empty_tokens_is_a_noop_and_makes_no_request(shared, stores, monkeypatch, tokens):
    # The "never raises" contract holds even for a None token list.
    push = shared.push
    calls = []
    monkeypatch.setattr(push.urllib.request, "urlopen", lambda *a, **k: calls.append(1))
    out = push.send_push("T", "B", tokens)
    assert out == {"sent": 0, "ok": 0, "pruned": []}
    assert calls == []   # never touched the network


def test_builds_the_expo_request_and_counts_ok(shared, stores, monkeypatch):
    push = shared.push
    _stub_ssm_token(push, monkeypatch, lambda path: "secret")
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.method
        captured["auth"] = req.get_header("Authorization")
        captured["timeout"] = timeout
        captured["body"] = json.loads(req.data)
        return FakeResponse(_tickets("ok", "ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.send_push(
        "Heads up", "Coffee at 80%",
        ["ExpoPushToken[a]", "ExpoPushToken[b]"],
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


def test_data_payload_is_attached_to_every_message(shared, stores, monkeypatch):
    # WHIT-321: an optional `data` rides on every message (deep-links a tap to a screen).
    # The no-data case above is the backward-compat guard: callers that pass none are
    # unchanged; this one proves the key appears on each message when passed.
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data)
        return FakeResponse(_tickets("ok", "ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    push.send_push(
        "Nice one", "$3,573 toward the mortgage",
        ["ExpoPushToken[a]", "ExpoPushToken[b]"],
        data={"type": "repayment"},
    )
    assert [m.get("data") for m in captured["body"]] == [
        {"type": "repayment"}, {"type": "repayment"}
    ]


def test_prunes_device_not_registered_tokens(shared, stores, monkeypatch):
    push = shared.push
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: FakeResponse(_tickets("ok", "dnr")))
    out = push.send_push("T", "B", ["ExpoPushToken[good]", "ExpoPushToken[dead]"])
    assert out["ok"] == 1
    assert out["pruned"] == ["ExpoPushToken[dead]"]
    assert stores.devices.removed == ["ExpoPushToken[dead]"]


def test_stashes_receipt_ids_for_accepted_pushes(shared, stores, monkeypatch):
    # WHIT-139: each accepted push returns a receipt id; stash it with the token it
    # went to so a later sweep can poll Expo for the true delivery outcome.
    push = shared.push
    body = {"data": [{"status": "ok", "id": "rcpt-a"}, {"status": "ok", "id": "rcpt-b"}]}
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: FakeResponse(body))
    out = push.send_push("T", "B", ["ExpoPushToken[a]", "ExpoPushToken[b]"])
    assert out["ok"] == 2
    assert stores.receipts.put_calls == [("rcpt-a", "ExpoPushToken[a]"),
                                         ("rcpt-b", "ExpoPushToken[b]")]


def test_does_not_stash_receipts_for_dead_or_id_less_tickets(shared, stores, monkeypatch):
    # Only ACCEPTED tickets carrying a receipt id are stashed — a pruned (dead) token
    # and an ok ticket with no id both contribute nothing.
    push = shared.push
    body = {"data": [
        {"status": "ok", "id": "rcpt-live"},                              # stored
        {"status": "error", "details": {"error": "DeviceNotRegistered"}},  # pruned, not stored
        {"status": "ok"},                                                 # ok but no id → not stored
    ]}
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: FakeResponse(body))
    out = push.send_push(
        "T", "B", ["ExpoPushToken[live]", "ExpoPushToken[dead]", "ExpoPushToken[noid]"])
    assert out["pruned"] == ["ExpoPushToken[dead]"]
    assert stores.receipts.put_calls == [("rcpt-live", "ExpoPushToken[live]")]


def test_receipt_store_failure_is_swallowed(shared, stores, monkeypatch):
    # A failing receipt store must never break the send (best-effort, never raises), and one
    # failed save must not drop the receipts after it (the sweep would never prune those devices).
    push = shared.push
    tried = []

    class _FlakyReceiptRepo:
        def put(self, receipt_id, token):
            tried.append(receipt_id)
            if receipt_id == "r2":
                raise RuntimeError("dynamo blip")

    tokens = ["ExpoPushToken[a]", "ExpoPushToken[b]", "ExpoPushToken[c]"]
    monkeypatch.setattr(push, "PushReceiptRepository", _FlakyReceiptRepo)
    monkeypatch.setattr(push.urllib.request, "urlopen", lambda req, timeout=None: FakeResponse(
        {"data": [{"status": "ok", "id": f"r{i}"} for i in (1, 2, 3)]}))
    assert push.send_push("T", "B", tokens) == {"sent": 3, "ok": 3, "pruned": []}
    assert tried == ["r1", "r2", "r3"]

    def _unopenable():
        raise RuntimeError("no store")

    monkeypatch.setattr(push, "PushReceiptRepository", _unopenable)
    assert push.send_push("T", "B", tokens) == {"sent": 3, "ok": 3, "pruned": []}


def test_transport_error_is_swallowed(shared, stores, monkeypatch):
    push = shared.push

    def boom(req, timeout=None):
        raise urllib.error.URLError("down")

    monkeypatch.setattr(push.urllib.request, "urlopen", boom)
    out = push.send_push("T", "B", ["ExpoPushToken[a]"])
    assert out == {"sent": 1, "ok": 0, "pruned": []}   # never raised


def test_malformed_response_is_swallowed(shared, stores, monkeypatch):
    push = shared.push

    class _Bad:
        def __enter__(self): return self
        def __exit__(self, *e): return False
        def read(self): return b"not json"

    monkeypatch.setattr(push.urllib.request, "urlopen", lambda req, timeout=None: _Bad())
    out = push.send_push("T", "B", ["ExpoPushToken[a]"])
    assert out["ok"] == 0 and out["pruned"] == []


def test_batches_over_100_and_prunes_in_the_second_batch(shared, stores, monkeypatch):
    push = shared.push
    sizes = []

    def fake_urlopen(req, timeout=None):
        msgs = json.loads(req.data)
        sizes.append(len(msgs))
        # last token of each batch comes back DeviceNotRegistered
        return FakeResponse(_tickets(*(["ok"] * (len(msgs) - 1) + ["dnr"])))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    tokens = [f"ExpoPushToken[{i}]" for i in range(150)]
    out = push.send_push("T", "B", tokens)
    assert sizes == [100, 50]   # 100-per-request batching
    # ticket↔token zipping holds per batch: the last of each batch is pruned.
    assert out["pruned"] == ["ExpoPushToken[99]", "ExpoPushToken[149]"]
    assert stores.devices.removed == ["ExpoPushToken[99]", "ExpoPushToken[149]"]


def test_no_auth_header_when_access_token_is_empty(shared, stores, monkeypatch):
    push = shared.push
    _stub_ssm_token(push, monkeypatch, lambda path: "")
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["auth"] = req.get_header("Authorization")
        return FakeResponse(_tickets("ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    push.send_push("T", "B", ["ExpoPushToken[a]"])
    assert captured["auth"] is None


def test_unreadable_ssm_token_does_not_crash_the_send(shared, stores, monkeypatch):
    push = shared.push

    def boom(path):
        raise RuntimeError("ssm down")

    _stub_ssm_token(push, monkeypatch, boom)
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["auth"] = req.get_header("Authorization")
        return FakeResponse(_tickets("ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.send_push("T", "B", ["ExpoPushToken[a]"])
    assert captured["auth"] is None      # fell back to no header, didn't raise
    assert out["ok"] == 1


def test_prune_failure_is_swallowed(shared, stores, monkeypatch):
    push = shared.push

    class _AngryRepo:
        def remove(self, token):
            raise RuntimeError("db down")

    monkeypatch.setattr(push, "DeviceRepository", _AngryRepo)
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: FakeResponse(_tickets("dnr")))
    out = push.send_push("T", "B", ["ExpoPushToken[dead]"])
    # prune raised internally but send_push still returns cleanly
    assert out["pruned"] == ["ExpoPushToken[dead]"]


def test_duplicate_and_empty_tokens_are_dropped(shared, stores, monkeypatch):
    push = shared.push
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["body"] = json.loads(req.data)
        return FakeResponse(_tickets("ok"))

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.send_push("T", "B", ["ExpoPushToken[a]", "ExpoPushToken[a]", "", None])
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
        return FakeResponse({"data": {"rcpt-a": {"status": "ok"},
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


def test_get_receipts_chunks_over_the_max_and_merges(shared, monkeypatch):
    # >EXPO_RECEIPTS_MAX ids → multiple POSTs, whose data dicts are merged into one.
    push = shared.push
    monkeypatch.setattr(push, "EXPO_RECEIPTS_MAX", 2)
    seen = []

    def fake_urlopen(req, timeout=None):
        ids = json.loads(req.data)["ids"]
        seen.append(list(ids))
        return FakeResponse({"data": {i: {"status": "ok"} for i in ids}})

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
        return FakeResponse({"data": {ids[0]: {"status": "ok"}}})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)
    out = push.get_receipts(["a", "b", "c"], access_token="k")
    assert out == {"a": {"status": "ok"}, "c": {"status": "ok"}}   # b's chunk dropped, rest kept


def test_get_receipts_absent_data_and_top_level_errors_yield_empty(shared, monkeypatch):
    # A request-level rejection returns {"errors":[...]} with no `data`; get_receipts
    # surfaces {} for that chunk rather than raising on a missing key.
    push = shared.push
    monkeypatch.setattr(
        push.urllib.request, "urlopen",
        lambda req, timeout=None: FakeResponse({"errors": [{"code": "RATE_LIMIT"}]}))
    assert push.get_receipts(["a"], access_token="k") == {}


# --- folded from test_push_edge.py (WHIT-463) ---


def _resp(data):
    """Wrap an explicit Expo ``data`` value (list, dict, whatever) in a response."""
    return FakeResponse({"data": data})


def _tok(n):
    return [f"ExpoPushToken[{i}]" for i in range(n)]


def test_more_tickets_than_messages_does_not_over_count_or_mis_prune(shared, stores, monkeypatch):
    # Expo returns 2 tickets for a single message; zip truncates to the batch,
    # so the extra DNR ticket must NOT prune a token that wasn't sent.
    push = shared.push
    extra = [{"status": "ok", "id": "r"},
             {"status": "error", "details": {"error": "DeviceNotRegistered"}}]
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: _resp(extra))
    out = push.send_push("T", "B", ["ExpoPushToken[0]"])
    assert out == {"sent": 1, "ok": 1, "pruned": []}
    assert stores.devices.removed == []


def test_error_ticket_other_than_DNR_is_not_pruned(shared, stores, monkeypatch):
    # Only DeviceNotRegistered prunes. A live token that hit MessageRateExceeded /
    # MessageTooBig must be KEPT, or a transient error would delete a good device.
    push = shared.push
    for err in ("MessageRateExceeded", "MessageTooBig", "InvalidCredentials"):
        monkeypatch.setattr(
            push.urllib.request, "urlopen",
            lambda req, timeout=None, e=err: _resp([{"status": "error", "details": {"error": e}}]),
        )
        out = push.send_push("T", "B", ["ExpoPushToken[live]"])
        assert out == {"sent": 1, "ok": 0, "pruned": []}, err
        assert stores.devices.removed == [], err


def test_first_batch_failure_does_not_stop_later_batches(shared, stores, monkeypatch):
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
    out = push.send_push("T", "B", _tok(150))
    assert calls["n"] == 2                       # both batches attempted
    assert out == {"sent": 150, "ok": 50, "pruned": []}  # only the 2nd batch's 50 landed


# --- folded from test_push_receipts_sweep_extra.py ---


# WHIT-139 — [A20] a chunk with both `data` and a top-level `errors` array keeps the data
def test_get_receipts_data_alongside_errors_still_returns_data(shared, monkeypatch, caplog):
    # Expo can return resolved receipts in `data` AND a non-fatal `errors` array in the
    # same body. The errors are logged, but the data must NOT be dropped.
    push = shared.push
    body = {"data": {"rcpt-a": {"status": "ok"}},
            "errors": [{"code": "SOME_WARNING"}]}
    monkeypatch.setattr(push.urllib.request, "urlopen",
                        lambda req, timeout=None: FakeResponse(body))
    out = push.get_receipts(["rcpt-a"], access_token="k")
    assert out == {"rcpt-a": {"status": "ok"}}   # data survived despite errors present
