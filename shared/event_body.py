"""The one decode of a Lambda event's body to bytes (WHIT-832), shared by the bank webhook,
the Up webhook and the API's JSON parse."""

import base64


def raw_body(event: dict) -> bytes:
    """The request body as bytes: base64-decoded when API Gateway flagged it, else UTF-8
    encoded. A missing body is b"". Malformed base64 raises ValueError."""
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        return base64.b64decode(body, validate=True)
    return body.encode("utf-8")
