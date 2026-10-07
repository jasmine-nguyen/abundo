"""Acceptance test for WHIT-793: `banksync_request` infers the HTTP method from its body.

A caller that passes a body (the sync trigger's ``data=b""``) sends a POST; a caller that
passes none (the balance fetch, the pending mirror) sends a GET. No caller names the method.
"""

import pytest

from _http_fakes import FakeResponse


@pytest.mark.parametrize(
    ("kwargs", "method", "data"),
    [({}, "GET", None), ({"data": b""}, "POST", b"")],
)
def test_banksync_request_sends_post_when_given_a_body_and_get_otherwise(shared, monkeypatch, kwargs, method, data):
    sent = []
    monkeypatch.setattr(
        shared.balance_fetch.urllib.request,
        "urlopen",
        lambda req, timeout=None: sent.append(req) or FakeResponse({"success": True}),
    )

    out = shared.balance_fetch.banksync_request(
        "https://example.test/v1/sync",
        "the-key",
        user_agent="abundo-transaction-trigger",
        timeout=12,
        **kwargs,
    )

    assert sent[0].get_method() == method
    assert sent[0].data == data
    assert out == {"success": True}
