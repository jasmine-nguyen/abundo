"""QA gap tests for WHIT-765: the webhook secrets now live in the one shared SSM cache.

Two lambdas (BankSync webhook, Up webhook) and three paths share `api_key._cache` in
one process, so these lock that each reads its own path once, and that dropping a
rejected Up token leaves every other cached secret alone.
"""


def _recording_ssm(lam, monkeypatch, values):
    reads = []
    monkeypatch.setattr(lam.api_key, "get_param", lambda path: reads.append(path) or values[path])
    return reads


# [A7] (P0) the BankSync webhook secret is read from its SSM path once per container
def test_webhook_signing_secret_is_read_from_ssm_once(lam, monkeypatch):
    handler = lam.handler
    reads = _recording_ssm(lam, monkeypatch, {handler.BANKSYNC_WEBHOOK_SECRET_PATH: "banksync-signing"})

    assert handler.get_webhook_signing_secret() == "banksync-signing"
    assert handler.get_webhook_signing_secret() == "banksync-signing"
    assert reads == [handler.BANKSYNC_WEBHOOK_SECRET_PATH]


# [A8] (P0) forgetting a rejected Up token drops only that token; the Up signing secret
# and the BankSync webhook secret stay cached (no extra SSM reads)
def test_clearing_the_up_token_keeps_the_other_secrets_cached(lam, monkeypatch):
    up = lam.up_webhook
    handler = lam.handler
    values = {
        up.UP_WEBHOOK_SIGNING_SECRET_PATH: "up-signing",
        up.UP_PERSONAL_ACCESS_TOKEN_PATH: "up-pat",
        handler.BANKSYNC_WEBHOOK_SECRET_PATH: "banksync-signing",
    }
    reads = _recording_ssm(lam, monkeypatch, values)
    up.get_signing_secret()
    up.get_personal_access_token()
    handler.get_webhook_signing_secret()
    reads.clear()

    up.clear_personal_access_token()

    assert up.get_signing_secret() == "up-signing"
    assert handler.get_webhook_signing_secret() == "banksync-signing"
    assert reads == []
    assert up.get_personal_access_token() == "up-pat"
    assert reads == [up.UP_PERSONAL_ACCESS_TOKEN_PATH]


# [A9] (P1) the three secrets never hand one path's value to another
def test_each_webhook_secret_reads_its_own_path(lam, monkeypatch):
    up = lam.up_webhook
    handler = lam.handler
    monkeypatch.setattr(lam.api_key, "get_param", lambda path: f"value-of-{path}")

    assert handler.get_webhook_signing_secret() == f"value-of-{handler.BANKSYNC_WEBHOOK_SECRET_PATH}"
    assert up.get_signing_secret() == f"value-of-{up.UP_WEBHOOK_SIGNING_SECRET_PATH}"
    assert up.get_personal_access_token() == f"value-of-{up.UP_PERSONAL_ACCESS_TOKEN_PATH}"
