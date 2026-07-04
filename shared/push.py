"""Expo Push sender — the shared push-channel foundation.

``send_push`` posts a batch of messages to Expo's push service and prunes any
token Expo reports as ``DeviceNotRegistered``. It is BEST-EFFORT: it never raises,
so a push failure can't break whatever wrote the data that triggered it (mirrors
the balance poller's swallow-everything shape).

IMPORTANT — do NOT import this module from ``lambda_api``. It reads EXPO_PUSH_URL
etc. from ``constants``, which under lambda_api resolves to ``lambda_api/
constants.py`` (the /var/task shadow), NOT ``shared/constants.py`` — so the import
would fail at load and 500 every API route. The sender runs from the webhook /
notification lambdas, which see the shared layer's constants. (Same shadow rule
the BankSync values in ``lambda_api/constants.py`` document.)

The Expo project has Enhanced Security enabled, so every send carries
``Authorization: Bearer <access token>``, read from SSM (cached per container).
"""

import json
import logging
import urllib.error
import urllib.request

from constants import (
    EXPO_ACCESS_TOKEN_PATH,
    EXPO_PUSH_BATCH_MAX,
    EXPO_PUSH_TIMEOUT_SECONDS,
    EXPO_PUSH_URL,
)
from ssm import get_param

logger = logging.getLogger(__name__)

_access_token = None


def get_access_token() -> str:
    """Fetch + cache the Expo access token (PAT) from SSM for the container's life."""
    global _access_token
    if _access_token is None:
        _access_token = get_param(EXPO_ACCESS_TOKEN_PATH)
    return _access_token


def _chunk(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _send_batch(messages: list, token) -> list:
    """POST one batch to Expo and return its list of ticket dicts (in send order)."""
    data = json.dumps(messages).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(EXPO_PUSH_URL, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=EXPO_PUSH_TIMEOUT_SECONDS) as resp:
        raw = resp.read()
    payload = json.loads(raw) if raw else {}
    return payload.get("data") or []


def send_push(title: str, body: str, tokens, *, access_token=None, device_repo=None) -> dict:
    """Send {title, body} to every token via Expo Push. Best-effort: never raises.

    Batches into EXPO_PUSH_BATCH_MAX per request, prunes tokens Expo flags as
    ``DeviceNotRegistered`` (via ``device_repo``, or the real DeviceRepository when
    omitted), and returns a summary ``{sent, ok, pruned}``. ``access_token``
    overrides the SSM read (pass "" to send unauthenticated); ``device_repo`` is
    injectable for tests. Tokens are de-duplicated, empties dropped.
    """
    tokens = list(dict.fromkeys(t for t in (tokens or []) if t))
    if not tokens:
        return {"sent": 0, "ok": 0, "pruned": []}

    token = access_token if access_token is not None else _safe_access_token()

    ok = 0
    pruned: list = []
    for batch in _chunk(tokens, EXPO_PUSH_BATCH_MAX):
        messages = [{"to": t, "title": title, "body": body} for t in batch]
        try:
            tickets = _send_batch(messages, token)
        except Exception:  # transport / decode / anything — best-effort, keep going
            logger.exception("Expo push batch failed for %d token(s)", len(batch))
            continue
        # Expo returns tickets in the same order as the messages, so zip maps
        # each ticket back to its token.
        for tok, ticket in zip(batch, tickets):
            if not isinstance(ticket, dict):
                continue
            if ticket.get("status") == "ok":
                ok += 1
            elif (ticket.get("details") or {}).get("error") == "DeviceNotRegistered":
                pruned.append(tok)

    for tok in pruned:
        _safe_prune(tok, device_repo)

    return {"sent": len(tokens), "ok": ok, "pruned": pruned}


def _safe_access_token():
    """get_access_token, but never raises — a missing/unreadable secret must not
    break the send (Expo will 4xx, which the swallow below handles)."""
    try:
        return get_access_token()
    except Exception:
        logger.exception("could not read the Expo access token from SSM")
        return None


def _safe_prune(token: str, device_repo) -> None:
    try:
        (device_repo or _default_repo()).remove(token)
    except Exception:
        logger.exception("could not prune dead push token")


def _default_repo():
    # Imported lazily so send_push has no hard import dependency on the store when
    # a caller injects its own device_repo (and tests never touch DynamoDB).
    from repository_device import DeviceRepository
    return DeviceRepository()
