"""Tests for the lambda_api handler, focused on the new PATCH /transactions/{id}.

The handler is provided by the `handler` fixture (see conftest.py), which imports
lambda_api/handler.py in isolation. patch_transaction_category takes the repo as a
parameter, so most tests call it directly with a FakeRepo — no patching, no AWS.
A single dispatch test drives it through lambda_handler to prove the wiring.
"""

import base64
import json


class FakeRepo:
    """Stand-in for TransactionRepository that records the write it's asked to do."""

    def __init__(self, keys=None, update_result=True):
        self._keys = keys
        self._update_result = update_result
        self.update_calls = []

    def get_transaction_keys_by_id(self, transaction_id):
        return self._keys

    def update_transaction_category(self, pk, sk, category):
        self.update_calls.append((pk, sk, category))
        return self._update_result


def _patch_event(transaction_id="txn-1", body='{"category": "groceries"}', is_b64=False):
    return {
        "rawPath": f"/transactions/{transaction_id}",
        "requestContext": {"http": {"method": "PATCH"}},
        "pathParameters": {"id": transaction_id},
        "body": body,
        "isBase64Encoded": is_b64,
    }


# --- happy path (repo injected directly, no patching) ------------------------


def test_patch_success_persists_category(handler):
    repo = FakeRepo(keys={"pk": "ACCOUNT#up-spending", "sk": "TXN#txn-1"})

    resp = handler.patch_transaction_category(_patch_event(), repo)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"transaction_id": "txn-1", "category": "groceries"}
    # persisted against the keys the resolver returned, with the given category.
    assert repo.update_calls == [("ACCOUNT#up-spending", "TXN#txn-1", "groceries")]


def test_patch_decodes_base64_body(handler):
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    encoded = base64.b64encode(b'{"category": "coffee"}').decode()

    resp = handler.patch_transaction_category(_patch_event(body=encoded, is_b64=True), repo)

    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", "coffee")]


# --- 404s --------------------------------------------------------------------


def test_patch_unknown_id_returns_404_without_writing(handler):
    repo = FakeRepo(keys=None)

    resp = handler.patch_transaction_category(_patch_event(), repo)

    assert resp["statusCode"] == 404
    assert repo.update_calls == []  # never attempt the write if the id doesn't resolve


def test_patch_row_vanished_returns_404(handler):
    # get_transaction_keys_by_id found keys, but the conditional write failed
    # (row deleted in between) -> update returns False -> 404, not 500.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"}, update_result=False)

    resp = handler.patch_transaction_category(_patch_event(), repo)

    assert resp["statusCode"] == 404


def test_patch_missing_path_id_returns_404(handler):
    event = _patch_event()
    event["pathParameters"] = {}  # no id

    resp = handler.patch_transaction_category(event, FakeRepo(keys={"pk": "p", "sk": "s"}))

    assert resp["statusCode"] == 404


# --- 400s --------------------------------------------------------------------


def test_patch_invalid_json_returns_400(handler):
    resp = handler.patch_transaction_category(_patch_event(body="not json"),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_base64_non_utf8_body_returns_400(handler):
    # Valid base64, but the decoded bytes aren't UTF-8 — must be a clean 400, not a 500.
    encoded = base64.b64encode(b"\xff\xfe\xff").decode()

    resp = handler.patch_transaction_category(_patch_event(body=encoded, is_b64=True),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_non_dict_body_returns_400(handler):
    resp = handler.patch_transaction_category(_patch_event(body="[1, 2, 3]"),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_missing_category_returns_400(handler):
    resp = handler.patch_transaction_category(_patch_event(body='{"note": "x"}'),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


def test_patch_blank_category_returns_400(handler):
    resp = handler.patch_transaction_category(_patch_event(body='{"category": "   "}'),
                                              FakeRepo(keys={"pk": "p", "sk": "s"}))
    assert resp["statusCode"] == 400


# --- dispatch / regression (through lambda_handler) --------------------------


def test_patch_dispatches_through_lambda_handler(handler, monkeypatch):
    # Proves lambda_handler routes PATCH /transactions/{id} and passes a repo in.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)

    resp = handler.lambda_handler(_patch_event(), None)

    assert resp["statusCode"] == 200
    assert repo.update_calls == [("p", "s", "groceries")]


def test_get_transactions_still_dispatches(handler, monkeypatch):
    monkeypatch.setattr(handler, "TransactionRepository", lambda: object())
    monkeypatch.setattr(handler, "get_recent_transactions", lambda repo: [{"id": 1}])

    event = {"rawPath": "/transactions", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == [{"id": 1}]


def test_unknown_route_returns_404(handler):
    event = {"rawPath": "/nope", "requestContext": {"http": {"method": "GET"}}}
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 404
