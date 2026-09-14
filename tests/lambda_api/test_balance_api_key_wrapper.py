"""WHIT-535 — the balance-refresh get_api_key wrapper (kept, replacing the one from the deleted
banksync_enrichments proxy).

handler.get_api_key() is now a thin wrapper over shared/api_key.get_api_key passing THIS lambda's
own SSM path (AGENTS.md landmine: lambda_api reads BOTH the BankSync and Anthropic keys in one
process, so the wrong path would fetch the Anthropic key for the balance refresh). The balance
tests monkeypatch handler.get_api_key wholesale, so nothing pins the path the wrapper actually
passes — this does. Mirrors test_anthropic_client.test_get_api_key_reads_the_anthropic_path.
"""


def test_get_api_key_reads_the_banksync_path(handler, monkeypatch):
    # FAIL-ON-REVERT: point the wrapper at any other path (e.g. ANTHROPIC_API_KEY_PATH) and the
    # recorded path stops equalling BANKSYNC_API_KEY_PATH.
    import api_key
    api_key._cache.clear()  # never inherit a cached key from a sibling test
    calls = []
    monkeypatch.setattr(api_key, "get_param", lambda path: calls.append(path) or "bank-key")

    assert handler.get_api_key() == "bank-key"
    assert calls == [handler.BANKSYNC_API_KEY_PATH]
    assert handler.BANKSYNC_API_KEY_PATH == "/abundo/banksync-api-key"
