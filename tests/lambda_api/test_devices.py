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


# === adversarial edge cases (folded from test_devices_edge.py) — the length boundary
# (==256 accepted, 257 rejected), a JSON array body, an explicit null token, and the
# prefix-only validation (trailing junk accepted by design). ================================


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
