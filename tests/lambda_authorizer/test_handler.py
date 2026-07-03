"""Unit tests for the API Gateway shared-secret authorizer.

Covers the allow/deny decision, header parsing (case + Bearer prefix), and the
per-container token cache. No AWS: `ssm` is faked by conftest.py and the token is
monkeypatched per test.
"""


def _event(auth=None, header_key="authorization"):
    headers = {}
    if auth is not None:
        headers[header_key] = auth
    return {"headers": headers}


def test_valid_token_is_authorized(authorizer, monkeypatch):
    monkeypatch.setattr(authorizer, "get_param", lambda path: "s3cret")
    resp = authorizer.lambda_handler(_event("Bearer s3cret"), None)
    assert resp == {"isAuthorized": True}


def test_wrong_token_is_denied(authorizer, monkeypatch):
    monkeypatch.setattr(authorizer, "get_param", lambda path: "s3cret")
    resp = authorizer.lambda_handler(_event("Bearer nope"), None)
    assert resp == {"isAuthorized": False}


def test_missing_header_is_denied(authorizer, monkeypatch):
    # No Authorization at all: denied without ever fetching the token.
    calls = []
    monkeypatch.setattr(authorizer, "get_param", lambda path: calls.append(path) or "s3cret")
    resp = authorizer.lambda_handler(_event(None), None)
    assert resp == {"isAuthorized": False}
    assert calls == []  # short-circuits before the SSM read


def test_missing_bearer_prefix_is_denied(authorizer, monkeypatch):
    # A bare token without the "Bearer " scheme is not accepted.
    monkeypatch.setattr(authorizer, "get_param", lambda path: "s3cret")
    resp = authorizer.lambda_handler(_event("s3cret"), None)
    assert resp == {"isAuthorized": False}


def test_uppercase_header_key_is_accepted(authorizer, monkeypatch):
    # HTTP API lowercases header names, but accept either casing.
    monkeypatch.setattr(authorizer, "get_param", lambda path: "s3cret")
    resp = authorizer.lambda_handler(_event("Bearer s3cret", header_key="Authorization"), None)
    assert resp == {"isAuthorized": True}


def test_token_is_cached(authorizer, monkeypatch):
    calls = []
    monkeypatch.setattr(authorizer, "get_param", lambda path: calls.append(path) or "s3cret")

    authorizer.lambda_handler(_event("Bearer s3cret"), None)
    authorizer.lambda_handler(_event("Bearer s3cret"), None)

    assert len(calls) == 1  # second decision reuses the cached token
    assert calls == [authorizer.API_AUTH_TOKEN_PATH]
