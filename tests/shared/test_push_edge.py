"""Adversarial edge-case tests for the Expo Push sender (shared/push.py).

Companion to test_push.py. The implementer's file locks the happy path, ok/DNR
pruning, batching-over-100, the never-raises swallow and the auth header. This
file covers the GAPS: malformed Expo responses (more/fewer tickets than sent,
data not a list, non-dict tickets), error tickets that must NOT prune (only
DeviceNotRegistered does), HTTPError (not just URLError) swallowed, and a
first-batch failure not stopping later batches.

Same no-network technique: monkeypatch push.urllib.request.urlopen with a fake.
Every assertion runs against the real push.send_push, so a revert fails it.
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
    def __init__(self):
        self.removed = []

    def remove(self, token):
        self.removed.append(token)


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
