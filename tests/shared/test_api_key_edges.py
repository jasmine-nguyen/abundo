"""WHIT-454 — path-keyed API-key cache: cross-path FAILURE isolation.

The implementer's tests/shared/test_api_key.py covers fetch-once, two-paths-cached-
independently (order A-then-B), and failure-propagates. These add the gap it leaves:
a fetch FAILURE for one path must neither poison another path nor get itself cached
(so it can retry). Reuses the `api_key_module` fixture, which hands over the shared
module with a freshly CLEARED path cache — without that reset a key leaked by an
earlier test would make these falsely green."""

import pytest


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
