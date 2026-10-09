"""WHIT-832 — shared/event_body.raw_body: the one decode of a Lambda event's body to bytes,
used by the bank webhook, the Up webhook and the API's JSON parse."""

import base64

import pytest


@pytest.mark.parametrize("event, expected", [
    ({"body": '{"a": 1}', "isBase64Encoded": False}, b'{"a": 1}'),
    ({"body": '{"a": 1}'}, b'{"a": 1}'),
    ({"body": base64.b64encode(b'{"a": 1}').decode("utf-8"), "isBase64Encoded": True},
     b'{"a": 1}'),
    ({"body": "café"}, "café".encode("utf-8")),
    ({"body": None}, b""),
    ({}, b""),
])
def test_raw_body_returns_the_decoded_bytes(shared, event, expected):
    import event_body
    assert event_body.raw_body(event) == expected


def test_raw_body_rejects_malformed_base64(shared):
    # validate=True: junk under the base64 flag raises (→ 401/400 upstream) instead of
    # silently decoding to garbage bytes.
    import event_body
    with pytest.raises(ValueError):
        event_body.raw_body({"body": "not base64!!", "isBase64Encoded": True})
