"""WHIT-449 — regression guards for the DELETED GET /transactions/range route.

The date-range query (get_transactions_by_range + its range-only _encode_cursor/
_decode_cursor + TRANSACTIONS_RANGE_PATH) was removed as verified-dead. The old
suite tested get_transactions_by_range as a FUNCTION, so nothing here duplicates
it — these are forward guards at the DISPATCH + constants boundaries. They go red
if the route, its symbols, or the constant are re-introduced, and prove the
neighbouring feed / recent routes the deletion sat between are undisturbed.

Reuses the suite's `handler` fixture (tests/lambda_api/conftest.py) and the shared
constants reader (_lambda_api_constants.constants_namespace, on pytest.ini's
pythonpath) — no new fakes.
"""
import json
import pathlib

import pytest

from _lambda_api_constants import constants_namespace

_ROOT = pathlib.Path(__file__).resolve().parents[2]


def _range_event(method="GET", params="omit"):
    ev = {"rawPath": "/transactions/range",
          "requestContext": {"http": {"method": method}}}
    if params != "omit":
        ev["queryStringParameters"] = params
    return ev


def test_range_get_with_old_client_params_now_returns_404(handler):
    # The exact request an old client sent (account_id + from/to + limit) must now
    # fall through to the 404 default — not be served (200), and not degrade to the
    # route's old 400 validation. Proves the whole branch + validation path is gone.
    resp = handler.lambda_handler(_range_event(params={
        "account_id": "up-spending", "from": "2026-06-01",
        "to": "2026-06-30", "limit": "50",
    }), None)
    assert resp["statusCode"] == 404
    assert json.loads(resp["body"]) == {"error": "Not found"}


def test_range_get_without_query_string_is_404(handler):
    # API Gateway omits queryStringParameters entirely when the query is absent;
    # the removed handler used to 400 here ("account_id required"). Now it is a 404.
    resp = handler.lambda_handler(_range_event(), None)
    assert resp["statusCode"] == 404


def test_range_get_is_not_misrouted_to_a_neighbour_handler(handler, monkeypatch):
    # The deleted branch sat BETWEEN GET /transactions (recent) and GET
    # /transactions/feed, and "/transactions/range" is a prefix-y sibling of both.
    # Guard that a range GET reaches NEITHER neighbour (it must 404, not silently
    # borrow the feed's or the recent list's response).
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "get_transactions_feed",
                        lambda *a, **k: pytest.fail("range GET reached the feed handler"))
    monkeypatch.setattr(handler, "get_recent_transactions",
                        lambda *a, **k: pytest.fail("range GET reached the recent handler"))

    resp = handler.lambda_handler(_range_event(params={"account_id": "up-spending", "from": "2026-06-01"}), None)
    assert resp["statusCode"] == 404


def test_range_handler_symbols_are_gone(handler):
    # Strong deletion guard: re-adding any of these (even without re-wiring the
    # route) turns this red. get_transactions_by_date_range (the REPO method, KEPT
    # because the feed + mortgage window still call it) is deliberately NOT listed.
    for name in ("get_transactions_by_range", "_encode_cursor",
                 "_decode_cursor", "TRANSACTIONS_RANGE_PATH"):
        assert not hasattr(handler, name), f"{name} should have been removed from handler"


def test_transactions_range_path_removed_from_both_constants_modules():
    api = constants_namespace(_ROOT / "lambda_api" / "constants.py")
    shared = constants_namespace(_ROOT / "shared" / "constants.py")

    # The dead constant is gone from BOTH copies (the shadow pair)...
    assert "TRANSACTIONS_RANGE_PATH" not in api, "lambda_api/constants.py still defines TRANSACTIONS_RANGE_PATH"
    assert "TRANSACTIONS_RANGE_PATH" not in shared, "shared/constants.py still defines TRANSACTIONS_RANGE_PATH"

    # ...both files still exec cleanly (removal didn't break import), and the LIVE
    # feed + recent paths survive, still equal across the pair (WHIT-136 invariant).
    assert api["TRANSACTIONS_FEED_PATH"] == shared["TRANSACTIONS_FEED_PATH"] == "/transactions/feed"
    assert api["TRANSACTION_PATH"] == shared["TRANSACTION_PATH"] == "/transactions"
