"""WHIT-793: send_push has no test-only options; it reads the token and stores itself.

The token reader and both stores are module-level names in push, patched here.
"""

from _http_fakes import FakeResponse


class _RecordingDeviceRepo:
    removed = []

    def remove(self, token):
        self.removed.append(token)


class _RecordingReceiptRepo:
    put_calls = []

    def put(self, receipt_id, token):
        self.put_calls.append((receipt_id, token))


def test_send_push_sends_prunes_dead_tokens_and_stashes_receipts(shared, monkeypatch):
    push = shared.push
    _RecordingDeviceRepo.removed = []
    _RecordingReceiptRepo.put_calls = []
    monkeypatch.setattr(push, "get_access_token", lambda: "expo-token")
    monkeypatch.setattr(push, "DeviceRepository", _RecordingDeviceRepo)
    monkeypatch.setattr(push, "PushReceiptRepository", _RecordingReceiptRepo)
    requests = []

    def fake_urlopen(req, timeout=None):
        requests.append(req)
        return FakeResponse({"data": [
            {"status": "ok", "id": "receipt-1"},
            {"status": "error", "details": {"error": "DeviceNotRegistered"}},
        ]})

    monkeypatch.setattr(push.urllib.request, "urlopen", fake_urlopen)

    out = push.send_push("T", "B", ["ExpoPushToken[live]", "ExpoPushToken[dead]"],
                         data={"type": "budget"})

    assert out == {"sent": 2, "ok": 1, "pruned": ["ExpoPushToken[dead]"]}
    assert len(requests) == 1
    assert requests[0].get_header("Authorization") == "Bearer expo-token"
    assert _RecordingDeviceRepo.removed == ["ExpoPushToken[dead]"]
    assert _RecordingReceiptRepo.put_calls == [("receipt-1", "ExpoPushToken[live]")]
