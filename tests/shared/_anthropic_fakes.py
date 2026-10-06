"""Shared fakes for the Anthropic client suites (test_anthropic_client.py +
its WHIT-388 gap file): the Messages-API envelope builders. The urlopen
stand-in lives in _http_fakes.py (WHIT-755).

On the pytest path via `pythonpath = tests/shared` (pytest.ini), same as
_budget_endpoint_fakes.py.
"""


def messages_payload(content):
    """An Anthropic Messages API envelope carrying `content` (a list of blocks)."""
    return {"content": content}


def text_payload(text):
    """A Messages API success envelope carrying a single text block of `text`."""
    return messages_payload([{"type": "text", "text": text}])
