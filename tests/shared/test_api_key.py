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


def test_failure_for_one_path_does_not_poison_another_path(api_key_module, monkeypatch):
    # [A-K2] Single-process cross-key safety: lambda_api reads BankSync AND Anthropic in
    # one container. A failing fetch for path A must leave path B fetchable and correct,
    # and must not have stored A's slot as B's key. Order: A fails first, then B.
    def selective(path):
        if path == "/bad":
            raise ValueError("no such param")
        return f"key-for::{path}"

    monkeypatch.setattr(api_key_module, "get_param", selective)

    with pytest.raises(ValueError):
        api_key_module.get_api_key("/bad")
    assert api_key_module.get_api_key("/good") == "key-for::/good"
    # B did not inherit A's (absent) slot, and A remains un-cached / re-raisable.
    assert "/bad" not in api_key_module._cache
    assert api_key_module._cache["/good"] == "key-for::/good"
