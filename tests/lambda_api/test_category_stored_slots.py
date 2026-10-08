"""WHIT-829: a category's colorSlot is read straight from the store — no one-time fix-up runs
on list, create or update any more. A store still carrying the old schema marker, with custom
categories piled on one colour and a corrupt slot, is served exactly as stored."""

from decimal import Decimal

from _category_fakes import _CFG, _SLOT, _cat, _repo_with_fake_table


def _piled_store_with_stale_marker(repo, repository):
    """Built-ins on their seeded slots, 30 custom rows piled on slot 0, one corrupt slot, and
    a leftover old-schema marker the code must now ignore."""
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(30):
        cat_id = f"cat{index:04d}"
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(0))
    items["broken"] = _cat("broken", colorSlot="7")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}
    return items


def test_categories_serve_their_stored_colour_slot_without_any_fix_up_writes(handler):
    repository, repo = _repo_with_fake_table(handler)
    items = _piled_store_with_stale_marker(repo, repository)
    stored = {cid: cat[_SLOT] for cid, cat in items.items()}

    listed = {row["id"]: row[_SLOT] for row in repo.list_categories()}

    assert repo._table.update_calls == [], "listing categories must never write"
    assert listed.pop("broken") is None, "a corrupt stored slot reads as missing"
    assert listed == {cid: int(slot) for cid, slot in stored.items() if cid != "broken"}
    assert all(type(slot) is int for slot in listed.values())

    edited = repo.update_category("cat0005", "Renamed", "Living", "tag")
    assert edited[_SLOT] == 0, "PATCH echoes the stored slot"
    assert type(edited[_SLOT]) is int

    writes_before_create = len(repo._table.update_calls)
    created = repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")
    # Every free slot left is one no built-in owns; 2 is the lowest of them.
    assert created[_SLOT] == 2
    assert len(repo._table.update_calls) == writes_before_create + 1, "create writes once"
    assert {cid: cat[_SLOT] for cid, cat in repo._table.store[_CFG]["items"].items()
            if cid in stored} == stored, "no stored slot was repainted"
