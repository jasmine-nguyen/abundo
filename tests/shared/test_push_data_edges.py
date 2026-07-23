"""WHIT-321 — adversarial gaps for the optional ``data`` payload on send_push.

The implementer's test_data_payload_is_attached_to_every_message covers a single
batch. These lock the two branches it leaves open:
  * data must ride on EVERY message across MULTIPLE Expo batches (the attach loop is
    inside the per-batch loop);
  * a FALSY data ({}) must be omitted entirely, keeping the message byte-identical to
    the no-data path (the ``if data:`` guard).
Reuses the shared-suite conftest fixtures/fakes (import boto3 at load, etc.).
"""

import json

from test_push import _FakeResponse, _RecordingRepo, _tickets


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
