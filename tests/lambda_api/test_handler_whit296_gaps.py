"""WHIT-296 — adversarial gaps in the PATCH /transactions/{id} validation the
implementer's test_handler.py doesn't cover: a JSON `null` override, and combining
budget_excluded with category in one write. (true / false / string / int are
already covered by test_handler.py:264-290 — not duplicated.)
"""

import json

from _handler_patch_fakes import FakeRepo, _patch_event


def test_patch_budget_excluded_null_returns_400(handler):
    # [A-H1] JSON null is not a bool -> 400, never written (someone might expect null
    # to clear; the API's clear signal is `false`, and null must not slip through as
    # a stored None). isinstance(None, bool) is False, so the guard rejects it.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(_patch_event(body='{"budget_excluded": null}'), repo)
    assert resp["statusCode"] == 400
    assert repo.update_calls == []


def test_patch_budget_excluded_alongside_category_applies_both(handler):
    # [A-H2] A single PATCH carrying category AND budget_excluded writes both in one
    # call and echoes both — adding the override branch to the validator must not drop
    # a co-present field. Fail-on-revert: remove the budget_excluded validator block
    # and the echo/write loses it.
    repo = FakeRepo(keys={"pk": "p", "sk": "s"})
    resp = handler.patch_transaction(
        _patch_event(body='{"category": "groceries", "budget_excluded": true}'), repo)
    assert resp["statusCode"] == 200
    body = json.loads(resp["body"])
    assert body["category"] == "groceries"
    assert body["budget_excluded"] is True
    assert repo.update_calls == [("p", "s", {"category": "groceries", "budget_excluded": True})]
