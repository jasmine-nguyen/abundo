"""Direct Up-bank webhook: instant home-loan repayment push (WHIT-313).

Up pings this lambda the moment a transaction lands. For a qualifying home-loan
repayment it sends ONE Expo push within seconds — replacing the slow BankSync-path
alert (which lagged up to an hour+). It is NOTIFY-ONLY: it writes no transaction to
DynamoDB. BankSync stays the source of truth for stored home-loan data; this path's
only job is the fast alert.

Ported from the house-arrest proof-of-concept: verify Up's HMAC-SHA256 signature,
acknowledge PING with 200, fetch the full transaction from Up (the webhook event is
thin — just an id), then decide and push.

The Up-specific constants live here (not in shared/constants.py) because only this
module uses them — same reasoning as push.py's Expo constants, and it keeps them
clear of the lambda_api/constants.py shadow trap.
"""

import base64
import hashlib
import hmac
import json
import logging
import urllib.request
from decimal import Decimal

from constants import MIN_REPAYMENT_NOTIFY
from push import send_push
from repayment_alerts import build_repayment_push
from repository_device import DeviceRepository
from repository_notify import NotifyRepository
from ssm import get_param

logger = logging.getLogger(__name__)
# The Text-format runtime leaves the root logger at WARNING, so opt INFO in (matches
# the BankSync handler / sync_trigger / balance_poller).
logger.setLevel(logging.INFO)

# Up signs each delivery with this header; we act only on TRANSACTION_CREATED.
SIGNATURE_HEADER = "X-Up-Authenticity-Signature"
TRANSACTION_CREATED = "TRANSACTION_CREATED"

# The Up-native account UUID of the home loan — what fetch_transaction returns. This
# is a THIRD id vocabulary, distinct from the internal "up-homeloan" and BankSync's
# raw account id. If Up is ever re-linked this UUID rotates and the match silently
# stops firing — confirm at cutover.
UP_HOMELOAN_ACCOUNT_ID = "fbef6cbc-09b3-4b6f-826c-6a178707a178"

UP_TRANSACTION_ENDPOINT = "https://api.up.com.au/api/v1/transactions/"
UP_PERSONAL_ACCESS_TOKEN_PATH = "/abundo/up-personal-access-token"
UP_WEBHOOK_SIGNING_SECRET_PATH = "/abundo/up-webhook-signing-secret"

OK_RESPONSE = {"statusCode": 200, "body": "ok"}
UNAUTHORISED_RESPONSE = {"statusCode": 401, "body": "unauthorised event"}
ERROR_RESPONSE = {"statusCode": 500, "body": "processing failed"}


_signing_secret = None


def get_signing_secret() -> str:
    global _signing_secret
    if _signing_secret is None:
        _signing_secret = get_param(UP_WEBHOOK_SIGNING_SECRET_PATH)
    return _signing_secret


_personal_access_token = None


def get_personal_access_token() -> str:
    global _personal_access_token
    if _personal_access_token is None:
        _personal_access_token = get_param(UP_PERSONAL_ACCESS_TOKEN_PATH)
    return _personal_access_token


def extract_raw_body(event: dict) -> bytes:
    """The exact bytes Up signed — base64-decoded when API Gateway flagged the body
    as binary, otherwise the UTF-8 body. The signature is over these raw bytes, so
    they must not be re-serialised before verifying."""
    body = event.get("body", "")
    if event.get("isBase64Encoded", False):
        return base64.b64decode(body, validate=True)
    return body.encode("utf-8")


def verify_signature(raw_body: bytes, signature_header: str) -> bool:
    secret = get_signing_secret().encode("utf-8")
    expected = hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature_header, expected)


def fetch_transaction(transaction_id: str) -> dict:
    """Fetch the full transaction from Up — the webhook event carries only its id."""
    request = urllib.request.Request(f"{UP_TRANSACTION_ENDPOINT}{transaction_id}")
    request.add_header("Authorization", f"Bearer {get_personal_access_token()}")
    with urllib.request.urlopen(request) as response:
        body = json.loads(response.read().decode("utf-8"))
    return body["data"]


def get_transaction_id(payload: dict) -> str:
    return payload["data"]["relationships"]["transaction"]["data"]["id"]


def is_qualifying_repayment(transaction: dict) -> bool:
    """True for a positive home-loan credit worth notifying: the Up home-loan account
    AND at least the $10 floor (compared in cents). Interest debits are negative, so
    they fall below the floor and are excluded. Any positive credit >= $10 on the loan
    fires — a redraw reversal or interest refund would too (accepted for scope)."""
    account_id = transaction["relationships"]["account"]["data"]["id"]
    value_in_base_units = int(transaction["attributes"]["amount"]["valueInBaseUnits"])
    return account_id == UP_HOMELOAN_ACCOUNT_ID and value_in_base_units >= MIN_REPAYMENT_NOTIFY * 100


def notify(transaction: dict) -> None:
    """Send one repayment push, deduped per Up transaction id.

    Mark-on-landing (WHIT-154): the id is marked fired ONLY after the push actually
    reached Expo (send_push ok > 0). If it didn't, raise — the handler returns 500 and
    Up's retry re-sends. An already-fired id or no registered device short-circuits."""
    transaction_id = transaction["id"]
    notify_repo = NotifyRepository()
    if transaction_id in notify_repo.fired_repayments():
        return

    tokens = DeviceRepository().list_tokens()
    if not tokens:
        return

    amount = Decimal(int(transaction["attributes"]["amount"]["valueInBaseUnits"])) / 100
    title, body = build_repayment_push(amount)
    if send_push(title, body, tokens)["ok"] > 0:
        notify_repo.mark_repayment_fired(transaction_id)
        return
    raise RuntimeError(f"push not accepted by Expo for repayment {transaction_id}")


def lambda_handler(event, context) -> dict:
    headers = {k.lower(): v for k, v in event.get("headers", {}).items()}
    signature_header = headers.get(SIGNATURE_HEADER.lower())
    if not signature_header:
        return UNAUTHORISED_RESPONSE

    raw_body = extract_raw_body(event)
    if not verify_signature(raw_body, signature_header):
        return UNAUTHORISED_RESPONSE

    # Everything past the signature check runs under one guard so ANY failure — a
    # malformed body, a fetch error, a send error — returns a logged 500 rather than an
    # uncaught crash (API Gateway 502 with no structured log). Up retries on 500; the
    # dedupe marker (set only after a push reaches Expo) makes the retry safe. Since
    # BankSync no longer backstops this alert, retrying is the reliability net.
    try:
        payload = json.loads(raw_body)
        event_type = payload["data"]["attributes"]["eventType"]
        if event_type != TRANSACTION_CREATED:
            # PING (sent by Up at registration) and any other event: acknowledge only.
            return OK_RESPONSE
        transaction = fetch_transaction(get_transaction_id(payload))
        if is_qualifying_repayment(transaction):
            notify(transaction)
    except Exception:
        logger.exception("up webhook: processing failed")
        return ERROR_RESPONSE

    return OK_RESPONSE
