"""WHIT-427/429/439 — the pure pieces and the reservation invariants.

Three things the surgical WHIT-405 tests could not reach cleanly:

  * the colour-slot WRITE EXPRESSION as a pure value (WHIT-427). Since `_backfill_expression`
    was extracted out of `_write_color_slots`, its 4KB bound, its `drained` rule and the
    empty-plan case are properties of the returned string ALONE — asserted here with no fake
    table driving `update_calls[0][0]` back out;
  * the soft cap surviving the all-owed fallback (WHIT-439) — the `discouraged` lever, which is
    kept out of the ordinary candidates like `excluded` but ranked (not dropped) in the fallback;
  * the reservation invariants over RANDOMISED stores (WHIT-429) rather than one hand-picked
    shape — the gap that let two tests pass without exercising the thing they name.

Expected values come from the EXPORTED planners applied one-shot, never re-implemented here, the
same discipline as test_categories.py's chunk-equivalence suite. The store builder and fakes are
the shared ones in tests/shared/_category_fakes.py — ONE definition across every category suite.
"""

import copy
import random
from collections import Counter
from decimal import Decimal

from _category_fakes import (
    _CFG, _SLOT, _drain, _random_legacy_store, _repo_with_fake_table,
    _MAX_UPDATE_EXPRESSION_BYTES,
)


# --- WHIT-427: _backfill_expression as a pure value --------------------------


def test_the_backfill_expression_stays_under_dynamodbs_4kb_cap(handler):
    """The 4KB bound is a property of the expression STRING, provable without a fake table now
    that the chunk cap lives inside the pure builder. A 130-entry plan would build a ~4.1KB
    expression unchunked (the documented 130-rejected point); chunked it must stay well under.
    Delete the `[:_COLOR_SLOT_WRITE_CHUNK]` slice and this reddens."""
    import repository_category

    plan = {f"cat{index:04d}": index % 20 for index in range(130)}
    expression, _names, _values, _drained = repository_category._backfill_expression(
        Decimal(1), plan, settled=False)

    assert len(expression.encode()) <= _MAX_UPDATE_EXPRESSION_BYTES
    # Well under, not just under: the cap exists to leave headroom, not to sit on the line.
    assert len(expression.encode()) < _MAX_UPDATE_EXPRESSION_BYTES // 2


def test_the_drained_flag_needs_a_full_final_chunk_and_a_settled_store(handler):
    """`drained = len(chunk) == len(plan) and settled`, and it is what stamps the migrated
    marker. Only a full final chunk of a SETTLED store drains; a partial chunk or an unsettled
    store must not, or the remaining rows are stranded / the repaint is skipped."""
    import repository_category

    full_plan = {f"cat{index:04d}": index % 20 for index in range(10)}     # one chunk
    partial_plan = {f"cat{index:04d}": index % 20 for index in range(60)}  # two chunks

    # Full final chunk + settled -> drained, and the marker clause is in the expression.
    expression, names, values, drained = repository_category._backfill_expression(
        Decimal(1), full_plan, settled=True)
    assert drained is True
    assert "#schema = :schema" in expression
    assert "#schema" in names and ":schema" in values

    # Same plan, not settled -> not drained, no marker clause (a backfill with a repaint owed).
    expression, names, _values, drained = repository_category._backfill_expression(
        Decimal(1), full_plan, settled=False)
    assert drained is False
    assert "#schema" not in expression and "#schema" not in names

    # A partial chunk never drains, even when settled — the rest is still owed.
    _expression, names, _values, drained = repository_category._backfill_expression(
        Decimal(1), partial_plan, settled=True)
    assert drained is False
    assert "#schema" not in names


def test_an_empty_plan_still_stamps_the_marker_and_never_touches_items(handler):
    """The 'all categories deleted' path: an empty plan is drained, so it must still write the
    marker (so the store stops re-planning), but carry NO #items name — DynamoDB rejects a
    declared-but-unreferenced name."""
    import repository_category

    expression, names, values, drained = repository_category._backfill_expression(
        Decimal(1), {}, settled=True)

    assert drained is True
    assert names == {"#v": "version", "#schema": repository_category._COLOR_SLOT_SCHEMA_FIELD}
    assert "#items" not in names and ":slot0" not in values
    assert expression == "SET #v = :next, #schema = :schema"

    # An empty, UNSETTLED plan writes only the version bump (a marker-only no-op is not owed).
    expression, names, _values, drained = repository_category._backfill_expression(
        Decimal(1), {}, settled=False)
    assert drained is False
    assert expression == "SET #v = :next"


# --- WHIT-439: the soft cap survives the all-owed fallback -------------------


def test_a_soft_cap_is_a_hard_exclusion_on_the_common_path(handler):
    """`discouraged` keeps the common path byte-identical to the old `reserved | crowded` union:
    while an uncapped slot is available a capped one is never handed out."""
    import repository

    counts = Counter({slot: 1 for slot in range(20)})
    # Slot 2 is the lowest non-seed slot, so it wins with no preference...
    assert repository.least_held_color_slot(counts, repository.SlotPreference()) == 2
    # ...but capping it steps to the next non-seed slot, exactly as unioning it into `excluded`
    # would have — the cap bites on the common path.
    capped_two = repository.SlotPreference(discouraged=frozenset({2}))
    assert repository.least_held_color_slot(counts, capped_two) == 3


def test_a_soft_cap_survives_the_all_owed_fallback_as_a_ranking_penalty(handler):
    """WHIT-439 — the bug this structure fixes. When every slot is excluded the fallback used to
    rebuild its candidates from `range` and DROP the cap wholesale, so a caller that folded a cap
    into `reserved` lost it exactly when the store was most crowded. As `discouraged` the cap
    rides through: a capped slot ranks last among equally-held, so it is avoided when an
    alternative exists. Revert the `discouraged` term in least_held's sort key and this reddens."""
    import repository

    counts = Counter({slot: 1 for slot in range(20)})
    every_slot = frozenset(range(20))

    # Every slot owed -> fallback. With no cap the lowest non-seed slot (2) is taken back.
    assert repository.least_held_color_slot(
        counts, repository.SlotPreference(excluded=every_slot)) == 2
    # Cap slot 2: the fallback now steps past it to the next non-seed slot (3) instead of
    # dropping the cap and handing back the crowded slot 2.
    assert repository.least_held_color_slot(
        counts, repository.SlotPreference(excluded=every_slot, discouraged=frozenset({2}))) == 3
    # `protected` still keeps a built-in's own hue off the chopping block, unchanged by the cap.
    slot = repository.least_held_color_slot(
        counts, repository.SlotPreference(excluded=every_slot, protected=every_slot))
    assert isinstance(slot, int) and 0 <= slot < 20


# --- WHIT-429: the reservation invariants over randomised stores -------------

_RESERVATION_TRIALS = 200
_RESERVATION_SEED = 429


def test_a_create_never_displaces_a_builtin_from_its_owed_hue_over_random_stores(handler):
    """WHIT-429 — every reservation test today pins one hand-picked store, and the all-reserved
    fallback bug slipped past all of them. Run randomised legacy stores through
    read -> optional lost-race pre-backfill -> create -> drain, and assert the create never
    steals a slot the backfill owed a built-in for its OWN designated hue: each such built-in
    still ends up ON that slot. Expected owed-set comes from the exported planner, one-shot."""
    import repository

    rng = random.Random(_RESERVATION_SEED)
    saw_owed_builtins = 0
    saw_lost_race = 0

    for trial in range(_RESERVATION_TRIALS):
        _, repo = _repo_with_fake_table(handler)
        original = _random_legacy_store(repository, rng)
        repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                                   "items": copy.deepcopy(original), "version": Decimal(1)}

        # The built-ins pass 1 genuinely OWES their designated slot: unslotted, and that slot
        # free in the store. Only those are entitled to keep it — a built-in that merely landed
        # on its own hue via a pass-2 least-held coincidence (its slot was already taken) has no
        # claim, and the create shifting the counts may re-plan it elsewhere. Read from the
        # exported planner + the exported histogram, one-shot, never re-derived by hand.
        plan = repository.plan_color_slot_backfill(copy.deepcopy(original))
        stored_counts = repository.color_slot_counts(original)
        owed_to_builtin = {
            cat_id: slot for cat_id, slot in plan.items()
            if (repository.SEED_CATEGORIES.get(cat_id) or {}).get(_SLOT) == slot
            and stored_counts[slot] == 0
        }
        if owed_to_builtin:
            saw_owed_builtins += 1

        repo.list_categories()                        # preview + first chunk
        if rng.random() < 0.5:                        # a lost race: another writer drained a chunk
            repo.list_categories()
            saw_lost_race += 1

        created = repo.create_category("newcategoryx", "New", "Lifestyle", "glass")
        _drain(repo, limit=40)

        stored = {cat_id: int(cat[_SLOT])
                  for cat_id, cat in repo._table.store[_CFG]["items"].items()}
        assert 0 <= created[_SLOT] < 20
        # The create + drain never displaced a built-in from the slot it was owed — a stored slot
        # is permanent, so a create that had stolen it would force the built-in somewhere else.
        for builtin, slot in owed_to_builtin.items():
            assert stored[builtin] == slot, \
                f"trial {trial}: {builtin} owed slot {slot}, ended on {stored[builtin]}"
        # The whole store settles: every row slotted, the marker present.
        assert all(_SLOT in cat for cat in repo._table.store[_CFG]["items"].values())
        assert "colorSlotSchema" in repo._table.store[_CFG]

    # Guard the guard: the invariant is vacuous unless stores actually owe built-ins their hue,
    # and the lost-race arm must actually fire.
    assert saw_owed_builtins >= 100, saw_owed_builtins
    assert saw_lost_race >= 50, saw_lost_race


def test_a_freed_slot_is_genuinely_reused_not_just_reusable(handler):
    """WHIT-429 — the vacuous test_deleting_a_category_frees_its_slot_for_reuse only ever showed
    a LOWER free slot getting picked, never the freed one itself. Build a settled store holding
    every slot, free ONE non-seed slot by deleting its sole holder, and assert the next create
    lands on exactly that slot — the only genuinely free one."""
    import repository

    _, repo = _repo_with_fake_table(handler)
    # 13 seeds on their designated slots, plus one custom row on each of the 7 non-seed slots, so
    # all 20 slots are held exactly once. The store is already migrated (schema 2), so nothing is
    # owed and the create ranks on stored counts alone.
    non_seed = sorted(repository.least_held_color_slot.__globals__["_NON_SEED_COLOR_SLOTS"])
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for slot in non_seed:
        cat_id = f"custom{slot:02d}"
        items[cat_id] = {"id": cat_id, "name": cat_id, "icon": "tag", "color": "#888888",
                         "bucket": "Lifestyle", "parent": None, _SLOT: Decimal(slot)}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(2)}

    freed = non_seed[0]
    repo.delete_category(f"custom{freed:02d}")        # slot `freed` is now held by nobody

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")
    assert created[_SLOT] == freed
