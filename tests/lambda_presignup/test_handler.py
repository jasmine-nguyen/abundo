"""Tests for the Cognito Pre-Sign-Up allowlist lambda (WHIT-162).

The handler is the single-user gate: it allows a sign-up only if the email is on
the ALLOWED_EMAILS allowlist, and fails CLOSED (rejects) on anything else — a
non-allowlisted email, a missing/empty email, or an empty/missing allowlist. It
must behave identically across trigger sources (self-signup, admin-create, and —
the one that matters — federated ExternalProvider).
"""

import pytest

ALLOWED = "me.jasminenguyen@gmail.com"
EXTERNAL = "PreSignUp_ExternalProvider"


def _event(email, trigger_source="PreSignUp_SignUp", email_verified=None):
    attrs = {"email": email}
    if email_verified is not None:
        attrs["email_verified"] = email_verified
    return {
        "triggerSource": trigger_source,
        "request": {"userAttributes": attrs},
    }


def _set_allowlist(monkeypatch, allowlist):
    if allowlist is None:
        monkeypatch.delenv("ALLOWED_EMAILS", raising=False)
        return
    monkeypatch.setenv("ALLOWED_EMAILS", allowlist)


@pytest.mark.parametrize(
    ("allowlist", "event"),
    [
        (ALLOWED, _event(ALLOWED)),
        ("Me.JasmineNguyen@Gmail.com", _event("  me.jasminenguyen@GMAIL.com  ")),
        ("a@x.com, " + ALLOWED + " , b@y.com", _event("b@y.com")),
        (" , ," + ALLOWED + ",,  ,", _event(ALLOWED, EXTERNAL, email_verified="true")),
        (ALLOWED, _event(ALLOWED, "PreSignUp_AdminCreateUser")),
        # Federated sign-ups must be email-verified as well as allowlisted (WHIT-173). Cognito
        # sends the flag as a bool for some IdPs and a (possibly padded, any-case) string for others.
        (ALLOWED, _event(ALLOWED, EXTERNAL, email_verified="true")),
        (ALLOWED, _event(ALLOWED, EXTERNAL, email_verified=True)),
        (ALLOWED, _event(ALLOWED, EXTERNAL, email_verified="  TRUE  ")),
        # The verified gate is ExternalProvider-only: a native sign-up is the trusted path.
        (ALLOWED, _event(ALLOWED, email_verified="false")),
    ],
    ids=["allowlisted", "case-and-trim", "one-of-several", "blank-and-trailing-comma-entries",
         "admin-create", "external-verified-string", "external-verified-bool", "external-verified-padded-upper",
         "native-signup-ignores-verified-flag"],
)
def test_allowed_sign_ups(presignup, monkeypatch, allowlist, event):
    _set_allowlist(monkeypatch, allowlist)
    # Returning the event unchanged is how Cognito is told to ALLOW the sign-up.
    assert presignup.lambda_handler(event, None) is event


@pytest.mark.parametrize(
    ("allowlist", "event"),
    [
        (ALLOWED, _event("intruder@evil.com")),
        # Federated sign-up is the only path admin-create-only cannot block.
        (ALLOWED, _event("intruder@evil.com", EXTERNAL, email_verified="true")),
        (ALLOWED, {"request": {"userAttributes": {}}}),
        (ALLOWED, _event("")),
        (ALLOWED, _event("   \t  ", EXTERNAL)),
        (ALLOWED, {}),
        ("", _event(ALLOWED)),
        (None, _event(ALLOWED)),
        (",  , ,", _event("", EXTERNAL)),
        # An IdP could map `email` to a non-string: fail closed, never coerce it into a pass.
        (ALLOWED, _event([ALLOWED], EXTERNAL)),
        (ALLOWED, _event({"addr": ALLOWED}, EXTERNAL)),
        (ALLOWED, _event(12345, EXTERNAL)),
        (ALLOWED, _event(ALLOWED, EXTERNAL, email_verified="false")),
        (ALLOWED, _event(ALLOWED, EXTERNAL)),
        (ALLOWED, _event(ALLOWED, EXTERNAL, email_verified=False)),
    ],
    ids=["not-allowlisted", "external-not-allowlisted", "missing-email", "empty-email",
         "whitespace-only-email", "malformed-event", "empty-allowlist", "missing-allowlist-env",
         "blank-only-allowlist-and-empty-email", "email-list","email-dict",
         "email-int", "external-unverified", "external-missing-verified", "external-verified-bool-false"],
)
def test_rejected_sign_ups(presignup, monkeypatch, allowlist, event):
    _set_allowlist(monkeypatch, allowlist)
    with pytest.raises(Exception):
        presignup.lambda_handler(event, None)
