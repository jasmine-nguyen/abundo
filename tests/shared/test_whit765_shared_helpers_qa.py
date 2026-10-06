"""QA gap test for WHIT-765: banksync_request's error path."""

import pytest

from _http_fakes import http_error


# [A2] (P0) an HTTP error reaches the caller (sync trigger's 409 skip depends on it)
def test_banksync_request_lets_http_errors_through(shared, monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise http_error(409)

    monkeypatch.setattr(shared.balance_fetch.urllib.request, "urlopen", fake_urlopen)

    with pytest.raises(shared.balance_fetch.urllib.error.HTTPError) as raised:
        shared.balance_fetch.banksync_request("https://example.test/x", "k", user_agent="ua", timeout=3)
    assert raised.value.code == 409
