"""Shared fakes for the Anthropic client suites (test_anthropic_client.py +
its WHIT-388 gap file): the Messages-API envelope builders. The urlopen
stand-in lives in _http_fakes.py (WHIT-755). The chat tool-loop suites use
ScriptedModel in place of anthropic_client.post_messages (WHIT-807).

On the pytest path via `pythonpath = tests/shared` (pytest.ini), same as
_budget_endpoint_fakes.py.
"""

import copy
import json

import _http_fakes


def messages_payload(content):
    """An Anthropic Messages API envelope carrying `content` (a list of blocks)."""
    return {"content": content}


def text_payload(text):
    """A Messages API success envelope carrying a single text block of `text`."""
    return messages_payload([{"type": "text", "text": text}])


def tool_use_block(name, tool_input, call_id="c1"):
    """One tool_use content block."""
    return {"type": "tool_use", "id": call_id, "name": name, "input": tool_input}


def tool_reply(*blocks, stop_reason="tool_use"):
    """A post_messages reply envelope carrying `blocks`."""
    return {"content": list(blocks), "stop_reason": stop_reason}


class ScriptedModel:
    """Stands in for post_messages: plays back one reply per call and records each request
    (messages deep-copied, since the loop keeps appending to the list it sent)."""

    def __init__(self, replies):
        self._replies = list(replies)
        self.requests = []

    def __call__(self, system, messages, tools, max_tokens, timeout):
        self.requests.append({"system": system, "messages": copy.deepcopy(messages), "tools": tools,
                              "max_tokens": max_tokens, "timeout": timeout})
        return self._replies.pop(0)

    @property
    def timeouts(self):
        return [request["timeout"] for request in self.requests]


def capture_urlopen(client, monkeypatch, payload):
    """Fake the client's urlopen to answer `payload`; returns the dict it fills with the request's
    url, headers, JSON body and timeout."""
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["timeout"] = timeout
        captured["headers"] = req.headers
        captured["body"] = json.loads(req.data.decode())
        return _http_fakes.FakeResponse(payload)

    monkeypatch.setattr(client.urllib.request, "urlopen", fake_urlopen)
    return captured
