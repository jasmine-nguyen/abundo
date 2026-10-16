"""WHIT-454 — the shared per-container API-key cache (fetch once, keyed BY PATH).

The webhook / sync-trigger / balance-poller / read API used to each copy this 6-line
SSM fetch+cache. It now lives here once. The cache is keyed by path because lambda_api
reads TWO keys (BankSync + Anthropic) in one process — a single un-keyed slot would
hand whichever key was fetched first to the other caller.
"""

import sys

import pytest


def test_fetches_once_then_serves_from_cache(api_key_module, monkeypatch):
    calls = []
    monkeypatch.setattr(api_key_module, "get_param", lambda path: calls.append(path) or "secret")

    assert api_key_module.get_api_key("/a/key") == "secret"
    assert api_key_module.get_api_key("/a/key") == "secret"
    assert calls == ["/a/key"]  # SSM read exactly once, then served from cache


def test_two_paths_are_cached_independently(api_key_module, monkeypatch):
    # The cross-key guard: two callers in one process must each get their OWN key.
    # Revert to a single un-keyed slot and the second path returns the first's key.
    keys = {"/bank/key": "bank-secret", "/anthropic/key": "anthropic-secret"}
    calls = []
    monkeypatch.setattr(api_key_module, "get_param",
                        lambda path: calls.append(path) or keys[path])

    assert api_key_module.get_api_key("/bank/key") == "bank-secret"
    assert api_key_module.get_api_key("/anthropic/key") == "anthropic-secret"
    # Re-reads served from cache, never crossing wires.
    assert api_key_module.get_api_key("/bank/key") == "bank-secret"
    assert api_key_module.get_api_key("/anthropic/key") == "anthropic-secret"
    assert calls == ["/bank/key", "/anthropic/key"]  # each path fetched exactly once


# --- folded from test_api_key_edges.py (WHIT-463) ---


def test_a_failed_path_is_not_cached_and_retries(api_key_module, monkeypatch):
    # [A-K1] A denied/missing SSM param must NOT be cached: the first call raises, and
    # a later call (once SSM recovers) must FETCH AGAIN and succeed. If a failure were
    # cached, either the error would stick or a None would be served forever.
    calls = []

    def flaky(path):
        calls.append(path)
        if len(calls) == 1:
            raise ValueError("throttled")
        return "recovered-key"

    monkeypatch.setattr(api_key_module, "get_param", flaky)

    with pytest.raises(ValueError):
        api_key_module.get_api_key("/bank/key")
    assert api_key_module.get_api_key("/bank/key") == "recovered-key"
    assert calls == ["/bank/key", "/bank/key"]  # fetched twice: failure wasn't cached


# --- WHIT-644: forget a rejected key so the next call re-reads SSM ---


def test_forget_makes_the_next_call_refetch(api_key_module, monkeypatch):
    keys = iter(["old-key", "new-key"])
    monkeypatch.setattr(api_key_module, "get_param", lambda path: next(keys))

    assert api_key_module.get_api_key("/bank/key") == "old-key"
    api_key_module.forget_api_key("/bank/key")
    assert api_key_module.get_api_key("/bank/key") == "new-key"


class _FakeSsmClient:
    def __init__(self, values, calls):
        self._values = values
        self._calls = calls

    def get_parameter(self, **kwargs):
        self._calls.append(kwargs)
        name = kwargs["Name"]
        if name not in self._values:
            raise sys.modules["botocore.exceptions"].ClientError("ParameterNotFound")
        return {"Parameter": {"Value": self._values[name]}}


def test_get_api_key_fetches_from_the_ssm_client(api_key_module, monkeypatch):
    calls = []
    services = []
    client = _FakeSsmClient({"/bank/key": "bank-secret"}, calls)

    def fake_client(service, *args, **kwargs):
        services.append(service)
        return client

    monkeypatch.setattr(sys.modules["boto3"], "client", fake_client, raising=False)

    with pytest.raises(ValueError, match="/missing"):
        api_key_module.get_api_key("/missing")

    assert api_key_module.get_api_key("/bank/key") == "bank-secret"

    assert set(services) == {"ssm"}
    assert calls[-1] == {"Name": "/bank/key", "WithDecryption": True}


def test_get_api_key_trims_whitespace_saved_around_the_ssm_value(api_key_module, monkeypatch):
    # ABU-81: the Anthropic key was re-saved with two trailing newlines; urllib then
    # rejected the header before any network call, so every AI request failed.
    client = _FakeSsmClient({"/bank/key": "sk-test\n\n"}, [])
    monkeypatch.setattr(sys.modules["boto3"], "client", lambda *a, **k: client, raising=False)

    assert api_key_module.get_api_key("/bank/key") == "sk-test"
