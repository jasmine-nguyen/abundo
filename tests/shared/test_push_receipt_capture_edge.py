"""Adversarial gap tests for receipt capture in send_push (shared/push.py) — WHIT-139 PR1.

Companion to the implementer's test_push.py receipt cases. Those lock single-batch
capture, the falsy/dnr exclusions, the swallow paths and the default-repo wiring.
This file covers the GAPS they leave:

- [A20] receipt capture correlates across TWO batches (batch-2 ids map to batch-2 tokens),
- [A21] a dropped (raising) batch stashes ONLY the surviving batch's receipts, no crash,
- [A22] one raising put() does not drop the surrounding puts (per-item swallow), and
- [A23] an empty-string / None id is falsy → not stashed, no crash.

Same no-network technique as test_push.py: monkeypatch push.urllib.request.urlopen with
a fake response. Every assertion runs against the real push.send_push, so a revert fails it.
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


class _RecordingReceiptRepo:
    def __init__(self):
        self.put_calls = []

    def put(self, receipt_id, token):
        self.put_calls.append((receipt_id, token))


def _tok(n):
    return [f"ExpoPushToken[{i}]" for i in range(n)]


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
