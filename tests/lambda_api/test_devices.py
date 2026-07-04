"""Tests for POST /devices (register an Expo push token) in lambda_api/handler.py.

The handler builds a DeviceRepository() internally, so each test monkeypatches
``handler.DeviceRepository`` to a recording fake — no DynamoDB. Locks the happy
path, idempotency (the DB dedupes; the handler just calls register), and every
400 (missing/blank/non-string token, non-Expo prefix, bad JSON). A GET falls
through to 404.
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


def test_registers_a_valid_expo_token(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post("ExpoPushToken[abc123]"), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"token": "ExpoPushToken[abc123]"}
    assert repo.registered == ["ExpoPushToken[abc123]"]


def test_accepts_the_exponent_prefix_and_trims(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post("  ExponentPushToken[xyz]  "), None)
    assert resp["statusCode"] == 200
    assert repo.registered == ["ExponentPushToken[xyz]"]   # trimmed


def test_re_registering_the_same_token_is_accepted(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    handler.lambda_handler(_post("ExpoPushToken[abc]"), None)
    resp = handler.lambda_handler(_post("ExpoPushToken[abc]"), None)
    assert resp["statusCode"] == 200   # idempotent at the store; handler just re-calls


def test_missing_token_is_400(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post(raw=json.dumps({})), None)
    assert resp["statusCode"] == 400
    assert repo.registered == []


def test_blank_token_is_400(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post("   "), None)
    assert resp["statusCode"] == 400
    assert repo.registered == []


def test_non_string_token_is_400(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post(raw=json.dumps({"token": 12345})), None)
    assert resp["statusCode"] == 400
    assert repo.registered == []


def test_non_expo_token_is_400(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post("just-some-string"), None)
    assert resp["statusCode"] == 400
    assert repo.registered == []


def test_over_long_token_is_400(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    huge = "ExpoPushToken[" + "x" * 300 + "]"
    resp = handler.lambda_handler(_post(huge), None)
    assert resp["statusCode"] == 400
    assert repo.registered == []


def test_invalid_json_body_is_400(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    resp = handler.lambda_handler(_post(raw="{not json"), None)
    assert resp["statusCode"] == 400
    assert repo.registered == []


def test_get_devices_falls_through_to_404(handler):
    resp = handler.lambda_handler(
        {"rawPath": "/devices", "requestContext": {"http": {"method": "GET"}}}, None)
    assert resp["statusCode"] == 404
