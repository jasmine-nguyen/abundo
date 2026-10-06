"""Acceptance test for the one shared BankSync request (WHIT-765).

`banksync_request` is the single place that sends a request to BankSync: the API key
header, our own User-Agent (Cloudflare blocks urllib's default), the method, body and
timeout, and the JSON parse of the reply. The balance fetch, sync trigger and pending
mirror all go through it.
"""

import pytest

from _http_fakes import FakeResponse


_REPLY = {"success": True, "data": {"id": "job-1"}}


@pytest.mark.parametrize(
    ("kwargs", "method", "data"),
    [({}, "GET", None), ({"method": "POST", "data": b""}, "POST", b"")],
)
def test_banksync_request_sends_key_agent_method_body_and_returns_parsed_json(shared, monkeypatch, kwargs, method, data):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["req"] = req
        captured["timeout"] = timeout
        return FakeResponse(_REPLY)

    monkeypatch.setattr(shared.balance_fetch.urllib.request, "urlopen", fake_urlopen)

    out = shared.balance_fetch.banksync_request(
        "https://example.test/v1/sync",
        "the-key",
        user_agent="abundo-transaction-trigger",
        timeout=12,
        **kwargs,
    )

    req = captured["req"]
    assert req.full_url == "https://example.test/v1/sync"
    assert req.get_method() == method
    assert req.data == data
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "abundo-transaction-trigger"
    assert captured["timeout"] == 12
    assert out == _REPLY
