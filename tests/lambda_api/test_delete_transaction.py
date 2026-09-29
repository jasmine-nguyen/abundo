"""DELETE /transactions/{id} — the user deletes one charge from the transaction screen (WHIT-654).

Driven through lambda_handler with the REAL TransactionRepository over a FakeTable, so the route,
the id lookup, the delete and the "deleted by you" marker (tombstone) all run as production wrote
them. The marker is what stops a BankSync re-send bringing the charge back.
"""

import json
import time

from _feed_fakes import WESTPAC, Repos, _row

_DUPLICATE_ID = "westpac-claude-sub-pending"
_SIBLING_ID = "westpac-claude-sub-posted"
_FEED_WINDOW_SECONDS = 7 * 24 * 3600


def _event(method, path, path_params=None):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if path_params is not None:
        event["pathParameters"] = path_params
    return event


def _delete(handler, transaction_id):
    return handler.lambda_handler(
        _event("DELETE", f"/transactions/{transaction_id}", {"id": transaction_id}), None)


def test_user_can_delete_a_charge_and_it_is_marked_so_a_resend_cannot_bring_it_back(
        handler, monkeypatch):
    rows = [
        _row(WESTPAC, "2026-09-27", _DUPLICATE_ID, description="ANTHROPIC* CLAUDE SUB",
             amount="-170.01", pending=True),
        _row(WESTPAC, "2026-09-28", _SIBLING_ID, description="ANTHROPIC* CLAUDE SUB",
             amount="-170.01", pending=False),
    ]
    store = Repos({WESTPAC: rows})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: store.transaction_repo)
    table = store.table

    resp = _delete(handler, _DUPLICATE_ID)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"transaction_id": _DUPLICATE_ID}

    # The charge is gone; the other charge is untouched.
    assert (f"ACCOUNT#{WESTPAC}", f"TXN#{_DUPLICATE_ID}") not in table.store
    assert (f"ACCOUNT#{WESTPAC}", f"TXN#{_SIBLING_ID}") in table.store

    # A marker row was written for it. It expires by itself, but only well after BankSync stops
    # re-sending (7 days), and it carries none of the index fields, so no read ever lists it.
    markers = [item for (pk, sk), item in table.store.items()
               if sk == f"TXN#{_DUPLICATE_ID}" and not pk.startswith("ACCOUNT#")]
    assert len(markers) == 1
    marker = markers[0]
    assert marker["expires_at"] > time.time() + _FEED_WINDOW_SECONDS
    assert not {"transaction_id", "account_id", "date"} & set(marker)
    assert store.transaction_repo.is_deleted(WESTPAC, _DUPLICATE_ID) is True
    assert store.transaction_repo.is_deleted(WESTPAC, _SIBLING_ID) is False

    # Deleting it again (or any unknown id) is a 404.
    assert _delete(handler, _DUPLICATE_ID)["statusCode"] == 404
    assert _delete(handler, "no-such-charge")["statusCode"] == 404

    # The PATCH item route still routes.
    patch = handler.lambda_handler(
        {**_event("PATCH", f"/transactions/{_SIBLING_ID}", {"id": _SIBLING_ID}),
         "body": json.dumps({"notes": "kept"})}, None)
    assert patch["statusCode"] == 200
