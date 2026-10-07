"""QA edges for DELETE /transactions/{id} (WHIT-654).

The REAL handler + REAL TransactionRepository over a FakeTable: missing id, unknown id, a row that
vanishes between the id lookup and the delete, marker-before-delete ordering, and DB failures.
"""

import json

import pytest

from _dynamo_fakes import _client_error
from _feed_fakes import WESTPAC, Repos, _row
from _terraform import app_route_keys

_DUP = "dup-pending"
_ROW_KEY = (f"ACCOUNT#{WESTPAC}", f"TXN#{_DUP}")
_MARKER_KEY = (f"DELETED#ACCOUNT#{WESTPAC}", f"TXN#{_DUP}")


def _event(transaction_id, path_params="default"):
    event = {"rawPath": f"/transactions/{transaction_id}", "requestContext": {"http": {"method": "DELETE"}}}
    if path_params == "default":
        event["pathParameters"] = {"id": transaction_id}
    elif path_params is not None:
        event["pathParameters"] = path_params
    return event


@pytest.fixture
def store(handler, monkeypatch):
    repos = Repos({WESTPAC: [_row(WESTPAC, "2026-09-27", _DUP, description="ANTHROPIC* CLAUDE SUB",
                                  amount="-170.01", pending=True)]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repos.transaction_repo)
    return repos


def _markers(table):
    return [key for key in table.store if key[0].startswith("DELETED#")]


# [A1]
def test_missing_path_id_is_404_and_touches_nothing(handler, store):
    for params in (None, {}, {"id": ""}):
        resp = handler.lambda_handler(_event("", params), None)
        assert resp["statusCode"] == 404
    assert _ROW_KEY in store.table.store
    assert _markers(store.table) == []


# [A2]
def test_unknown_id_is_404_and_writes_no_marker(handler, store):
    resp = handler.lambda_handler(_event("no-such-charge"), None)
    assert resp["statusCode"] == 404
    assert _markers(store.table) == []
    assert store.table.put_calls == []


# [A3]
def test_row_vanishing_between_lookup_and_delete_is_404(handler, store):
    # Another delete (a double tap on two devices) removes the row after the index lookup.
    store.table.before_next_write(lambda key, table: table.store.pop(_ROW_KEY, None))
    resp = handler.lambda_handler(_event(_DUP), None)
    assert resp["statusCode"] == 404
    assert json.loads(resp["body"]) == {"error": "transaction not found"}


# [A4]
def test_marker_is_written_before_the_row_is_deleted(handler, store):
    seen_marker_at_delete = []
    store.table.before_write(lambda key, table: seen_marker_at_delete.append(_MARKER_KEY in table.store))
    resp = handler.lambda_handler(_event(_DUP), None)
    assert resp["statusCode"] == 200
    assert seen_marker_at_delete == [True]
    assert _ROW_KEY not in store.table.store


# [A5]
def test_delete_failure_raises_and_leaves_the_row_and_a_harmless_marker(handler, store):
    store.table.fail("delete_item")
    with pytest.raises(Exception) as err:
        handler.lambda_handler(_event(_DUP), None)
    assert type(err.value).__name__ == "DatabaseError"
    assert _ROW_KEY in store.table.store
    assert _MARKER_KEY in store.table.store


# [A6]
def test_marker_write_failure_does_not_delete_the_row(handler, store):
    store.table.fail("put_item", _client_error("AccessDeniedException", "denied"))
    with pytest.raises(Exception) as err:
        handler.lambda_handler(_event(_DUP), None)
    assert type(err.value).__name__ == "DatabaseError"
    assert _ROW_KEY in store.table.store


# [A7]
def test_marker_is_per_account(handler, store):
    assert handler.lambda_handler(_event(_DUP), None)["statusCode"] == 200
    repo = store.transaction_repo
    assert repo.is_deleted(WESTPAC, _DUP) is True
    assert repo.is_deleted("some-other-account", _DUP) is False


# [A8]
def test_marker_ttl_outlives_the_resend_and_age_out_windows(handler):
    import constants
    assert constants.DELETED_TRANSACTION_TTL_SECONDS > constants.FEED_WINDOW_DAYS * 24 * 3600
    assert constants.DELETED_TRANSACTION_TTL_SECONDS > constants.PENDING_AGE_OUT_DAYS * 24 * 3600


# [A9]
def test_other_methods_on_the_item_path_do_not_delete(handler, store):
    event = _event(_DUP)
    event["requestContext"]["http"]["method"] = "POST"
    resp = handler.lambda_handler(event, None)
    assert resp["statusCode"] == 404
    assert _ROW_KEY in store.table.store
    assert _markers(store.table) == []


# [A10]
def test_delete_route_is_registered_in_api_gateway():
    assert "DELETE /transactions/{id}" in app_route_keys()
