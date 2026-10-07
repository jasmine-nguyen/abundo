"""Acceptance test for the one shared BankSync request (WHIT-765).

`banksync_request` is the single place that sends a request to BankSync: the API key
header, our own User-Agent (Cloudflare blocks urllib's default), the timeout, and the
JSON parse of the reply. The balance fetch, sync trigger and pending mirror all go
through it. The method is covered by test_banksync_request_infers_method.py.
"""

from _http_fakes import FakeResponse


_REPLY = {"success": True, "data": {"id": "job-1"}}


def test_banksync_request_sends_key_agent_and_timeout_and_returns_parsed_json(shared, monkeypatch):
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
    )

    req = captured["req"]
    assert req.full_url == "https://example.test/v1/sync"
    assert req.get_header("X-api-key") == "the-key"
    assert req.get_header("User-agent") == "abundo-transaction-trigger"
    assert captured["timeout"] == 12
    assert out == _REPLY
