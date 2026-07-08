"""Cognito Pre-Sign-Up trigger — single-user allowlist gate (WHIT-162).

Cognito auto-provisions a user for ANY Google/Apple account that completes the
Hosted UI flow — `admin_create_user_config.allow_admin_create_user_only` blocks
username/password self-signup but NOT federation. This trigger runs at account
creation and REJECTS any email that isn't on the allowlist, so the pool stays
single-user once the JWT authorizer (WHIT-97) guards the API routes.

Contract (Cognito Pre-Sign-Up):
- Allow  = return the event unchanged.
- Reject = raise an exception; Cognito denies the sign-up and surfaces the message.

Fires for every trigger source (PreSignUp_SignUp, PreSignUp_AdminCreateUser,
PreSignUp_ExternalProvider). The email allowlist gates all three; federated
(PreSignUp_ExternalProvider) sign-ups ALSO require a verified email (WHIT-173) —
defense in depth against a future IdP that lets a user self-assert an unverified
address. The email + email_verified are populated for federated sign-ups via the
pool's `attribute_mapping` (see terraform/cognito.tf).

Dependency-free: no shared layer, no SSM, no boto3 — just the ALLOWED_EMAILS env
var (comma-separated). Fail-closed: a missing/empty email or an empty allowlist
rejects.
"""

import logging
import os

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def _allowed_emails() -> set:
    """The lowercased set of permitted emails from the ALLOWED_EMAILS env var."""
    raw = os.environ.get("ALLOWED_EMAILS", "")
    return {entry.strip().lower() for entry in raw.split(",") if entry.strip()}


def lambda_handler(event, context):
    """Allow the sign-up only if its email is on the allowlist; else reject.

    Fail-closed: a missing/empty email, or an empty allowlist, rejects.
    """
    attributes = (event.get("request") or {}).get("userAttributes") or {}
    email = (attributes.get("email") or "").strip().lower()
    if not email or email not in _allowed_emails():
        logger.info("Rejected sign-up for email %r (not on allowlist)", email)
        raise Exception("This app is private. Your account is not permitted to sign in.")
    # Federated sign-ups (Google/Apple, WHIT-173): the allowlist alone trusts the
    # IdP-asserted email. ALSO require the IdP to have verified it, so a future IdP
    # that permits an unverified/self-asserted address can't slip an allowlisted
    # address past the gate. Cognito passes email_verified as the string "true" for
    # some IdPs and a bool True for others — accept either. Only ExternalProvider
    # is gated; admin-create and native SRP sign-up are trusted paths, unchanged.
    if event.get("triggerSource") == "PreSignUp_ExternalProvider":
        if str(attributes.get("email_verified")).strip().lower() != "true":
            logger.info("Rejected federated sign-up for email %r (email not verified)", email)
            raise Exception("This app is private. Your account is not permitted to sign in.")
    return event
