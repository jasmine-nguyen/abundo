"""WHIT-454 — the shared per-container API-key cache (fetch once, keyed BY PATH).

The webhook / sync-trigger / balance-poller / read API used to each copy this 6-line
SSM fetch+cache. It now lives here once. The cache is keyed by path because lambda_api
reads TWO keys (BankSync + Anthropic) in one process — a single un-keyed slot would
hand whichever key was fetched first to the other caller.
"""

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


def test_a_fetch_failure_propagates(api_key_module, monkeypatch):
    # No swallowing: a bad/denied SSM param must raise out so callers surface it.
    monkeypatch.setattr(api_key_module, "get_param",
                        lambda path: (_ for _ in ()).throw(ValueError("no such param")))

    with pytest.raises(ValueError):
        api_key_module.get_api_key("/missing")
