"""WHIT-832 QA — the balance refresh through the REAL shared fetch_balance.

Every other refresh suite stubs `fetch_balance` with a `**kw` fake, so a stale keyword the shared
signature no longer takes (e.g. `base_url=`) would pass them all and fail every account live.
"""

import urllib.request

from _balance_fakes import LIVE_PAYLOADS, REFRESH_EVENT, balance_repo, freeze_time, stub_bank
from _http_fakes import FakeResponse


def test_refresh_requests_each_balance_from_banksync_with_the_api_ua_and_timeout(handler, monkeypatch):
    # [A1] FAIL-ON-REVERT: pass base_url= again (or build the URL by hand) and every account
    # fails, so no request lands here and the refresh is not a 200 with all four accounts.
    requests = []

    def fake_urlopen(req, timeout=None):
        requests.append((req, timeout))
        aid = req.full_url.split("/accounts/")[1].split("/")[0]
        return FakeResponse(LIVE_PAYLOADS[aid])

    repo = balance_repo(rows=[], last=None)
    monkeypatch.setattr(handler, "AccountBalanceRepository", lambda: repo)
    freeze_time(handler, monkeypatch, 1_000_000)
    stub_bank(handler, monkeypatch, handler.fetch_balance)
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    resp = handler.lambda_handler(REFRESH_EVENT, None)

    assert resp["statusCode"] == 200
    expected_urls = {
        f"https://api.banksync.io/v1/banks/{source['bid']}/accounts/{source['aid']}/balances"
        for source in handler.BALANCE_SOURCES
    }
    assert {req.full_url for req, _ in requests} == expected_urls
    for req, timeout in requests:
        assert req.get_method() == "GET"
        assert req.get_header("X-api-key") == "test-key"
        assert req.get_header("User-agent") == handler.BANKSYNC_USER_AGENT
        assert timeout == handler.REFRESH_FETCH_TIMEOUT_SECONDS
