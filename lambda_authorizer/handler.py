"""API Gateway (HTTP API) REQUEST authorizer — a shared-secret gate.

Runs BEFORE the request reaches lambda_api. It checks a bearer token against a
shared secret stored in SSM and returns simple allow/deny. Attached to the
/enrichments routes (terraform/apigateway.tf), which — unlike the other open
lambda_api routes — mutate BankSync (our source of truth), so they must not be
publicly reachable without the token (WHIT-52).

This is deliberately the simplest thing that works for a single-user app: one
static random token, string-compared. It is the swap-point for real auth later —
replace the compare with Cognito JWT verification (or API GW's built-in JWT
authorizer) and the routes behind it don't change.

`constants` and `ssm` are provided by the shared lambda layer.
"""

import hmac
import logging

from constants import API_AUTH_TOKEN_PATH
from ssm import get_param

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_BEARER_PREFIX = "Bearer "

_token = None


def get_token() -> str:
    """Fetch and cache the API auth token from SSM for the life of the container."""
    global _token
    if _token is None:
        _token = get_param(API_AUTH_TOKEN_PATH)
    return _token


def _presented_token(event: dict) -> str:
    """Pull the bearer token out of the Authorization header, or "" if absent.

    HTTP API lowercases header names, but accept either case to be safe.
    """
    headers = event.get("headers") or {}
    auth = headers.get("authorization") or headers.get("Authorization") or ""
    if auth.startswith(_BEARER_PREFIX):
        return auth[len(_BEARER_PREFIX):].strip()
    return ""


def lambda_handler(event, context):
    """Return {"isAuthorized": bool} (simple-response format).

    Uses a constant-time compare so a wrong token can't be recovered by timing.
    An empty/missing token is always a deny.
    """
    presented = _presented_token(event)
    if not presented:
        return {"isAuthorized": False}
    expected = get_token()
    return {"isAuthorized": hmac.compare_digest(presented, expected)}
