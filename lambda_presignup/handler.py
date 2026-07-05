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
PreSignUp_ExternalProvider); keying on the email alone handles all three, so no
per-source branching is needed. The email is populated for federated sign-ups via
the pool's `attribute_mapping { email = "email" }`.

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
    return event
