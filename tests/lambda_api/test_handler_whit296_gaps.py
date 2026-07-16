"""WHIT-296 — adversarial gaps in the PATCH /transactions/{id} validation the
implementer's test_handler.py doesn't cover: a JSON `null` override, and combining
budget_excluded with category in one write. (true / false / string / int are
already covered by test_handler.py:264-290 — not duplicated.)
"""

import json

_UNSET = object()


class FakeRepo:
    """Records (pk, sk, {only provided fields}) — mirrors test_handler.FakeRepo."""

    def __init__(self, keys=None, update_result=True):
        self._keys = keys
        self._update_result = update_result
        self.update_calls = []

    def get_transaction_keys_by_id(self, transaction_id):
        return self._keys

    def update_transaction_fields(self, pk, sk, *, category=_UNSET, notes=_UNSET,
                                  tags=_UNSET, budget_excluded=_UNSET):
        provided = {f: v for f, v in (("category", category), ("notes", notes),
                                      ("tags", tags), ("budget_excluded", budget_excluded))
                    if v is not _UNSET}
        self.update_calls.append((pk, sk, provided))
        return self._update_result


def _patch_event(body, transaction_id="txn-1"):
    return {
        "rawPath": f"/transactions/{transaction_id}",
        "requestContext": {"http": {"method": "PATCH"}},
        "pathParameters": {"id": transaction_id},
        "body": body,
        "isBase64Encoded": False,
    }


def test_patch_budget_excluded_null_returns_400(handler):
    # [A-H1] JSON null is not a bool -> 400, never written (someone might expect null
    # to clear; the API's clear signal is `false`, and null must not slip through as
    # a stored None). isinstance(None, bool) is False, so the guard rejects it.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event('{"budget_excluded": null}'), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_patch_budget_excluded_alongside_category_applies_both(handler):
    # [A-H2] A single PATCH carrying category AND budget_excluded writes both in one
    # call and echoes both — adding the override branch to the validator must not drop
    # a co-present field. Fail-on-revert: remove the budget_excluded validator block
    # and the echo/write loses it.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(
        _patch_event('{"category": "groceries", "budget_excluded": true}'), repo)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["category"] == "groceries"
    assert body["budget_excluded"] is True
    assert repo.update_calls == [("p", "s", {"category": "groceries", "budget_excluded": True})]
