"""Expo Push sender — the shared push-channel foundation.

``send_push`` posts a batch of messages to Expo's push service and prunes any
token Expo reports as ``DeviceNotRegistered``. It is BEST-EFFORT: it never raises,
so a push failure can't break whatever wrote the data that triggered it (mirrors
the balance poller's swallow-everything shape).

The Expo project has Enhanced Security enabled, so every send carries
``Authorization: Bearer <access token>``, read from SSM (cached per container).

The Expo constants below are defined locally (not in the shared ``constants``
module) because they're used only here — which also keeps this module free of the
``constants`` shadow trap the BankSync values in ``lambda_api/constants.py``
document, so it stays importable from any lambda.
"""

import json
import logging
import urllib.error
import urllib.request

from ssm import get_param

# Expo Push send endpoint. send_push POSTs a batch of messages here.
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
# Expo Push receipts endpoint. get_receipts POSTs {ids:[...]} here to learn each
# accepted push's true delivery outcome (WHIT-139 sweep).
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
# HTTP timeout, in seconds, for a single Expo Push request.
EXPO_PUSH_TIMEOUT_SECONDS = 15
# Expo accepts at most 100 messages per push request.
EXPO_PUSH_BATCH_MAX = 100
# Expo accepts at most 1000 receipt ids per getReceipts request.
EXPO_RECEIPTS_MAX = 1000
# SSM SecureString path holding the Expo access token (a PAT). Required because
# the Expo project has "Enhanced Security for Push Notifications" enabled, so every
# send must carry Authorization: Bearer <token>. Seeded as a placeholder by
# terraform/ssm.tf; the real value is set out-of-band (console/CLI).
EXPO_ACCESS_TOKEN_PATH = "/whittle/expo-access-token"

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


def _post_expo(url, body_obj, token) -> dict:
    """POST ``body_obj`` as JSON to an Expo endpoint and return the parsed response dict.

    The shared plumbing behind send and getReceipts: encode → JSON headers (+ a Bearer
    auth header when a token is set) → POST with ``EXPO_PUSH_TIMEOUT_SECONDS`` → decode
    (``{}`` on an empty body). Each caller owns how it reads the parsed payload.
    """
    data = json.dumps(body_obj).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=EXPO_PUSH_TIMEOUT_SECONDS) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else {}


def _send_batch(messages: list, token) -> list:
    """POST one batch to Expo and return its list of ticket dicts (in send order)."""
    payload = _post_expo(EXPO_PUSH_URL, messages, token)
    return payload.get("data") or []


def _get_receipts_batch(ids: list, token) -> dict:
    """POST one batch of ids to Expo's getReceipts and return its ``{id -> receipt}`` map.

    Unlike send (whose ``data`` is a LIST of tickets in send order), getReceipts'
    ``data`` is a DICT keyed by receipt id — and only ids Expo has RESOLVED appear, so an
    in-flight id is simply absent. A top-level ``errors`` array signals a request-level
    rejection (rate-limit, malformed) with ``data`` absent; we surface it so it isn't
    silently indistinguishable from an empty result.
    """
    payload = _post_expo(EXPO_RECEIPTS_URL, {"ids": ids}, token)
    errors = payload.get("errors")
    if errors:
        logger.warning("Expo getReceipts returned request-level errors: %s", errors)
    return payload.get("data") or {}


def get_receipts(ids, *, access_token=None) -> dict:
    """Poll Expo for the delivery outcome of each receipt id. Best-effort: never raises.

    Returns a merged ``{receipt_id -> receipt}`` dict across ``EXPO_RECEIPTS_MAX``-id
    chunks. An id Expo hasn't resolved yet is simply absent from the result (the sweep
    leaves that row for a later poll). A per-chunk transport/decode error is logged and
    skipped, so one bad chunk can't lose the ids in the others. ``access_token`` overrides
    the SSM read (pass "" to poll unauthenticated); it mirrors ``send_push``'s auth.
    """
    ids = [i for i in (ids or []) if i]
    if not ids:
        return {}

    token = access_token if access_token is not None else _safe_access_token()

    receipts: dict = {}
    for chunk in _chunk(ids, EXPO_RECEIPTS_MAX):
        try:
            receipts.update(_get_receipts_batch(chunk, token))
        except Exception:  # transport / decode / anything — best-effort, keep going
            logger.exception("Expo getReceipts batch failed for %d id(s)", len(chunk))
            continue
    return receipts


def send_push(title: str, body: str, tokens, *, access_token=None, device_repo=None,
              receipt_repo=None) -> dict:
    """Send {title, body} to every token via Expo Push. Best-effort: never raises.

    Batches into EXPO_PUSH_BATCH_MAX per request, prunes tokens Expo flags as
    ``DeviceNotRegistered`` (via ``device_repo``, or the real DeviceRepository when
    omitted), and returns a summary ``{sent, ok, pruned}``. ``access_token``
    overrides the SSM read (pass "" to send unauthenticated); ``device_repo`` /
    ``receipt_repo`` are injectable for tests. Tokens are de-duplicated, empties dropped.

    Each ACCEPTED push returns a receipt id, which is stashed with its token via
    ``receipt_repo`` (or the real PushReceiptRepository when omitted) so a later sweep
    can poll Expo's receipts for the true delivery outcome (WHIT-139) — see ``ok`` below.
    Stashing is best-effort: a store failure never breaks the send.

    ``ok`` is the count of tokens Expo ACCEPTED (ticket status "ok") — it stays 0
    for a batch that hit a transport/decode error (swallowed above). So
    ``ok > 0`` is the "at least one send actually reached Expo" signal a caller
    gates its debounce marker on (WHIT-154): mark-fired only when ``ok > 0``, so a
    genuine outage (``ok == 0``, nothing pruned) leaves the alert unmarked for a
    later re-ingest to retry, while a fully-pruned batch (``ok == 0`` but the only
    tokens were ``DeviceNotRegistered``) also stays unmarked yet can't loop — the
    next ingest reads no tokens and short-circuits. ``ok`` counts Expo acceptance,
    not on-device delivery (that's the separate receipts phase).
    """
    tokens = list(dict.fromkeys(t for t in (tokens or []) if t))
    if not tokens:
        return {"sent": 0, "ok": 0, "pruned": []}

    token = access_token if access_token is not None else _safe_access_token()

    ok = 0
    pruned: list = []
    receipts: list = []  # (receipt_id, token) for each accepted push (WHIT-139)
    for batch in _chunk(tokens, EXPO_PUSH_BATCH_MAX):
        messages = [{"to": t, "title": title, "body": body} for t in batch]
        try:
            tickets = _send_batch(messages, token)
        except Exception:  # transport / decode / anything — best-effort, keep going
            logger.exception("Expo push batch failed for %d token(s)", len(batch))
            continue
        # Expo returns tickets in the same order as the messages, so zip maps
        # each ticket back to its token. (Scoped per batch so a dropped batch above
        # can't shift the token↔ticket alignment.)
        for tok, ticket in zip(batch, tickets):
            if not isinstance(ticket, dict):
                continue
            if ticket.get("status") == "ok":
                ok += 1
                receipt_id = ticket.get("id")
                if receipt_id:
                    receipts.append((receipt_id, tok))
            elif (ticket.get("details") or {}).get("error") == "DeviceNotRegistered":
                pruned.append(tok)

    for tok in pruned:
        _safe_prune(tok, device_repo)
    if receipts:
        _safe_store_receipts(receipts, receipt_repo)

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


def _safe_store_receipts(receipts, receipt_repo) -> None:
    """Stash (receipt_id, token) pairs so a later receipts sweep (WHIT-139) can poll
    Expo for each push's delivery outcome. Best-effort — a store failure (or an
    unreadable store) must never break the send; the ids self-expire via TTL anyway."""
    try:
        repo = receipt_repo or _default_receipt_repo()
    except Exception:
        logger.exception("could not open the push-receipt store")
        return
    for receipt_id, token in receipts:
        try:
            repo.put(receipt_id, token)
        except Exception:
            logger.exception("could not stash push receipt id")


def _default_receipt_repo():
    # Lazy import, like _default_repo: keeps send_push free of a hard store dependency
    # when a caller injects its own receipt_repo (and tests never touch DynamoDB).
    from repository_push_receipt import PushReceiptRepository
    return PushReceiptRepository()
