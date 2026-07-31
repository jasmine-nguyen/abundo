"""Shared fakes for the Anthropic client suites (test_anthropic_client.py +
its WHIT-388 gap file). The same urlopen stand-in and Messages-API envelope
builder were copy-defined in both; this is the single copy both import so the
response protocol only ever moves in one place (WHIT-390).

On the pytest path via `pythonpath = tests/shared` (pytest.ini), same as
_budget_endpoint_fakes.py.
"""

import json


class FakeResponse:
    """Stand-in for urlopen()'s return: a context manager whose .read() -> bytes."""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode() if payload is not None else b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def messages_payload(content):
    """An Anthropic Messages API envelope carrying `content` (a list of blocks)."""
    return {"content": content}
