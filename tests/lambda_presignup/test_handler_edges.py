"""Adversarial gap tests for the Pre-Sign-Up allowlist lambda (WHIT-162).

The implementer's test_handler.py locks the core allow/reject table. This file adds
the fail-closed edges it doesn't cover: a non-string email type, a whitespace-only
email, allowlist strings with blank/trailing-comma entries, that a pass does NOT
mutate the event (no response fields injected), and that an unverified email is
gated on the address alone. Every case is fail-on-revert: loosening the gate flips
a reject to a pass (or a raise to a return).
"""

import copy

import pytest

ALLOWED = "me.jasminenguyen@gmail.com"


def _event(email, trigger_source="PreSignUp_ExternalProvider", email_verified=None):
    attrs = {"email": email}
    if email_verified is not None:
        attrs["email_verified"] = email_verified
    return {"triggerSource": trigger_source, "request": {"userAttributes": attrs}}


def test_non_string_email_type_is_rejected(presignup, monkeypatch):
    # A federated provider could map `email` to a list/None/number. The gate must
    # fail CLOSED, never crash open or coerce a list into a passing value.
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    for bad in ([ALLOWED], {"addr": ALLOWED}, 12345, ["a", "b"]):
        with pytest.raises(Exception):
            presignup.lambda_handler(_event(bad), None)


def test_whitespace_only_email_is_rejected(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    with pytest.raises(Exception):
        presignup.lambda_handler(_event("   \t  "), None)


def test_allowlist_with_blank_and_trailing_comma_entries_still_gates(presignup, monkeypatch):
    # Blank entries / trailing commas must not sneak an empty string into the set
    # (which an empty email could otherwise match). The real email still passes.
    monkeypatch.setenv("ALLOWED_EMAILS", " , ," + ALLOWED + ",,  ,")
    assert presignup.lambda_handler(_event(ALLOWED), None) is not None


def test_blank_allowlist_entries_do_not_admit_empty_email(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", ",  , ,")
    with pytest.raises(Exception):
        presignup.lambda_handler(_event(""), None)


def test_pass_does_not_mutate_the_event(presignup, monkeypatch):
    # Cognito reads back event["response"]; the handler must return the event
    # unchanged and inject nothing (no autoConfirm/autoVerify side effects).
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    event = _event(ALLOWED)
    before = copy.deepcopy(event)
    result = presignup.lambda_handler(event, None)
    assert result is event
    assert event == before


def test_gate_keys_on_email_only_ignoring_verified_flag(presignup, monkeypatch):
    # The gate is the email allowlist; an explicit email_verified=false does not by
    # itself flip an allowlisted email to reject (documents the current contract so
    # a future email_verified check is a deliberate change, not a silent regression).
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    assert presignup.lambda_handler(_event(ALLOWED, email_verified="false"), None) is not None
    with pytest.raises(Exception):
        presignup.lambda_handler(_event("intruder@evil.com", email_verified="true"), None)
