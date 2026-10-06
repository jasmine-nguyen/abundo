"""QA gap test for WHIT-765: each webhook secret reads its own SSM path through the shared cache."""


# [A9] (P1) the three secrets never hand one path's value to another
def test_each_webhook_secret_reads_its_own_path(lam, monkeypatch):
    up = lam.up_webhook
    handler = lam.handler
    monkeypatch.setattr(lam.api_key, "get_param", lambda path: f"value-of-{path}")

    assert handler.get_webhook_signing_secret() == f"value-of-{handler.BANKSYNC_WEBHOOK_SECRET_PATH}"
    assert up.get_signing_secret() == f"value-of-{up.UP_WEBHOOK_SIGNING_SECRET_PATH}"
    assert up.get_personal_access_token() == f"value-of-{up.UP_PERSONAL_ACCESS_TOKEN_PATH}"
