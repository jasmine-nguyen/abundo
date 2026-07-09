"""Adversarial gap tests for the Pre-Sign-Up allowlist lambda (WHIT-162).

The implementer's test_handler.py locks the core allow/reject table. This file adds
the fail-closed edges it doesn't cover: a non-string email type, a whitespace-only
email, allowlist strings with blank/trailing-comma entries, that a pass does NOT
mutate the event (no response fields injected), and that a federated (ExternalProvider)
sign-up must ALSO be email-verified (WHIT-173). Every case is fail-on-revert: loosening
the gate flips a reject to a pass (or a raise to a return).
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
    assert presignup.lambda_handler(_event(ALLOWED, email_verified="true"), None) is not None


def test_blank_allowlist_entries_do_not_admit_empty_email(presignup, monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", ",  , ,")
    with pytest.raises(Exception):
        presignup.lambda_handler(_event(""), None)


def test_pass_does_not_mutate_the_event(presignup, monkeypatch):
    # Cognito reads back event["response"]; the handler must return the event
    # unchanged and inject nothing (no autoConfirm/autoVerify side effects).
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    event = _event(ALLOWED, email_verified="true")
    before = copy.deepcopy(event)
    result = presignup.lambda_handler(event, None)
    assert result is event
    assert event == before


def test_external_provider_unverified_email_is_rejected(presignup, monkeypatch):
    # WHIT-173: a federated (ExternalProvider) sign-up must ALSO be email-verified —
    # the allowlist alone is not enough for an IdP-asserted identity. An allowlisted
    # address with email_verified="false" is rejected (fail-on-revert: dropping the
    # verified gate flips this raise back to a pass). A non-allowlisted address is
    # still rejected by the allowlist regardless of the verified flag.
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    with pytest.raises(Exception):
        presignup.lambda_handler(_event(ALLOWED, email_verified="false"), None)
    with pytest.raises(Exception):
        presignup.lambda_handler(_event("intruder@evil.com", email_verified="true"), None)


def test_external_provider_missing_verified_attr_is_rejected(presignup, monkeypatch):
    # Fail-closed: if the IdP mapping never populates email_verified, the attribute is
    # absent and the federated sign-up must be rejected, not waved through.
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    with pytest.raises(Exception):
        presignup.lambda_handler(_event(ALLOWED), None)


def test_external_provider_verified_bool_true_passes(presignup, monkeypatch):
    # Cognito passes email_verified as a bool for some IdPs and the string "true" for
    # others; the gate accepts both. (Fail-on-revert of the tolerant coercion: a strict
    # `== "true"` check would reject the boolean and flip this pass to a raise.)
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    assert presignup.lambda_handler(_event(ALLOWED, email_verified=True), None) is not None


def test_external_provider_verified_true_with_surrounding_whitespace_passes(presignup, monkeypatch):
    # Fail-on-revert of the `.strip()` in the gate: an IdP that pads the claim (" true ")
    # must still pass. Dropping .strip() flips this pass -> a raise and locks out the
    # real user.
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    event = _event(ALLOWED, email_verified="  true  ")
    assert presignup.lambda_handler(event, None) is event


def test_external_provider_verified_uppercase_true_passes(presignup, monkeypatch):
    # Fail-on-revert of the `.lower()` in the gate: the documented contract accepts
    # "TRUE". Dropping .lower() flips this pass -> a raise.
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    assert presignup.lambda_handler(_event(ALLOWED, email_verified="TRUE"), None) is not None


def test_external_provider_verified_bool_false_is_rejected(presignup, monkeypatch):
    # Fail-on-revert of the verified gate for the BOOLEAN shape: str(False).lower() ==
    # "false" must reject. A truthiness-only bug (`if not email_verified`) would keep
    # this passing while breaking the string case, so both shapes are pinned.
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    with pytest.raises(Exception):
        presignup.lambda_handler(_event(ALLOWED, email_verified=False), None)


def test_native_signup_is_not_gated_by_verified_flag(presignup, monkeypatch):
    # The verified gate is ExternalProvider-only. A native SRP sign-up carrying
    # email_verified="false" must still PASS (trusted path). Fail-on-revert of the
    # `triggerSource == "PreSignUp_ExternalProvider"` scope: broadening the guard to
    # native SignUp flips this pass -> a raise. (Replaces the semantics of the deleted
    # gate-keys-on-email-only characterization test, for the correct source.)
    monkeypatch.setenv("ALLOWED_EMAILS", ALLOWED)
    event = _event(ALLOWED, "PreSignUp_SignUp", email_verified="false")
    assert presignup.lambda_handler(event, None) is event
