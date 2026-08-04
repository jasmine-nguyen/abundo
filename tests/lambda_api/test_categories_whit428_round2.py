"""WHIT-428 ROUND-2 GAP tests — the PATCH colour echo, plan_new_category_slot as a newly
PUBLIC function, and the allowance at row_count 0.

Round 1 covered the repaint's write policy, chunking and hostile data
(test_categories_whit428_gaps.py). This file covers only what round 1 could not, because the
code did not exist yet:

  * the PATCH echo fix. update_category now runs plan_color_slot_stage and echoes
    pending.get(cat_id, stored). THE IMPL SUITE'S OWN GUARD FOR THIS
    (test_editing_a_category_mid_migration_echoes_the_colour_the_list_shows) DOES NOT BITE:
    its victim is at index 0 of the drain order, so the read that computes `listed` also
    PERSISTS the victim's new slot, and the old "echo the stored value" code returns the
    identical number. Reverting the fix leaves it green. These tests freeze the migration
    write instead, so the stored value provably never moves and the two answers can differ;
  * the echo on an UNSLOTTED row, which pre-fix returned `null` — the worst case of the bug
    and the one the fix was chosen over dropping the field for;
  * the echo as an INVARIANT (PATCH agrees with GET) over randomised store shapes, plus the
    write count, the retry loop, the 404 path, and "PATCH is never stricter than GET";
  * plan_new_category_slot on inputs create_category cannot produce — an empty store, an
    all-corrupt store, 600 rows, mid-backfill — and the reachable path to the empty one;
  * _repaint_allowance at row_count 0.

Fakes live in tests/shared/_category_fakes.py, imported here as everywhere else (WHIT-440):
one definition, so a re-implemented FakeTable can't drift and start passing what the real one
rejects. Before WHIT-440 this suite re-exec'd the impl module by path.
"""

import random
from decimal import Decimal

import pytest

from _category_fakes import (
    _CFG, _SLOT, _cat, _drain, _piled_store, _repo_with_fake_table, _schema,
)

_SEED = 428_2


def _freeze_migration_writes(repo):
    """Silently DROP every colour-slot write while letting create/update/delete through.

    Routed on the ABSENCE of #id, the same discriminator FakeTable itself uses to recognise
    the migration's write shape. Dropped rather than raised: an exception would also exercise
    the fail-open branch, and this fixture is about the ECHO, not the policy. With the
    migration frozen the stored slots never move, so "the previewed colour" and "the stored
    colour" are two different numbers and a test can tell which one PATCH returned.
    """
    real = repo._table.update_item

    def _update_item(**kwargs):
        if "#id" not in kwargs["ExpressionAttributeNames"]:
            return
        return real(**kwargs)

    repo._table.update_item = _update_item


def _random_store(rng, repository):
    """A store of every shape the migration can meet: settled, piled, unslotted, corrupt."""
    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    for index in range(rng.choice([1, 5, 25, 60, 153])):
        cat_id = f"c{index:04d}"
        mode = rng.choice(["pile", "missing", "corrupt", "ok"])
        if mode == "pile":
            items[cat_id] = _cat(cat_id, colorSlot=Decimal(0))
        elif mode == "missing":
            items[cat_id] = _cat(cat_id)
        elif mode == "corrupt":
            items[cat_id] = _cat(cat_id, colorSlot=rng.choice(
                ["7", True, Decimal(-1), Decimal(99), Decimal("1.5")]))
        else:
            items[cat_id] = _cat(cat_id, colorSlot=Decimal(rng.randrange(20)))
    return items


# --- [B1]-[B3] the PATCH echo, with the migration write frozen ----------------


@pytest.mark.parametrize("reparent", [False, True])
def test_patch_echoes_the_previewed_colour_while_the_stored_one_never_moves(handler, reparent):
    """WHIT-428 — [B1] the fix, tested so it actually bites. The migration write is frozen, so
    the victim's STORED slot stays 0 for the whole test while GET previews its repaint
    destination. PATCH must return the previewed number. Echo the stored value again (revert
    the fix) and this reddens on the first assert. The reparent variant pins that the extra
    `#parent` SET clause does not disturb the echo."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)               # 73 rows, all customs on slot 0
    _freeze_migration_writes(repo)
    listed = {row["id"]: row[_SLOT] for row in repo.list_categories()}
    victim = next(cid for cid, slot in listed.items()
                  if cid.startswith("cat") and slot != 0)
    stored_before = int(repo._table.store[_CFG]["items"][victim][_SLOT])
    assert stored_before == 0, "fixture drifted: the migration was not frozen"

    edited = repo.update_category(
        victim, "Renamed", "Living", "tag",
        **({"parent": None} if reparent else {}))

    assert edited[_SLOT] == listed[victim], "PATCH echoed a colour the list does not show"
    assert edited[_SLOT] != stored_before, "fixture drifted: preview and stored agree"
    assert type(edited[_SLOT]) is int, "PATCH must carry a plain int, like GET and POST"
    # The write really did land, and it really did not touch the colour.
    assert repo._table.store[_CFG]["items"][victim]["name"] == "Renamed"
    assert int(repo._table.store[_CFG]["items"][victim][_SLOT]) == stored_before


def test_patch_on_an_unslotted_row_echoes_an_integer_never_null(handler):
    """WHIT-428 — [B2] the worst pre-fix case, and the one that decided the shape of the fix.
    A row the backfill has not reached yet has NO stored colorSlot, so echoing the stored value
    put `null` in the PATCH body — and the client falls back to a hashed colour when the field
    is absent, so an edit flipped the category to a colour from nowhere. It must echo the
    backfill's planned slot instead."""
    repository, repo = _repo_with_fake_table(handler)
    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    for index in range(60):
        items[f"c{index:04d}"] = _cat(f"c{index:04d}")   # no colorSlot at all
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1)}
    _freeze_migration_writes(repo)
    listed = {row["id"]: row[_SLOT] for row in repo.list_categories()}
    assert _SLOT not in repo._table.store[_CFG]["items"]["c0000"], "the freeze leaked"

    edited = repo.update_category("c0000", "Renamed", "Living", "tag")

    assert edited[_SLOT] is not None, "PATCH put a null colour in the body"
    assert type(edited[_SLOT]) is int and 0 <= edited[_SLOT] < 20
    assert edited[_SLOT] == listed["c0000"]


def test_patch_and_get_agree_about_the_colour_on_every_store_shape(handler):
    """WHIT-428 — [B3] the echo as an INVARIANT, not one scenario: for the same store state,
    PATCH's colour is GET's colour. Randomised over settled / piled / unslotted / corrupt
    stores at both marker values, with the migration frozen so a preview and a stored value
    are always distinguishable. This is the property the fix promises, and it is what makes
    the accepted mid-drain flip a GET behaviour rather than a PATCH-only one."""
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(_SEED)
    disagreed_if_stored = 0

    for _trial in range(150):
        _, repo = _repo_with_fake_table(handler)
        items = _random_store(rng, repository)
        repo._table.store[_CFG] = {
            "pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
            "version": Decimal(1), "colorSlotSchema": Decimal(rng.choice([1, 2]))}
        _freeze_migration_writes(repo)
        victim = rng.choice([cid for cid in items if cid.startswith("c0")])
        listed = {row["id"]: row[_SLOT] for row in repo.list_categories()}

        edited = repo.update_category(victim, "Renamed", items[victim]["bucket"], "tag")

        assert edited[_SLOT] == listed[victim], (
            f"PATCH and GET disagreed on {victim}: {edited[_SLOT]} vs {listed[victim]}")
        stored = _coerce(repo, victim)
        disagreed_if_stored += stored != listed[victim]

    assert disagreed_if_stored >= 40, (
        f"the generator stopped producing stores where the stored colour differs from the "
        f"previewed one, so this test could not tell the two apart: {disagreed_if_stored}")


def _coerce(repo, cat_id):
    raw = repo._table.store[_CFG]["items"][cat_id].get(_SLOT)
    return None if raw is None or isinstance(raw, (str, bool)) else int(raw)


# --- [B4]-[B7] what the added planner call must NOT change -------------------


def test_patch_still_takes_exactly_one_write_and_drains_no_migration(handler):
    """WHIT-428 — [B4] the echo is a PLAN, never a write. PATCH mid-migration must take one
    update_item and leave every stored colour and the marker exactly as it found them —
    otherwise an edit silently carries a 50-row migration chunk and can lose its own version
    race. Make update_category persist `pending` and this reddens."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    before = {cid: int(cat[_SLOT])
              for cid, cat in repo._table.store[_CFG]["items"].items()}
    repo._table.update_calls.clear()

    repo.update_category("cat0000", "Renamed", "Living", "tag")

    assert len(repo._table.update_calls) == 1, "PATCH wrote more than its own edit"
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1, "PATCH stamped the marker"


def test_patch_replans_on_the_second_read_after_losing_a_version_race(handler):
    """WHIT-428 — [B5] the retry loop. A concurrent writer DELETES 40 categories and bumps the
    version between PATCH's read and its write, so the allowance and the running counts both
    move and the victim's destination genuinely changes (2 -> 4 here). Attempt 2 re-reads, so
    the echo must be the answer for the store as it now is. Hoist the read or the planner out
    of the retry loop and this reddens.

    NOTE why the delete is needed: a plain "the racer drained the migration" race does NOT
    discriminate. Chunking is a fixed point of the planner, so a stale plan and a settled store
    agree by construction and a stale-read bug stays invisible. Only a change to the ROW COUNT
    moves the answer.
    """
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    _freeze_migration_writes(repo)
    before_race = {row["id"]: row[_SLOT] for row in repo.list_categories()}
    victim = next(cid for cid, slot in before_race.items()
                  if cid.startswith("cat") and slot != 0)

    def _another_invocation_deletes_40_categories(item):
        for index in range(20, 60):
            item["items"].pop(f"cat{index:04d}", None)
        item["version"] += Decimal(1)          # PATCH attempt 1 now fails its version check

    repo._table.before_update.append(_another_invocation_deletes_40_categories)

    edited = repo.update_category(victim, "Renamed", "Living", "tag")

    after_race = {row["id"]: row[_SLOT] for row in repo.list_categories()}
    assert len(after_race) == 33, "fixture drifted: the racer did not land"
    assert edited[_SLOT] == after_race[victim], \
        "PATCH echoed a colour planned on its stale first read"
    assert before_race[victim] != after_race[victim], \
        "fixture drifted: the race did not change the answer, so this test cannot discriminate"


def test_a_concurrent_delete_mid_repaint_is_a_clean_404_that_writes_nothing(handler):
    """WHIT-428 — [B6] the FAILURE path, mid-migration. The planner runs only after a
    successful write, so a row deleted under an in-flight PATCH must still be
    CategoryNotFoundError — and the failed edit must leave the store byte-identical: no colour
    moved, no marker stamped, no migration chunk carried in on its back. Give PATCH a
    create-style pre-loop drain and this reddens on the write count."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    before = {cid: int(cat[_SLOT])
              for cid, cat in repo._table.store[_CFG]["items"].items()}
    repo._table.update_calls.clear()
    repo._table.before_update.append(lambda item: item["items"].pop("cat0000", None))

    with pytest.raises(repository.CategoryNotFoundError):
        repo.update_category("cat0000", "Renamed", "Living", "tag")

    del before["cat0000"]
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before, \
        "a failed PATCH moved a colour"
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1, "a failed PATCH stamped the marker"
    assert repo._table.store[_CFG]["version"] == 1, "a failed PATCH bumped the version"


@pytest.mark.parametrize("bad_id, bad_row", [
    ("noid", {"name": "No Id", "icon": "tag", "color": "#fff", "bucket": "Living"}),
    ("nobucket", {"id": "nobucket", "name": "NB", "icon": "tag", "color": "#fff"}),
    ("empty", {}),
    ("nullslot", {"id": "nullslot", "name": "N", "icon": "tag", "color": "#fff",
                  "bucket": "Living", "colorSlot": None}),
])
def test_patch_is_never_stricter_than_the_read_it_now_borrows_its_planner_from(
    handler, bad_id, bad_row
):
    """WHIT-428 — [B7] the fix gave PATCH the READ path's planner, so PATCH now scans EVERY
    row where it used to touch one. Any malformed row a GET tolerates, a PATCH must tolerate
    too — and it matters more here, because the planner runs AFTER the conditional write has
    landed: a raise there reports a 500 for an edit that was actually saved. Add a stricter
    read (e.g. cat["id"]) to the echo path and this reddens."""
    repository, repo = _repo_with_fake_table(handler)
    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    for index in range(25):
        items[f"c{index:04d}"] = _cat(f"c{index:04d}", colorSlot=Decimal(0))
    items[bad_id] = dict(bad_row)
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}
    listed = {row.get("id"): row[_SLOT] for row in repo.list_categories()}   # must not raise

    edited = repo.update_category("c0000", "Renamed", "Living", "tag")

    assert type(edited[_SLOT]) is int and 0 <= edited[_SLOT] < 20
    assert edited[_SLOT] == listed["c0000"]


# --- [B8]-[B10] plan_new_category_slot as a newly PUBLIC function ------------


def test_plan_new_category_slot_holds_its_contract_on_stores_create_cannot_produce(handler):
    """WHIT-428 — [B8]/[B9] the planner was extracted out of create_category and exported in
    shared/repository.py __all__, so it is now callable on inputs the create path never
    reaches: an empty store, one where EVERY row is corrupt, one where every row is unslotted,
    600 rows, and mixtures. Two contracts, on every one of them:

      * it never raises and always returns an int in [0, _COLOR_SLOT_COUNT);
      * the row it slots is never evicted by the migration that follows — the whole reason
        the `crowded` cap and the PROJECTED counts exist. Simulated by draining the real
        stage planner to a fixed point, so nothing here re-derives the rule.
    """
    import repository as R
    rng = random.Random(_SEED + 1)
    all_corrupt_seen = 0

    for _trial in range(600):
        rows = rng.choice([0, 1, 13, 19, 20, 21, 40, 200, 600])
        mode = rng.choice(["ok", "missing", "corrupt", "pile", "mixed"])
        items = {}
        if rng.random() < 0.5:
            items.update({c: dict(v) for c, v in R.SEED_CATEGORIES.items()})
        for index in range(rows):
            cat_id = f"c{index:04d}"
            pick = rng.choice(["ok", "missing", "corrupt", "pile"]) if mode == "mixed" else mode
            if pick == "ok":
                items[cat_id] = _cat(cat_id, colorSlot=Decimal(rng.randrange(20)))
            elif pick == "pile":
                items[cat_id] = _cat(cat_id, colorSlot=Decimal(0))
            elif pick == "missing":
                items[cat_id] = _cat(cat_id)
            else:
                items[cat_id] = _cat(cat_id, colorSlot=rng.choice(
                    ["7", Decimal("1.5"), True, Decimal(-1), Decimal(99)]))
        all_corrupt_seen += mode == "corrupt" and rows >= 20

        slot = R.plan_new_category_slot(items)

        assert type(slot) is int and 0 <= slot < 20, f"unusable slot {slot!r} on {len(items)} rows"
        # Drain the real stage planner to a fixed point and check the new row kept its colour.
        store = {**items, "zzznew": _cat("zzznew", colorSlot=Decimal(slot))}
        for _ in range(8):
            plan, settled = R.plan_color_slot_stage(store, repainted=False)
            store = {cid: ({**cat, _SLOT: Decimal(plan[cid])} if cid in plan else cat)
                     for cid, cat in store.items()}
            if settled:
                break
        else:
            raise AssertionError("the stage planner did not settle")
        assert int(store["zzznew"][_SLOT]) == slot, (
            f"the migration evicted the colour a create would have returned: "
            f"{slot} -> {int(store['zzznew'][_SLOT])} on {len(items)} rows ({mode})")

    assert all_corrupt_seen >= 20, "the generator stopped producing all-corrupt stores"


def test_creating_on_a_store_whose_categories_were_all_deleted_still_gets_slot_zero(handler):
    """WHIT-428 — [B10] the reachable route to the EMPTY-store input. _ensure_seeded only
    writes when the config ITEM is absent, so once the user has deleted every category the
    item survives with an empty map and the next create really does call
    plan_new_category_slot({}). It must hand out slot 0 in a single write — not fall into
    least_held_color_slot's all-owed fallback, which is what an allowance computed from
    len(items) instead of len(items) + 1 would do (it answers 2)."""
    import repository as R
    _, repo = _repo_with_fake_table(handler)
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": {},
                               "version": Decimal(1),
                               "colorSlotSchema": Decimal(_schema())}

    assert R.plan_new_category_slot({}) == 0

    created = repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")

    assert created[_SLOT] == 0 and type(created[_SLOT]) is int
    assert len(repo._table.update_calls) == 1, "an emptied store re-ran the migration"
    assert int(repo._table.store[_CFG]["items"]["gym"][_SLOT]) == 0


# --- [B11] the allowance at row_count 0 --------------------------------------


def test_a_zero_row_allowance_is_reached_but_provably_inert(handler):
    """WHIT-428 — [B11] _repaint_allowance lost its `max(1, ...)` floor, so at row_count 0 it
    answers 0 — an allowance under which EVERY holder of a colour is a mover.

    It IS reached: list_categories on a store whose categories were all deleted goes
    plan_color_slot_stage({}) -> plan_color_slot_repaint({}) -> _repaint_movers({}) ->
    _repaint_allowance(0). It is inert there because `by_slot` is empty, so the number is never
    compared to anything. The OTHER caller, plan_new_category_slot, always adds the row it is
    about to create, so its argument is >= 1 and it can never reach this.

    Pinned by consequence rather than by the literal 0, so re-adding a floor stays green while
    a floor-div (which gives 0 for every store under 20 rows, and would repaint the sole holder
    of every colour) reddens: at EVERY row count from 1 to 60, one row per colour is never a
    mover.
    """
    import repository as R
    import repository_category as RC

    # Reached, and inert: no movers, no plan, settled, and no category clause in the write.
    assert RC._repaint_movers({}) == []
    assert R.plan_color_slot_repaint({}) == {}
    assert R.plan_color_slot_stage({}, repainted=False) == ({}, True)
    # The other caller can never pass 0 — it counts the row it is about to add.
    assert RC._repaint_allowance(len({}) + 1) >= 1

    # A sole holder is never a mover, at every size. A zero (or floored) allowance breaks this
    # for every store below 20 rows.
    for rows in range(1, 61):
        items = {f"c{index:02d}": _cat(f"c{index:02d}", colorSlot=Decimal(index % 20))
                 for index in range(rows)}
        movers = R.plan_color_slot_repaint(items)
        assert movers == {}, f"a level store of {rows} rows was repainted: {movers}"

    # End to end: the emptied store settles in ONE marker-only write and stays silent.
    _, repo = _repo_with_fake_table(handler)
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": {},
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    assert _drain(repo) == 1
    assert "#items" not in repo._table.update_calls[0][1], "an empty repaint wrote a category"
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
