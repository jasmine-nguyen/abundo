"""WHIT-755 slice 1: one shared fake bank reply (FakeResponse) and fake HTTP error (http_error).

The shared fakes in tests/shared/_http_fakes.py behave like the copies they replace.
"""

import urllib.error


def test_fake_bank_reply_and_error_come_from_one_shared_module():
    from _http_fakes import FakeResponse, http_error

    with FakeResponse({"data": {"id": "job-1"}}) as response:
        assert response.read() == b'{"data": {"id": "job-1"}}'
    assert FakeResponse().read() == b""
    assert FakeResponse(None).read() == b""
    assert FakeResponse({}).__exit__(None, None, None) is False

    error = http_error(401)
    assert isinstance(error, urllib.error.HTTPError)
    assert error.code == 401
    assert error.url == "https://api.banksync.io/x"
    assert error.read() == b""

    up_error = http_error(500, url="https://api.up.com.au/x")
    assert up_error.code == 500
    assert up_error.url == "https://api.up.com.au/x"
