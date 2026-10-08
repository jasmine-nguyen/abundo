"""WHIT-829 QA: with the one-time fix-up gone, list and PATCH read every stored colorSlot shape
the same way — valid ones as plain ints, junk as None — and never write. Route-level bodies
carry the slot as a JSON integer, not the 2.0 a Decimal encodes to."""

import json
from decimal import Decimal

import pytest

from _api_event import api_event
from _category_fakes import _CFG, _SLOT, _cat, _repo_with_fake_table, budget_repo

# stored slot -> what GET and PATCH must both answer
_SHAPES = {
    "zero": (Decimal(0), 0),
    "top": (Decimal(19), 19),
    "exp": (Decimal("1E+1"), 10),
    "over": (Decimal(20), None),
    "neg": (Decimal(-1), None),
    "frac": (Decimal("3.5"), None),
    "nan": (Decimal("NaN"), None),
    "bool": (True, None),
    "text": ("7", None),
    "null": (None, None),
    "absent": (..., None),
}


def _store_every_shape(repo):
    items = {}
    for cat_id, (stored, _) in _SHAPES.items():
        extra = {} if stored is ... else {_SLOT: stored}
        items[cat_id] = _cat(cat_id, **extra)
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1)}


def test_list_and_patch_read_every_stored_slot_shape_alike_without_writing(handler):
    # [A1] the per-row read in list_categories and the PATCH echo are separate code paths now.
    _, repo = _repo_with_fake_table(handler)
    _store_every_shape(repo)

    listed = {row["id"]: row[_SLOT] for row in repo.list_categories()}
    assert repo._table.update_calls == [], "listing categories must never write"

    for cat_id, (stored, expected) in _SHAPES.items():
        assert listed[cat_id] == expected and type(listed[cat_id]) is type(expected), cat_id
        echoed = repo.update_category(cat_id, "Renamed", "Living", "tag")[_SLOT]
        assert echoed == expected and type(echoed) is type(expected), cat_id
        row = repo._table.store[_CFG]["items"][cat_id]
        if stored is ...:
            assert _SLOT not in row, "PATCH must not invent a slot"
        else:
            assert row[_SLOT] == stored or row[_SLOT] is stored, "PATCH must not rewrite the slot"


@pytest.mark.parametrize("method,path,params,raw", [
    ("GET", "/categories", None, None),
    ("PATCH", "/categories/coffee", {"id": "coffee"},
     '{"name": "Coffee", "bucket": "Lifestyle", "icon": "coffee"}'),
])
def test_routes_send_the_stored_slot_as_a_json_integer(handler, monkeypatch, method, path,
                                                       params, raw):
    # [A2] the old PATCH integer-echo route test was deleted with the migration setup.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: {**cat, _SLOT: Decimal(cat[_SLOT])}
             for cid, cat in repository.SEED_CATEGORIES.items()}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1)}
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: budget_repo())

    response = handler.lambda_handler(api_event(method, path, path_params=params, raw=raw), None)

    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    rows = body if isinstance(body, list) else [body]
    for row in rows:
        assert type(row[_SLOT]) is int, row
        assert row[_SLOT] == repository.SEED_CATEGORIES[row["id"]][_SLOT]
