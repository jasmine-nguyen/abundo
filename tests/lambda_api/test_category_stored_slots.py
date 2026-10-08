"""WHIT-829: with the one-time fix-up gone, a create on a store still carrying the old schema
marker, with custom categories piled on one colour and a corrupt slot, takes a free slot and
leaves every stored slot as it was. List and PATCH reads are covered in the _qa file."""

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


def test_create_on_a_piled_store_takes_a_free_slot_and_repaints_nothing(handler):
    repository, repo = _repo_with_fake_table(handler)
    items = _piled_store_with_stale_marker(repo, repository)
    stored = {cid: cat[_SLOT] for cid, cat in items.items()}

    created = repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")
    # Every free slot left is one no built-in owns; 2 is the lowest of them.
    assert created[_SLOT] == 2
    assert len(repo._table.update_calls) == 1, "create writes once"
    assert {cid: cat[_SLOT] for cid, cat in repo._table.store[_CFG]["items"].items()
            if cid in stored} == stored, "no stored slot was repainted"
