"""Tests for POST /devices (register an Expo push token) in lambda_api/handler.py.

The handler builds a DeviceRepository() internally, so each test monkeypatches
``handler.DeviceRepository`` to a recording fake — no DynamoDB.
"""

import json

import pytest

from _api_event import api_event


class _FakeDeviceRepo:
    def __init__(self):
        self.registered = []

    def register(self, token):
        self.registered.append(token)


def _post(token=None, raw=None):
    body = raw if raw is not None else json.dumps({"token": token})
    return api_event("POST", "/devices", raw=body)


def _expo_token_of_length(n):
    # "ExpoPushToken[" (14) + fill + "]" (1) == n total.
    fill = n - len("ExpoPushToken[") - len("]")
    return "ExpoPushToken[" + "x" * fill + "]"


@pytest.fixture
def device_repo(handler, monkeypatch):
    repo = _FakeDeviceRepo()
    monkeypatch.setattr(handler, "DeviceRepository", lambda: repo)
    return repo


@pytest.mark.parametrize(("sent", "stored"), [
    ("ExpoPushToken[abc123]", "ExpoPushToken[abc123]"),
    ("  ExponentPushToken[xyz]  ", "ExponentPushToken[xyz]"),   # the older prefix, trimmed
    (_expo_token_of_length(256), _expo_token_of_length(256)),    # exactly EXPO_TOKEN_MAX_LEN
])
def test_accepts_valid_expo_tokens(handler, device_repo, sent, stored):
    resp = handler.lambda_handler(_post(sent), None)
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"token": stored}
    assert device_repo.registered == [stored]


@pytest.mark.parametrize("event", [
    _post(raw=json.dumps({})),                    # missing token
    _post("just-some-string"),                    # not an Expo token
    _post(_expo_token_of_length(257)),            # one over the max length
    _post(raw="{not json"),
])
def test_rejects_bad_tokens_without_registering(handler, device_repo, event):
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 400
    assert device_repo.registered == []
