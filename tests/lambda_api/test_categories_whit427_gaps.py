"""WHIT-427/429/439 — adversarial GAPS the implementer's reservation-property suite leaves open.

The implementer's tests/lambda_api/test_categories_reservation_properties.py already pins the
4KB bound, the drained rule, the empty-plan case, the cap surviving the fallback (common +
fallback), the create-never-displaces harness and freed-slot reuse. This file adds only the
independent, adversarial half:

  * _backfill_expression's SHAPE — byte-identity against an independent reference builder, the
    referential integrity of its incremental names/values, and that `settled` moves ONLY the
    schema clause (WHIT-427);
  * that _write_color_slots PERSISTS exactly what the pure builder returns (the extraction is
    faithful, nothing rewrites it between builder and table);
  * SlotPreference field-default independence;
  * the exact ORDER of least_held's sort key — count > cap > non-seed — and the free-branch cap
    claim, and discouraged interacting with protected in the all-owed fallback (WHIT-439).

Expected values are computed from the EXPORTED planners / constants, never re-derived by hand.
"""

from collections import Counter
from decimal import Decimal

from _category_fakes import _CFG, _SLOT, _repo_with_fake_table


# --- WHIT-427: _backfill_expression shape, faithfulness, referential integrity ---


def _reference_expression(version, plan, *, settled, chunk_size):
    """An INDEPENDENT re-statement of the documented write shape, so a drift in the extracted
    builder reddens. Mirrors repository_category.py's own contract: one `#v = :next`, then the
    marker clause IF drained, then one `#items.#catN.#slot = :slotN` per chunked category, in
    drain order (list(plan))."""
    order = list(plan)[:chunk_size]
    drained = len(order) == len(plan) and settled
    parts = ["#v = :next"]
    if drained:
        parts.append("#schema = :schema")
    if plan:
        for index, _cat_id in enumerate(order):
            parts.append(f"#items.#cat{index}.#slot = :slot{index}")
    return "SET " + ", ".join(parts)


def test_the_backfill_expression_is_byte_identical_to_the_documented_shape(handler):
    # [G1] the extraction (WHIT-427) must not have reordered or reshaped the clauses. Covers the
    # one case the reservation suite never asserts as a full string: BOTH the marker AND item
    # clauses present, where the schema clause must sit BETWEEN the version bump and the items.
    import repository_category as rc
    chunk = rc._COLOR_SLOT_WRITE_CHUNK

    for size, settled in [(1, True), (1, False), (chunk, True), (chunk, False),
                          (chunk + 10, True), (chunk + 10, False)]:
        plan = {f"cat{index:04d}": index % 20 for index in range(size)}
        expression, _n, _v, _d = rc._backfill_expression(Decimal(1), plan, settled=settled)
        assert expression == _reference_expression(
            Decimal(1), plan, settled=settled, chunk_size=chunk), (size, settled)

    # A full, settled plan carries the marker AND items: schema precedes the first item write.
    full = {f"cat{index:04d}": index % 20 for index in range(chunk)}
    expression, _n, _v, drained = rc._backfill_expression(Decimal(1), full, settled=True)
    assert drained is True
    assert expression.index("#schema = :schema") < expression.index("#items.#cat0")


def test_a_partial_chunk_declares_only_referenced_names_and_caps_the_item_writes(handler):
    # [G2] the incremental-names claim + the chunk cap, on the PURE builder (the reservation 4KB
    # test only checks length; the FakeTable's referential guard only fires on the driven path).
    # A 60-entry plan (>50 chunk) must declare exactly 50 #catN, none beyond, and every declared
    # name must appear in the expression — DynamoDB rejects a declared-but-unreferenced name.
    import re
    import repository_category as rc
    chunk = rc._COLOR_SLOT_WRITE_CHUNK

    plan = {f"cat{index:04d}": index % 20 for index in range(chunk + 10)}
    expression, names, values, drained = rc._backfill_expression(
        Decimal(1), plan, settled=True)

    assert drained is False                       # a partial chunk never drains, even settled
    assert "#schema" not in names and ":schema" not in values
    # Word-boundary, mirroring the FakeTable guard: "#cat1" is a substring of "#cat10".
    for alias in names:
        assert re.search(rf"{re.escape(alias)}(?![0-9])", expression), f"unused name {alias}"
    cat_names = [a for a in names if a.startswith("#cat")]
    assert len(cat_names) == chunk                # exactly one per chunked category, capped
    assert "#cat0" in names and f"#cat{chunk - 1}" in names
    assert f"#cat{chunk}" not in names            # the 51st category is NOT in this write
    # Values ride in lockstep with the clauses; :expected/:next always, :slot only per chunk row.
    assert ":expected" in values and ":next" in values
    assert ":slot0" in values and f":slot{chunk - 1}" in values
    assert f":slot{chunk}" not in values


def test_settled_moves_only_the_schema_clause_never_the_item_writes(handler):
    # [G3] `settled` is documented as shaping the expression alone. For a full plan, toggling it
    # must add/remove ONLY the schema name/value/clause and leave every #catN item write and its
    # slot value byte-identical — a drained write must never silently drop or reorder an item.
    import repository_category as rc
    chunk = rc._COLOR_SLOT_WRITE_CHUNK
    plan = {f"cat{index:04d}": index % 20 for index in range(chunk)}   # full == one chunk

    exp_on, names_on, values_on, drained_on = rc._backfill_expression(
        Decimal(1), plan, settled=True)
    exp_off, names_off, values_off, drained_off = rc._backfill_expression(
        Decimal(1), plan, settled=False)

    assert drained_on is True and drained_off is False
    # Names differ ONLY by #schema; values ONLY by :schema.
    assert set(names_on) - set(names_off) == {"#schema"}
    assert set(names_off) - set(names_on) == set()
    assert set(values_on) - set(values_off) == {":schema"}
    # Every item name/value is identical across the toggle.
    for key in names_off:
        assert names_on[key] == names_off[key]
    for key in values_off:
        assert values_on[key] == values_off[key]
    # The item-write clauses (everything after stripping the marker clause) are identical.
    assert exp_on.replace("#schema = :schema, ", "") == exp_off


def test_write_color_slots_persists_exactly_what_the_pure_builder_returns(handler):
    # [G4] faithfulness of the extraction end-to-end: _write_color_slots holds ONLY write policy,
    # so what it hands DynamoDB mid-drain must equal _backfill_expression's output for the same
    # (version, plan, settled) — nothing post-processes or overrides the builder. Plan/settled
    # come from the EXPORTED stage planner, one-shot; version from the store.
    import repository
    import repository_category as rc
    _, repo = _repo_with_fake_table(handler)

    # Seeds are already slotted, so a 60-row unslotted custom overlay makes the FIRST write a
    # partial chunk (plan len 60 > 50) — the interesting case where names are declared per-row.
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(60):
        cid = f"cat{index:04d}"
        items[cid] = {"id": cid, "name": f"Cat {index}", "icon": "tag", "color": "#888888",
                      "bucket": "Lifestyle", "parent": None}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1)}

    item = repo._get_config()
    repainted = repo._is_slot_migrated(item)
    plan, settled = repository.plan_color_slot_stage(item["items"], repainted=repainted)
    version = item["version"]
    expected = rc._backfill_expression(version, plan, settled=settled)

    repo.list_categories()                        # persists the first chunk via _write_color_slots
    got_expression, got_names, got_values = repo._table.update_calls[0]

    assert got_expression == expected[0]
    assert got_names == expected[1]
    assert got_values == expected[2]


# --- WHIT-439: SlotPreference and least_held's sort key -----------------------


def test_slot_preference_fields_default_independently(handler):
    # [G5] the three levers are independent: naming one must leave the other two empty, and two
    # default-constructed preferences must be equal (no shared-mutable-default surprise).
    import repository
    only_disc = repository.SlotPreference(discouraged=frozenset({1}))
    assert only_disc.discouraged == frozenset({1})
    assert only_disc.excluded == frozenset() and only_disc.protected == frozenset()

    only_prot = repository.SlotPreference(protected=frozenset({2}))
    assert only_prot.protected == frozenset({2})
    assert only_prot.excluded == frozenset() and only_prot.discouraged == frozenset()

    assert repository.SlotPreference() == repository.SlotPreference()


def test_a_free_discouraged_slot_is_never_handed_out_by_the_free_branch(handler):
    # [G6] the free-branch cap claim (repository_category.py free branch): `discouraged` is
    # stripped from `candidates`, so a capped slot that happens to be free can never reach
    # `min(free)`. Slot 0 is free (count 0) and normally the lowest-free answer; capping it
    # steps to slot 1.
    import repository
    assert repository.least_held_color_slot(Counter(), repository.SlotPreference()) == 0
    assert repository.least_held_color_slot(
        Counter(), repository.SlotPreference(discouraged=frozenset({0}))) == 1


def test_the_fallback_sort_key_ranks_count_over_cap_over_nonseed(handler):
    # [G7] the exact tuple order (count, discouraged, non-seed, slot) in least_held. All 20 slots
    # excluded forces the all-owed fallback, where the key actually decides.
    import repository
    every = frozenset(range(20))

    # cap DOMINATES the non-seed preference: slots 0 (seed) and 2 (non-seed) tie at the lowest
    # count. Uncapped, the non-seed slot 2 wins; cap it and the ranking steps to the seed slot 0
    # — proving `discouraged` sits ABOVE `non-seed` in the key, not below it.
    counts = Counter({slot: 2 for slot in range(20)})
    counts[0] = 1
    counts[2] = 1
    assert repository.least_held_color_slot(
        counts, repository.SlotPreference(excluded=every)) == 2
    assert repository.least_held_color_slot(
        counts, repository.SlotPreference(excluded=every, discouraged=frozenset({2}))) == 0

    # count DOMINATES the cap: a discouraged slot held far less is still taken (last resort).
    lean = Counter({slot: 5 for slot in range(20)})
    lean[2] = 0
    assert repository.least_held_color_slot(
        lean, repository.SlotPreference(excluded=every, discouraged=frozenset({2}))) == 2


def test_protected_and_discouraged_apply_together_in_the_fallback(handler):
    # [G8] both soft levers bind at once in the all-owed fallback: `protected` removes a slot from
    # `spare` outright, `discouraged` only penalises it. Slot 3 is the sole free slot (the natural
    # pick); protecting it forces a held slot, and capping slot 2 pushes the choice off the lowest
    # non-seed one (2) onto the next (4).
    import repository
    every = frozenset(range(20))
    counts = Counter({slot: 5 for slot in range(20)})
    counts[3] = 0

    # Nothing protected/capped: the free slot 3 is taken back.
    assert repository.least_held_color_slot(
        counts, repository.SlotPreference(excluded=every)) == 3
    # Protect 3 (removed from spare) and cap 2 (penalised): the answer is the next uncapped
    # non-seed slot, 4 — neither the protected 3 nor the discouraged 2.
    assert repository.least_held_color_slot(counts, repository.SlotPreference(
        excluded=every, protected=frozenset({3}), discouraged=frozenset({2}))) == 4
