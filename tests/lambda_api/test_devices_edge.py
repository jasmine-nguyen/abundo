"""Adversarial edge-case tests for POST /devices (lambda_api/handler.py).

Companion to test_devices.py, which locks the happy path, idempotency and the
common 400s. This file covers the GAPS: the length boundary (==256 accepted,
257 rejected), a JSON body that parses but isn't an object (array), an explicit
null token, and the fact that validation is prefix-only (trailing junk after the
bracket is accepted by design). Every case runs the real handler.lambda_handler.
"""

import json


class _FakeDeviceRepo:
    def __init__(self):
        self.registered = []

    def register(self, token):
        self.registered.append(token)


def _post(token=None, raw=None):
    body = raw if raw is not None else json.dumps({"token": token})
    return {
        "rawPath": "/devices",
        "requestContext": {"http": {"method": "POST"}},
        "body": body,
    }


def _expo_token_of_length(n):
    # "ExpoPushToken[" (14) + fill + "]" (1) == n total.
    fill = n - len("ExpoPushToken[") - len("]")
    return "ExpoPushToken[" + "x" * fill + "]"


def test_token_at_max_length_is_accepted(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    token = _expo_token_of_length(handler.EXPO_TOKEN_MAX_LEN)  # exactly 256
    assert len(token) == handler.EXPO_TOKEN_MAX_LEN
    resp = handler.lambda_handler(_post(token), None)
    assert resp["statusCode"] == 200
    assert repo.registered == [token]


def test_token_one_over_max_length_is_400(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    token = _expo_token_of_length(handler.EXPO_TOKEN_MAX_LEN + 1)  # 257
    resp = handler.lambda_handler(_post(token), None)
    assert resp["statusCode"] == 400
    assert repo.registered == []


def test_json_array_body_is_400(handler, monkeypatch):
    # Valid JSON but not an object -> _parse_json_body rejects before token lookup.
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post(raw=json.dumps(["ExpoPushToken[a]"])), None)
    assert resp["statusCode"] == 400
    assert repo.registered == []


def test_null_token_is_400(handler, monkeypatch):
    # {"token": null} -> body.get("token") is None -> not a str -> 400, no register.
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post(raw=json.dumps({"token": None})), None)
    assert resp["statusCode"] == 400
    assert repo.registered == []


def test_prefix_with_trailing_junk_is_accepted(handler, monkeypatch):
    # Validation is prefix + length only, so a right-prefixed token with trailing
    # junk is accepted by design. Locks that behaviour (a stricter regex would
    # trip this and prompt a deliberate spec update).
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post("ExpoPushToken[abc]garbage"), None)
    assert resp["statusCode"] == 200
    assert repo.registered == ["ExpoPushToken[abc]garbage"]
