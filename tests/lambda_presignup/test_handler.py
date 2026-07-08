"""Tests for the Cognito Pre-Sign-Up allowlist lambda (WHIT-162).

The handler is the single-user gate: it allows a sign-up only if the email is on
the ALLOWED_EMAILS allowlist, and fails CLOSED (rejects) on anything else — a
non-allowlisted email, a missing/empty email, or an empty/missing allowlist. It
must behave identically across trigger sources (self-signup, admin-create, and —
the one that matters — federated ExternalProvider).
"""

import pytest

ALLOWED = "me.jasminenguyen@gmail.com"


def _event(email, trigger_source="PreSignUp_SignUp", email_verified=None):
    attrs = {"email": email}
    if email_verified is not None:
        attrs["email_verified"] = email_verified
    return {
        "triggerSource": trigger_source,
        "request": {"userAttributes": attrs},
    }


def test_allowlisted_email_passes(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    event = _event(ALLOWED)
    # Returning the event unchanged is how Cognito is told to ALLOW the sign-up.
    assert presignup.lambda_handler(event, None) is event


def test_case_insensitive_and_trimmed(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", "Me.JasmineNguyen@Gmail.com")
    event = _event("  me.jasminenguyen@GMAIL.com  ")
    assert presignup.lambda_handler(event, None) is event


def test_one_of_several_allowed_passes(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", "a@x.com, " + ALLOWED + " , b@y.com")
    assert presignup.lambda_handler(_event("b@y.com"), None) is not None


def test_non_allowlisted_email_rejected(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    with pytest.raises(Exception):
        presignup.lambda_handler(_event("intruder@evil.com"), None)


def test_external_provider_allowlisted_passes(presignup, monkeypatch):
    # Federated sign-ups must be email-verified as well as allowlisted (WHIT-173).
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    event = _event(ALLOWED, "PreSignUp_ExternalProvider", email_verified="true")
    assert presignup.lambda_handler(event, None) is event


def test_external_provider_non_allowlisted_rejected(presignup, monkeypatch):
    # The critical case: federated sign-up is the only path admin-create-only
    # cannot block, so a non-allowlisted Google/Apple account MUST be rejected here.
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    with pytest.raises(Exception):
        presignup.lambda_handler(_event("intruder@evil.com", "PreSignUp_ExternalProvider"), None)


def test_admin_create_allowlisted_passes(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    event = _event(ALLOWED, "PreSignUp_AdminCreateUser")
    assert presignup.lambda_handler(event, None) is event


def test_missing_email_rejected(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    with pytest.raises(Exception):
        presignup.lambda_handler({"request": {"userAttributes": {}}}, None)


def test_empty_email_rejected(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    with pytest.raises(Exception):
        presignup.lambda_handler(_event(""), None)


def test_malformed_event_rejected(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    with pytest.raises(Exception):
        presignup.lambda_handler({}, None)


def test_empty_allowlist_rejects_everyone(presignup, monkeypatch):
    # Fail-closed: an empty allowlist must not accidentally allow all.
    monkeypatch.setenv("ALLOWED_EMAILS", "")
    with pytest.raises(Exception):
        presignup.lambda_handler(_event(ALLOWED), None)


def test_missing_allowlist_env_rejects(presignup, monkeypatch):
    monkeypatch.delenv("ALLOWED_EMAILS", raising=False)
    with pytest.raises(Exception):
        presignup.lambda_handler(_event(ALLOWED), None)
