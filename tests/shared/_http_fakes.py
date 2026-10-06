"""Shared HTTP fakes for every server suite that stubs urllib (WHIT-755).

On the pytest path via `pythonpath = tests/shared` (pytest.ini).
"""

import io
import json
import urllib.error

UP_API_URL = "https://api.up.com.au/x"


class FakeResponse:
    """Stand-in for urlopen()'s return: a context manager whose .read() -> bytes."""

    def __init__(self, payload=None):
        self._body = json.dumps(payload).encode() if payload is not None else b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def http_error(code, url="https://api.banksync.io/x"):
    """A urllib HTTPError with status `code` and an empty body."""
    return urllib.error.HTTPError(url, code, "boom", None, io.BytesIO(b""))
