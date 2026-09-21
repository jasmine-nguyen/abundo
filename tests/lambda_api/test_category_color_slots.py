"""Permanent chart colour-slot (colorSlot) tests for the category endpoints.

A category's chart colour is a STORED integer, assigned once and never recomputed, so
adding or deleting a category cannot repaint any other one (WHIT-427/428/429/439).

Extracted from test_categories.py and consolidated with the former per-ticket satellites
(reservation_properties, whit427_gaps, whit428_gaps, whit428_round2) under one topical
roof (WHIT-462). Test bodies moved verbatim; each folded block keeps its own local helpers.

The `handler` fixture (conftest.py) makes lambda_api importable in isolation and puts
`shared/` on the path, so `import repository` inside a test resolves under it.
"""

import copy
import inspect
import json
import random
from collections import Counter
from decimal import Decimal

import pytest

from _chart_ramp import assignment_order as client_assignment_order
from _category_fakes import (
    FakeTable, FakeBudgetRepo, _ccfe, _validation_error,
    _MAX_UPDATE_EXPRESSION_BYTES, _CFG, _SLOT, _cat, _categories_event,
    _drain, _piled_store, _random_legacy_store, _repo_with_fake_table, _schema,
    _slot_histogram, _throttle,
)


# A concurrent-writer stand-in for the optimistic-lock retry paths (shared with
# test_categories.py; kept local here — a shared home is WHIT-466's job).
def _bump_version(item):
    item["version"] = item["version"] + 1  # Decimal + int -> Decimal


# --- permanent chart colour slots (colorSlot) --------------------------------
#
# A category's chart colour is a STORED integer, assigned once and never recomputed, so
# adding or deleting a category cannot repaint any other one. These tests pin that promise,
# the one-time backfill that gives existing stores their slots, and — most importantly —
# that the backfill can NEVER fail a read (seven handler routes call list_categories).

# The solved slot table (see repository_category.SEED_CATEGORIES): each built-in in its own hue family, spread around the ramp.
SEED_SLOTS = {
    "eatingout": 0, "travel": 1, "fitness": 6, "gifts": 7, "health": 8, "coffee": 9,
    "utilities": 10, "groceries": 11, "shopping": 13, "transport": 15, "phonenet": 16,
    "pets": 17, "subs": 18,
}


def _legacy_store(repo, repository, *, extra=None, drop_marker=True):
    """A store as it existed BEFORE colorSlot: seeded rows with no slot, no marker."""
    items = {}
    for cat_id, cat in repository.SEED_CATEGORIES.items():
        items[cat_id] = {k: v for k, v in cat.items() if k != "colorSlot"}
    if extra:
        items.update(copy.deepcopy(extra))
    item = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items, "version": Decimal(1)}
    if not drop_marker:
        item["colorSlotSchema"] = 1
    repo._table.store[_CFG] = item
    return item


def test_seed_slots_are_the_solved_table(handler):
    import repository
    slots = {cid: cat["colorSlot"] for cid, cat in repository.SEED_CATEGORIES.items()}
    assert slots == SEED_SLOTS
    assert len(set(slots.values())) == 13          # distinct: no two built-ins share a colour
    assert all(0 <= s < 20 for s in slots.values())


def test_fresh_store_is_born_migrated_and_never_backfills(handler):
    repository, repo = _repo_with_fake_table(handler)
    rows = repo.list_categories()
    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS
    # The seed put_item carries the marker, so a brand-new store performs NO backfill write.
    assert repo._table.update_calls == []
    assert repo._table.store[_CFG]["version"] == 1


def test_legacy_store_backfills_once_to_the_solved_table(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)

    rows = repo.list_categories()

    # Every built-in lands on its designated slot — an existing user's colours are the ones
    # that were solved for, not whatever a lowest-free walk would have handed out.
    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS
    stored = repo._table.store[_CFG]
    assert {cid: c["colorSlot"] for cid, c in stored["items"].items()} == SEED_SLOTS
    assert stored["colorSlotSchema"] == _schema() and stored["version"] == 2
    assert len(repo._table.update_calls) == 1


def test_migrated_store_performs_zero_writes_on_every_later_read(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo.list_categories()                      # migrates
    repo._table.update_calls.clear()

    for _ in range(5):
        rows = repo.list_categories()

    # "One-time migration, not work on every load" — the load-bearing guarantee.
    assert repo._table.update_calls == []
    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS


def test_empty_plan_still_stamps_the_marker_without_touching_items(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository, drop_marker=True)
    # Everything already validly slotted, but the marker is missing.
    for cat_id, cat in repo._table.store[_CFG]["items"].items():
        cat["colorSlot"] = SEED_SLOTS[cat_id]

    repo.list_categories()

    expr, names, _ = repo._table.update_calls[0]
    # Declaring #items with nothing to write would be a DynamoDB ValidationException.
    assert set(names) == {"#v", "#schema"}
    assert "#items" not in expr
    repo._table.update_calls.clear()
    repo.list_categories()
    assert repo._table.update_calls == []       # and it never re-plans again


def test_store_with_every_category_deleted_still_stops_replanning(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": {}, "version": 1}

    assert repo.list_categories() == []
    assert len(repo._table.update_calls) == 1   # marker written
    repo._table.update_calls.clear()
    assert repo.list_categories() == []
    assert repo._table.update_calls == []       # not once per read, forever


def test_corrupt_slots_are_reassigned_not_trusted(handler):
    repository, repo = _repo_with_fake_table(handler)
    bad = {
        "s": {"id": "s", "name": "S", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": "7"},
        "f": {"id": "f", "name": "F", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": 7.5},
        "n": {"id": "n", "name": "N", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": -5},
        "b": {"id": "b", "name": "B", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": True},
        "o": {"id": "o", "name": "O", "icon": "i", "color": "#fff", "bucket": "Living", "colorSlot": 999},
    }
    _legacy_store(repo, repository, extra=bad)

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    for cat_id in bad:
        assert isinstance(rows[cat_id], int) and 0 <= rows[cat_id] < 20
    assert len(set(rows.values())) == len(rows)          # still all distinct
    assert {k: rows[k] for k in SEED_SLOTS} == SEED_SLOTS   # built-ins unaffected


def test_already_slotted_rows_keep_their_slots_when_others_backfill(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.store[_CFG]["items"]["coffee"]["colorSlot"] = 19   # deliberately not its seed slot

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    assert rows["coffee"] == 19                     # untouched: never repaint a stored slot
    _, names, _ = repo._table.update_calls[0]
    assert "coffee" not in names.values()           # and it isn't even in the write
    assert rows["eatingout"] == 0                   # the rest still land on their table


def test_read_fails_open_when_the_backfill_write_is_throttled(handler):
    """The blocker this design exists for: a failed backfill must NOT fail the read.

    list_categories is called by GET /categories, /breakdown, /budgets, /insights and more.
    A raise here would 500 or 409 a read that would otherwise have succeeded.
    """
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.update_error = _throttle()

    rows = repo.list_categories()                   # must not raise

    # The response still carries the RIGHT slots, computed in memory.
    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS
    # Nothing was persisted, so a later request retries.
    assert "colorSlotSchema" not in repo._table.store[_CFG]


def test_read_fails_open_when_another_writer_wins_the_race(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.update_error = _ccfe()

    rows = repo.list_categories()

    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS


def test_create_fails_closed_when_the_backfill_write_errors(handler):
    """The write path is the opposite policy: a real DB fault is a real failure."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.update_error = _throttle()

    with pytest.raises(repository.DatabaseError):
        repo.create_category("wine", "Wine", "Lifestyle", "glass")


def test_create_takes_the_lowest_free_slot(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                          # seed (slots 0,1,6,7,8,9,10,11,13,15,16,17,18)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 2                # lowest free under the solved table
    assert repo._table.store[_CFG]["items"]["wine"]["colorSlot"] == 2


def test_create_on_a_legacy_store_lands_on_the_first_attempt(handler):
    """The backfill runs BEFORE the retry loop. Inside it, it would bump the version between
    create's read and its conditional write and burn attempt 1 of 2 on every create."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 2
    # exactly two writes: the backfill, then the create. A third means create retried.
    assert len(repo._table.update_calls) == 2


def test_deleting_a_category_frees_its_slot_for_reuse(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    assert repository.SEED_CATEGORIES["gifts"]["colorSlot"] == 7

    repo.delete_category("gifts")
    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 2                # still the lowest free, not gifts' 7
    repo.delete_category("coffee")                  # frees slot 9
    assert repo.create_category("beer", "Beer", "Lifestyle", "glass")["colorSlot"] == 3


def test_adding_and_deleting_never_repaints_another_category(handler):
    """The card's whole promise, asserted end to end."""
    repository, repo = _repo_with_fake_table(handler)
    before = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    repo.create_category("wine", "Wine", "Lifestyle", "glass")
    after_add = {r["id"]: r["colorSlot"] for r in repo.list_categories()}
    assert {k: after_add[k] for k in before} == before

    repo.delete_category("wine")
    after_delete = {r["id"]: r["colorSlot"] for r in repo.list_categories()}
    assert after_delete == before


def test_plan_is_deterministic_regardless_of_map_order(handler):
    import repository
    items = {cid: {k: v for k, v in cat.items() if k != "colorSlot"}
             for cid, cat in repository.SEED_CATEGORIES.items()}
    reordered = {cid: items[cid] for cid in reversed(list(items))}

    # Both request paths compute the plan independently; if they could disagree, a deferred
    # write and the response it already returned would show different colours.
    assert repository.plan_color_slot_backfill(items) == repository.plan_color_slot_backfill(reordered)
    assert repository.plan_color_slot_backfill(items) == SEED_SLOTS


def test_least_held_color_slot_is_the_lowest_free_slot_below_saturation(handler):
    """While any slot is free, least-held IS lowest-free — a free slot has count 0 and always
    wins, so WHIT-404 changed nothing for a store under 20 categories."""
    import repository
    no_preference = repository.SlotPreference()
    assert repository.least_held_color_slot(Counter(), no_preference) == 0
    assert repository.least_held_color_slot(Counter({0: 1, 1: 1, 2: 1}), no_preference) == 3
    assert repository.least_held_color_slot(Counter({0: 1, 2: 1, 3: 1}), no_preference) == 1  # delete freed 1
    # A deleted BUILT-IN's slot is reused immediately too — the non-seed preference decides
    # which colour to DOUBLE UP on, and that question does not exist while a slot is free.
    seeds_minus_eatingout = Counter({slot: 1 for slot in range(1, 20)})
    assert repository.least_held_color_slot(seeds_minus_eatingout, no_preference) == 0
    # Junk outside the ramp cannot make a real slot look taken, and reading a missing slot
    # must not INSERT it (a plain dict here would raise instead).
    junk = Counter({99: 5, -1: 3})
    assert repository.least_held_color_slot(junk, no_preference) == 0
    assert set(junk) == {99, -1}


def test_least_held_color_slot_spreads_repeats_instead_of_piling_on_one(handler):
    """WHIT-404: past 20 categories a duplicate is unavoidable, but it must not always be the
    SAME duplicate. Before this, every category past the 20th took slot 0."""
    import repository
    no_preference = repository.SlotPreference()
    full = Counter({slot: 1 for slot in range(20)})
    assert repository.least_held_color_slot(full, no_preference) == 2       # lowest non-seed slot
    full[2] += 1
    assert repository.least_held_color_slot(full, no_preference) == 3       # next non-seed, not 2 again
    # Saturated but uneven: the emptiest slot wins even though it is not the lowest. (A merely
    # FREE slot 7 would not discriminate — the old lowest-free walk answers 7 too.)
    uneven = Counter({slot: 2 for slot in range(20)})
    uneven[0] = 5
    uneven[7] = 1
    assert repository.least_held_color_slot(uneven, no_preference) == 7


def test_least_held_color_slot_prefers_slots_no_builtin_owns(handler):
    """WHIT-404 option B: a repeat has to land somewhere, and doubling up on a colour only a
    custom category wears beats doubling up on Eating Out's. Derived from SEED_CATEGORIES, so
    it cannot drift if the seeds are retuned."""
    import repository
    import repository_category
    seed_slots = {int(cat["colorSlot"]) for cat in repository.SEED_CATEGORIES.values()}
    non_seed = repository_category._NON_SEED_COLOR_SLOTS
    assert non_seed == frozenset(range(20)) - seed_slots
    # slot 0 (Eating Out) and slot 2 (no built-in) both held once: the non-seed slot wins even
    # though 0 is the lower number.
    full = Counter({slot: 1 for slot in range(20)})
    assert repository.least_held_color_slot(full, repository.SlotPreference()) == 2
    # ...but count still dominates preference: a seed slot held ONCE beats a non-seed held twice.
    full.update({slot: 1 for slot in sorted(non_seed)})
    assert repository.least_held_color_slot(full, repository.SlotPreference()) == 0


def test_least_held_color_slot_treats_reserved_as_a_hard_exclusion(handler):
    """The blocker WHIT-404's first plan shipped: an owed slot is held by NOBODY, so counting
    it as merely +1 leaves it tied with a singly-held slot and the tie-break hands it over —
    permanently stealing the colour the backfill was about to give a built-in."""
    import repository
    # The owed slot must be a NON-SEED slot or this cannot discriminate: if it belonged to a
    # built-in, the non-seed preference would walk away from it anyway and the test would pass
    # against the weight design too. Slot 2 is free and owned by no built-in.
    counts = Counter({0: 1, 1: 1, **{slot: 1 for slot in range(3, 20)}})
    assert repository.least_held_color_slot(
        counts, repository.SlotPreference()) == 2                            # unexcluded: takes it
    assert repository.least_held_color_slot(
        counts, repository.SlotPreference(excluded=frozenset({2}))) == 3     # excluded: skips it
    # Every slot owed (an unmigrated store with >20 unslotted rows): something must be taken
    # back, but it must not be a built-in's designated slot. Slot 1 is travel's and free;
    # returning it would repaint travel permanently, which is the bug this branch exists for.
    assert repository.least_held_color_slot(
        Counter({0: 1}), repository.SlotPreference(excluded=frozenset(range(20)))) == 2


def test_slot_survives_json_encoding_as_a_number(handler):
    """DynamoDB hands back Decimal; the client reads JSON. Pin the seam between the slices."""
    import repository
    from encoders import DecimalEncoder
    _, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    decoded = json.loads(json.dumps(created, cls=DecimalEncoder))

    assert decoded["colorSlot"] == 2
    # `type is int`, not isinstance: bool passes isinstance(int), and a Decimal would encode
    # to 2.0 (a float) — the POST body must match the int GET returns.
    assert type(decoded["colorSlot"]) is int


# --- colorSlot: the adversarial half -----------------------------------------


def test_read_fails_open_when_the_backfill_hits_a_network_error(handler):
    """A timeout is a BotoCoreError, NOT a ClientError. Catching only ClientError would let
    it escape and 500 every route that reads categories — the outage fail-open exists to
    prevent, and the likeliest transient fault in Lambda."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)

    class NetworkBlip(Exception):
        pass
    repo._table.update_error = NetworkBlip("connect timeout")

    rows = repo.list_categories()  # must not raise

    assert {r["id"]: r["colorSlot"] for r in rows} == SEED_SLOTS
    assert "colorSlotSchema" not in repo._table.store[_CFG]  # nothing persisted; retries later


def test_a_stored_row_without_an_id_field_does_not_break_the_read(handler):
    """list_categories fails OPEN on write faults, so it must not gain a way for malformed
    DATA to fail the read either — it is on the read path of every category-reading route."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.store[_CFG]["items"]["orphan"] = {
        k: v for k, v in _cat("orphan").items() if k != "id"}

    assert len(repo.list_categories()) == 14


def test_a_config_item_without_a_version_does_not_break_the_read(handler):
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    del repo._table.store[_CFG]["version"]

    assert len(repo.list_categories()) == 13


def test_a_row_whose_id_disagrees_with_its_map_key_still_gets_its_slot(handler):
    """The plan and the write are both keyed by the MAP KEY; the response must be too, or a
    skewed row is stamped in the store but returned with a null slot — which the client would
    resolve to an undefined colour."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.store[_CFG]["items"]["skew"] = _cat("skew-different")

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    assert rows["skew-different"] is not None


def test_a_custom_id_sorting_before_a_builtin_cannot_steal_its_slot(handler):
    """Pass 1 runs to completion over ALL missing ids before pass 2 starts. Collapse them
    into one alphabetical walk and "aaa" takes slot 0 — eatingout's designated hue."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository, extra={"aaa": _cat("aaa"), "aab": _cat("aab")})

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    assert {k: rows[k] for k in SEED_SLOTS} == SEED_SLOTS
    assert rows["aaa"] == 2 and rows["aab"] == 3   # the first slots no built-in wants
    assert len(set(rows.values())) == len(rows)


def test_create_cannot_steal_a_slot_the_deferred_backfill_still_owes(handler):
    """The pre-loop backfill LOSES its race, so create runs against still-unslotted rows. It
    must reserve what the plan owes them, or it takes 0 (eatingout's colour) and the next
    read repaints one of them."""
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository)
    repo._table.before_update.append(_bump_version)  # backfill write -> CCFE, silent no-op

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 2                 # NOT 0
    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}
    assert {k: rows[k] for k in SEED_SLOTS} == SEED_SLOTS
    assert len(set(rows.values())) == len(rows)


def test_two_creates_racing_never_land_on_the_same_slot(handler):
    """The slot is computed INSIDE the retry loop, so the loser re-reads and sees the
    winner's slot taken. Hoist it out of the loop and both creates land on 2."""
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                           # migrated; lowest free = 2

    def concurrent_create(item):
        item["items"]["beer"] = _cat("beer", "Lifestyle", colorSlot=Decimal(2))
        item["version"] = item["version"] + 1
    repo._table.before_update.append(concurrent_create)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 3                 # not 2 — the winner holds that
    stored = repo._table.store[_CFG]["items"]
    assert stored["beer"]["colorSlot"] == 2 and stored["wine"]["colorSlot"] == 3


def test_past_twenty_categories_slots_stay_in_range(handler):
    """The ramp has 20 colours, so past 20 live categories distinctness is impossible. Pin
    what actually happens so the client can never index outside the ramp."""
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                           # 13 seeds
    slots = [int(repo.create_category(f"x{n}", f"X{n}", "Lifestyle", "tag")["colorSlot"])
             for n in range(9)]                      # the 14th .. 22nd category

    assert all(0 <= s < 20 for s in slots)
    # WHIT-415 moved coffee off slot 4 onto 9, so the free list shifts but stays 7 long.
    assert slots[:7] == [2, 3, 4, 5, 12, 14, 19]     # every free slot, lowest first
    # WHIT-404: ramp full -> the repeat goes to the LEAST-held slot, preferring one no
    # built-in owns. Was [0, 0] — every category past the 20th piled onto Eating Out.
    assert slots[7:] == [2, 3]


def test_plan_past_twenty_unslotted_rows_stays_in_range(handler):
    import repository
    items = {f"c{n:02d}": _cat(f"c{n:02d}") for n in range(25)}

    plan = repository.plan_color_slot_backfill(items)

    assert len(plan) == 25
    assert all(0 <= s < 20 for s in plan.values())   # never an out-of-ramp index
    assert sorted(set(plan.values())) == list(range(20))


def test_colorslot_never_reaches_the_ai_model_input_hash(handler):
    """POST /insights/ai hashes model_input to decide cache-hit vs a PAID Anthropic re-run.
    If the projection ever stopped dropping this new field, every cached insight would bust
    once and every user would pay for a regeneration. Nothing else enforces it."""
    cats_without = [{"id": "coffee", "name": "Cafes", "bucket": "Lifestyle", "parent": None},
                    {"id": "rent", "name": "Rent", "bucket": "Living", "parent": None}]
    cats_with = [{**c, "colorSlot": 4} for c in cats_without]
    txns = [{"category": "coffee", "amount": -10, "status": "posted",
             "counts_to_budget": True, "date": "2026-06-01"}]

    rows_without = handler._window_category_spend(txns, cats_without)
    rows_with = handler._window_category_spend(txns, cats_with)

    assert rows_with == rows_without
    assert "colorSlot" not in json.dumps(rows_with, sort_keys=True)


@pytest.mark.crosslang  # reads src/chartColors.ts (ASSIGNMENT_ORDER) via _chart_ramp
def test_seed_slots_are_spread_across_the_colour_ramp(handler):
    """The property the seed table was solved for — and the one two reviewers misread.

    A slot is NOT a ramp position: the client resolves it through ASSIGNMENT_ORDER, so
    consecutive slots are deliberately far apart in hue. Measuring runs on the raw slot
    numbers is meaningless (they run 15,16,17,18 but resolve to ramp 13,14,16,18). This
    pins the real invariant: no more than 3 built-ins ever occupy neighbouring ramp entries.

    ASSIGNMENT_ORDER lives client-side (src/chartColors.ts, slice 2) and is READ from
    there rather than copied (WHIT-406): a hand-typed copy would keep measuring a
    permutation the app no longer ships, so regenerating it client-side would repaint
    every category with nothing going red. tests/shared/test_color_slot_ramp_drift.py
    guards the lengths against the server's slot range.
    """
    import repository
    assignment_order = client_assignment_order()
    assert sorted(assignment_order) == list(range(len(assignment_order)))  # a true permutation

    ramp = sorted(assignment_order[cat["colorSlot"]]
                  for cat in repository.SEED_CATEGORIES.values())
    assert len(set(ramp)) == 13                          # 13 distinct colours

    longest = run = 1
    for previous, current in zip(ramp, ramp[1:]):
        run = run + 1 if current == previous + 1 else 1
        longest = max(longest, run)
    assert longest == 3, f"longest neighbouring-ramp run is {longest}: {ramp}"


# =============================================================================
# WHIT-415 — the seed re-space as PROPERTIES, not slot numbers.
#
# Every colour-slot test above pins an integer. Re-shuffle the seed and they all just get
# retyped, and the INTENT is never checked — test_seed_slots_are_spread_across_the_colour_ramp
# ("longest run == 3") was true BEFORE this card and is true AFTER it, so it did not guard the
# fix at all. These compute the RESOLVED RAMP LAYOUT from repository.SEED_CATEGORIES and assert
# what the card actually promised, so a future bad re-space fails loudly instead of quietly.
# =============================================================================

# The client's slot -> ramp-position permutation (src/chartColors.ts ASSIGNMENT_ORDER). Nothing in
# a pytest process can see the TypeScript, so this is a hand copy — the WHIT-406 gap. It is guarded
# from the OTHER side by src/__tests__/seedSlotSync.logic.test.ts, which parses this module's seed
# out of the .py and checks the same run structure. Both must be edited to move a slot unnoticed.
_ASSIGNMENT_ORDER = [0, 10, 5, 15, 2, 7, 12, 17, 1, 3, 4, 6, 8, 9, 11, 13, 14, 16, 18, 19]


def _seed_ramp(repository) -> dict:
    """{built-in id -> the RAMP POSITION its stored slot resolves to on the client}."""
    return {cid: _ASSIGNMENT_ORDER[cat["colorSlot"]]
            for cid, cat in repository.SEED_CATEGORIES.items()}


def _neighbouring_runs(ramp: dict) -> list:
    """Ids sitting on NEIGHBOURING ramp entries, grouped, warm end first. Runs of 1 are dropped.
    This is the shape a user perceives: a run of N is N near-identical hues that read as one
    colour when they land next to each other in the ring."""
    ordered = sorted((position, cid) for cid, position in ramp.items())
    runs, current = [], [ordered[0]]
    for previous, entry in zip(ordered, ordered[1:]):
        if entry[0] == previous[0] + 1:
            current.append(entry)
        else:
            runs.append(current)
            current = [entry]
    runs.append(current)
    return [[cid for _, cid in run] for run in runs if len(run) > 1]


def test_no_builtin_trio_sits_on_the_warm_end_of_the_ramp(handler):
    """THE card: Eating Out / Health / Coffee resolved to ramp 0/1/2 and, as the top three by
    spend, painted as three near-identical salmons. Asserted as the property — not as
    "coffee's slot is 9", which the next re-shuffle would simply retype."""
    import repository
    ramp = _seed_ramp(repository)

    warm_runs = [run for run in _neighbouring_runs(ramp) if min(ramp[c] for c in run) <= 5]
    assert all(len(run) <= 2 for run in warm_runs), f"warm-end run of 3+: {warm_runs}"
    # the salmon end (ramp 0-2) holds at most a PAIR, and nothing may creep back into it
    assert sorted(c for c, p in ramp.items() if p <= 2) == ["eatingout", "health"]
    # and the pair the card named by name is broken apart
    assert abs(ramp["coffee"] - ramp["eatingout"]) > 1
    assert abs(ramp["coffee"] - ramp["health"]) > 1


def test_the_neighbouring_builtin_runs_are_exactly_these(handler):
    """WHICH built-ins touch, pinned by name. Re-space again and you must edit this on purpose.

    It also records, honestly, what the card did NOT fix: TWO trios survive — fitness/transport/
    phonenet (ramp 12/13/14) and pets/gifts/subs (16/17/18) — and 12->13->14 are the TIGHTEST
    steps in the whole ramp, tighter than the warm trio that was just removed. Same symptom,
    different hue family; out of the approved scope, so it is pinned rather than fixed.
    """
    import repository
    assert _neighbouring_runs(_seed_ramp(repository)) == [
        ["eatingout", "health"],
        ["coffee", "utilities"],
        ["shopping", "travel"],
        ["fitness", "transport", "phonenet"],
        ["pets", "gifts", "subs"],
    ]


def test_the_slots_new_categories_get_never_reuse_a_builtin_hue(handler):
    """The property behind `slots[:7] == [3, 4, 5, 10, 12, 14, 19]`: the free slots are free
    RAMP ENTRIES too, so the first seven categories a user creates each get a hue no built-in
    owns. A re-space that duplicated a seed slot, or moved one onto a slot the lowest-free walk
    hands out, would give a custom category a built-in's exact colour — invisible in a table of
    magic numbers, caught here."""
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    builtin_ramp = set(_seed_ramp(repository).values())

    created = [repo.create_category(f"c{n}", f"C{n}", "Lifestyle", "tag") for n in range(7)]
    custom_ramp = [_ASSIGNMENT_ORDER[c["colorSlot"]] for c in created]

    assert len(set(custom_ramp)) == 7                       # seven distinct hues
    assert set(custom_ramp).isdisjoint(builtin_ramp)        # none of them a built-in's colour
    # 13 built-ins + 7 customs = the whole ramp, exactly once each
    assert set(custom_ramp) | builtin_ramp == set(range(20))


def test_the_first_custom_category_stays_out_of_the_ramps_tightest_stretch(handler):
    """Re-spacing the seed changes which slot is lowest-free, so it silently changes the colour a
    user's FIRST custom category gets. That is the trap this test exists for.

    Moving BOTH coffee and utilities (the obvious re-space) pushed the lowest free slot to 3, which
    resolves to ramp 15 — the gap between Phone & Internet (14) and Pets (16), the two tightest
    steps in the ramp — so the first custom category joined a run of SEVEN. Moving coffee alone
    keeps it on ramp 5, in the widest-spaced stretch, with the longest run at FOUR
    (coffee/utilities/wine/groceries, every step wider than any pair this card removed).

    Fail-on-revert: move utilities to slot 2 as well and wine lands on ramp 15 in a run of 7.
    """
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()

    first = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    ramp = _seed_ramp(repository)
    ramp["wine"] = _ASSIGNMENT_ORDER[first["colorSlot"]]
    assert ramp["wine"] == 5
    runs = _neighbouring_runs(ramp)
    assert max(len(run) for run in runs) == 4
    assert ["coffee", "utilities", "wine", "groceries"] in runs
    # the blue cluster — the tightest stretch — must not have grown
    assert ["fitness", "transport", "phonenet"] in runs


@pytest.mark.parametrize("builtin,slot", [("coffee", 9)])
def test_a_custom_category_squatting_on_a_new_seed_slot_is_never_evicted(handler, builtin, slot):
    """Slots 2 and 9 are the two the re-space newly claims. Slot 2 in particular is the one the
    OLD lowest-free walk handed to the first category a user ever created, so a store that was
    partially slotted under the old rules can arrive with a squatter sitting exactly there.

    The rule that must hold: a stored slot is PERMANENT (WHIT-405), so the squatter keeps it and
    the built-in gives way — never the reverse, and never a shared colour.
    """
    repository, repo = _repo_with_fake_table(handler)
    _legacy_store(repo, repository, extra={"wine": _cat("wine", colorSlot=Decimal(slot))})

    rows = {r["id"]: r["colorSlot"] for r in repo.list_categories()}

    assert rows["wine"] == slot                      # the squatter is never repainted
    assert rows[builtin] != slot                     # the built-in gives way
    assert len(set(rows.values())) == len(rows)      # and nobody ends up sharing a colour
    # every OTHER built-in still lands on its solved slot
    assert {k: v for k, v in rows.items() if k in SEED_SLOTS and k != builtin} == \
           {k: v for k, v in SEED_SLOTS.items() if k != builtin}
    # The consequence worth knowing: the evicted built-in takes the lowest free slot, which
    # resolves to ramp 5 — so a squatter turns Coffee from an amber into an olive. Acceptable
    # (permanence beats hue fidelity), but not silent. Coffee's slot 9 is the ONLY slot this card
    # newly claims, so it is the only one a legacy squatter can now contest.
    assert _ASSIGNMENT_ORDER[rows[builtin]] == 5

# ---- WHIT-405: the backfill write is chunked so it can never exceed DynamoDB's 4KB cap ------

# The last clause count that fits DynamoDB's 4KB UpdateExpression cap: 129 clauses = 4070
# bytes, 130 = 4103. Any plan above this could not be written at all before the chunk cap.
_LAST_UNCHUNKED_CLAUSE_COUNT = 129

def _unslotted_store(repo, repository, count):
    """A legacy store with `count` EXTRA unslotted custom categories on top of the seeds."""
    extra = {f"cat{index:04d}": {"id": f"cat{index:04d}", "name": f"Cat {index}",
                                 "icon": "tag", "color": "#888888",
                                 "bucket": "Lifestyle", "parent": None}
             for index in range(count)}
    return _legacy_store(repo, repository, extra=extra)


def test_a_backfill_expression_never_exceeds_dynamodbs_4kb_limit(handler):
    """The structural guard. Unchunked, 200 categories build a ~6KB expression that the real
    service rejects — and FakeTable now rejects it too, so deleting the cap reddens here."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    repo.list_categories()

    expression = repo._table.update_calls[0][0]
    assert len(expression.encode()) <= _MAX_UPDATE_EXPRESSION_BYTES
    # Well under, not just under: the cap exists to leave headroom, not to sit on the line.
    assert len(expression.encode()) < _MAX_UPDATE_EXPRESSION_BYTES // 2


def test_a_read_mid_drain_still_returns_every_category_fully_slotted(handler):
    """The user-visible guarantee: colours are right immediately, the database catches up
    behind. The response applies the WHOLE plan even though one chunk was persisted."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    rows = repo.list_categories()               # persists 50, returns all 213

    assert len(rows) == 213
    assert all(0 <= row["colorSlot"] < 20 for row in rows)
    # only the first chunk reached storage
    persisted = [cat for cat in repo._table.store[_CFG]["items"].values() if "colorSlot" in cat]
    assert len(persisted) == 50


def test_create_survives_a_backfill_too_big_for_one_write(handler):
    """The severity test — this is the production 500 the card describes. Unchunked, the
    pre-loop backfill runs strict=True against a 213-row plan, the expression is rejected,
    and POST /categories 500s forever."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    # Not raising IS the assertion — on the unchunked code this call goes through
    # handle_database_error and raises DatabaseError, which the handler does not catch.
    # Slot 10 because the ramp is saturated past 20 live categories, so a duplicate is
    # unavoidable, and after the create's own first chunk the backfill still owes every slot —
    # the all-owed fallback. The cap now rides in as `discouraged`, so the create lands on the
    # least-held slot that is NOT over the repaint allowance (slot 10), instead of the lowest
    # over-cap one the fallback used to drop the cap for (WHIT-439). The non-collision property
    # is pinned by test_create_cannot_steal_a_slot_the_deferred_backfill_still_owes.
    assert created["colorSlot"] == 10


def test_a_throttled_chunk_leaves_earlier_chunks_intact_and_recovers(handler):
    """Fail-open has to survive PART-WAY through a drain: the throttle lands after chunk 1,
    so the rows already stamped must stay stamped, the marker must stay absent, and once the
    throttle clears a later read must finish the job."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    repo.list_categories()                       # chunk 1 lands
    persisted = {cid: cat["colorSlot"]
                 for cid, cat in repo._table.store[_CFG]["items"].items() if "colorSlot" in cat}
    assert len(persisted) == 50

    repo._table.update_error = _throttle()
    rows = repo.list_categories()                # chunk 2 is throttled — must not raise

    assert len(rows) == 213                      # response is still complete and correct
    assert all(0 <= row["colorSlot"] < 20 for row in rows)
    assert "colorSlotSchema" not in repo._table.store[_CFG]
    # the throttled write changed nothing — chunk 1's rows are untouched
    assert {cid: cat["colorSlot"]
            for cid, cat in repo._table.store[_CFG]["items"].items()
            if "colorSlot" in cat} == persisted

    repo._table.update_error = None
    _drain(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_a_delete_between_chunks_still_lands_on_the_planners_fixed_point(handler):
    """A category removed mid-drain must leave every survivor stamped, on exactly the
    slots a fresh plan over the surviving rows would assign."""
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    repo.list_categories()                       # chunk 1
    repo.delete_category("cat0150")              # still unslotted, in a later chunk
    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    assert "cat0150" not in stored
    assert all("colorSlot" in cat for cat in stored.values())
    expected = repository.plan_color_slot_backfill(
        {cid: {k: v for k, v in cat.items() if k != "colorSlot"} for cid, cat in stored.items()}
    )
    assert {cid: int(cat["colorSlot"]) for cid, cat in stored.items()} == \
        {cid: int(slot) for cid, slot in expected.items()}


# ---- WHIT-405 [A1]-[A10]: randomised and boundary coverage of the chunked drain -------------
# The tests above cover the drain on hand-built stores. These cover it on GENERATED ones, on
# the exact chunk boundaries, and while another write lands mid-drain. [A1] is the one that
# catches a break the hand-built tests miss entirely: the equivalence argument rests on the
# chunk being an ALPHABETICAL prefix, so reversing the sort order diverges only on stores the
# generator produces. Expected values always come from the real exported planner — nothing is
# re-implemented here, so these cannot catch a planner bug; [A9] is the absolute pin for that.

def _exactly_unslotted(repo, count, *, version=1):
    """A store whose plan size is EXACTLY `count` — no seeds, so nothing else is unslotted.
    Lets a test sit precisely on a chunk boundary."""
    items = {f"c{index:04d}": {"id": f"c{index:04d}", "name": f"C{index}", "icon": "tag",
                               "color": "#888888", "bucket": "Lifestyle", "parent": None}
             for index in range(count)}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": items, "version": Decimal(version)}
    return repo._table.store[_CFG]


# 250 randomised stores, fixed seed: deterministic, and wide enough that many trials exceed
# the clause count where an unchunked expression is rejected outright.
_PROPERTY_TRIALS = 250
_PROPERTY_SEED = 405


def test_a_chunked_drain_lands_exactly_where_one_unchunked_write_would_have(handler):
    # WHIT-405 — [A1] chunking is equivalent to one shot, over randomised stores.
    # The committed convergence test pins a SINGLE store shape. The equivalence argument in
    # _write_color_slots' docstring ("persisting an alphabetical prefix is a fixed point of
    # the planner") is subtle and load-bearing, and nothing in the suite exercises it against
    # varied shapes: built-ins scattered through the chunk order, pre-slotted rows, corrupt
    # slots, and saturation past 20. Expected values come from the REAL exported planner
    # (repository.plan_color_slot_backfill) applied once to the original store — never
    # re-implemented here.
    import random
    import repository_category
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(_PROPERTY_SEED)
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK
    saw_over_the_unchunked_limit = 0

    for trial in range(_PROPERTY_TRIALS):
        _, repo = _repo_with_fake_table(handler)
        original = _random_legacy_store(repository, rng)
        repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                                   "items": copy.deepcopy(original), "version": Decimal(1)}
        one_shot = repository.plan_color_slot_backfill(copy.deepcopy(original))
        if len(one_shot) > _LAST_UNCHUNKED_CLAUSE_COUNT:
            saw_over_the_unchunked_limit += 1
        # What single unbounded writes would have left in the table. Since WHIT-428 that is
        # TWO stages composed: the backfill, then the repaint of its result — 6 of these 250
        # stores are still piled after the backfill and need both. The expectation is built
        # from the two EXPORTED planners applied one-shot; deriving it by looping
        # plan_color_slot_stage would compare the code to itself and would pass even on a
        # planner that never converges.
        settled_store = {cid: ({**cat, _SLOT: Decimal(one_shot[cid])} if cid in one_shot
                               else cat)
                         for cid, cat in copy.deepcopy(original).items()}
        repaint = repository.plan_color_slot_repaint(settled_store)
        expected = {cid: int(repaint[cid]) if cid in repaint else int(cat[_SLOT])
                    for cid, cat in settled_store.items()}

        writes = _drain(repo, limit=30)

        stored = repo._table.store[_CFG]["items"]
        assert {cid: int(cat[_SLOT]) for cid, cat in stored.items()} == expected, \
            f"trial {trial}: chunked drain diverged from the one-shot plan"
        # Bounded, and never more writes than chunks: no read may re-plan work already done.
        # A repaint stage costs its own chunks on top of the backfill's.
        expected_writes = max(1, -(-len(one_shot) // chunk))
        if repaint:
            expected_writes += max(1, -(-len(repaint) // chunk))
        assert writes == expected_writes, f"trial {trial}: {writes} writes"
        assert repo._table.store[_CFG]["colorSlotSchema"] == _schema(), f"trial {trial}: unmarked"

    # Guard the guard: if the generator ever stopped producing stores past the point an
    # unchunked expression is rejected, this test would quietly stop testing the fix.
    assert saw_over_the_unchunked_limit >= 20, saw_over_the_unchunked_limit


def test_a_marker_is_never_present_while_a_row_is_still_unslotted(handler):
    # WHIT-405 — [A2] the marker means "every row is stamped", checked after EVERY write of
    # every randomised drain, not just the first chunk of one store. This is the invariant
    # `drained` exists to hold; the committed test checks it at one point of one store.
    import random
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(_PROPERTY_SEED + 1)

    for trial in range(60):
        _, repo = _repo_with_fake_table(handler)
        repo._table.store[_CFG] = {
            "pk": "CATEGORIES", "sk": "CATEGORIES",
            "items": _random_legacy_store(repository, rng), "version": Decimal(1)}

        for _ in range(30):
            before = len(repo._table.update_calls)
            repo.list_categories()
            config = repo._table.store[_CFG]
            if "colorSlotSchema" in config:
                # Marker present -> BOTH real planners must find nothing left to do. Since
                # WHIT-428 the marker means more than "every row is stamped": it also means
                # the ramp is level. Without the repaint half, a store stamped on the
                # backfill's last chunk would strand a row on a shared colour forever.
                assert repository.plan_color_slot_backfill(config["items"]) == {}, \
                    f"trial {trial}: marker stamped with rows still unslotted"
                assert repository.plan_color_slot_repaint(config["items"]) == {}, \
                    f"trial {trial}: marker stamped with the ramp still piled"
            if len(repo._table.update_calls) == before:
                break
        else:
            raise AssertionError(f"trial {trial}: backfill did not converge")
        assert "colorSlotSchema" in repo._table.store[_CFG]


@pytest.mark.parametrize("unslotted,expected_writes", [
    (1, 1),        # smallest non-empty plan
    (49, 1),       # one under the chunk
    (50, 1),       # EXACTLY the chunk: must drain and stamp in a single write, not two
    (51, 2),       # one over: a 50 chunk plus a 1 remainder
    (100, 2),      # exact multiple: no empty third write
    (129, 3),      # the last plan an unchunked expression could still have written
    (130, 3),      # the first plan an unchunked expression could NOT (4103 bytes) — the card
    (213, 5),
])
def test_a_drain_takes_exactly_one_write_per_chunk(handler, unslotted, expected_writes):
    # WHIT-405 — [A3] chunk boundaries, including the 129/130 point the card names.
    # An off-by-one in `chunk`/`drained` shows up here as a wrong write count or a store that
    # keeps writing forever; the committed suite only ever tests 213.
    repository, repo = _repo_with_fake_table(handler)
    _exactly_unslotted(repo, unslotted)
    one_shot = repository.plan_color_slot_backfill(
        copy.deepcopy(repo._table.store[_CFG]["items"]))
    assert len(one_shot) == unslotted            # the fixture really does sit on the boundary

    writes = _drain(repo)

    assert writes == expected_writes
    stored = repo._table.store[_CFG]
    assert {cid: int(c[_SLOT]) for cid, c in stored["items"].items()} == \
        {cid: int(s) for cid, s in one_shot.items()}
    assert stored["colorSlotSchema"] == _schema()
    # ...and a fully drained store is back to one get_item per read, forever.
    repo._table.update_calls.clear()
    repo.list_categories()
    repo.list_categories()
    assert repo._table.update_calls == []


def test_a_create_between_chunks_keeps_its_slot_and_the_drain_still_finishes(handler):
    # WHIT-405 — [A4] only a DELETE between chunks is pinned. A create is the write that
    # actually adds a row the later chunks have never planned for, and it runs its own
    # strict=True backfill first — so it both consumes a chunk and inserts a row.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)

    repo.list_categories()                                   # chunk 1
    after_chunk_one = {cid: int(cat[_SLOT])
                       for cid, cat in repo._table.store[_CFG]["items"].items() if _SLOT in cat}
    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")
    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    # The created row keeps the slot the POST already told the client about — a later chunk
    # must never repaint a category that was already handed a colour.
    assert int(stored["wine"][_SLOT]) == created[_SLOT]
    assert all(_SLOT in cat for cat in stored.values()), "a row was left permanently unslotted"
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    # WHIT-428 replaced a "re-plan the final store and compare" assertion here. It could not
    # survive, and NOT for a fixture reason: `wine`'s slot counts towards the least-held rule
    # from the moment it is created, so rows stamped in chunk 1 never saw it while a fresh
    # whole-store plan does — ~110 rows legitimately shift by one. The drain is a fixed point
    # under PREFIX PERSISTENCE, not under INSERTION. These three are what still bind, and (a)
    # is the stronger user-visible claim: a colour you have already been shown never changes.
    assert {cid: int(stored[cid][_SLOT]) for cid in after_chunk_one} == after_chunk_one
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    holders = _slot_histogram(repo)
    assert max(holders.values()) - min(holders.values()) <= 1


def test_a_create_mid_drain_spends_one_backfill_write_and_one_create_write(handler):
    # WHIT-405 — [A5] the retry budget. create_category runs the backfill BEFORE its 2-attempt
    # loop precisely so the version bump can't burn attempt 1. Now that the backfill takes
    # several bumps to finish, pin that a create still costs exactly one backfill write plus
    # one create write — moving the backfill inside the loop would show up as 3+.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    repo.list_categories()                                   # leave the store mid-drain
    repo._table.update_calls.clear()

    repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert len(repo._table.update_calls) == 2
    slot_writes = [names for _e, names, _v in repo._table.update_calls if "#slot" in names]
    assert len(slot_writes) == 1


def test_a_create_mid_drain_still_survives_one_concurrent_version_bump(handler):
    # WHIT-405 — [A6] the second half of the budget: attempt 2 must still be available. A
    # concurrent writer bumps the version between the create's read and its write; the create
    # has to retry and succeed, mid-drain, not 409.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    repo.list_categories()                                   # mid-drain
    # Skip the create's own backfill write, then race its first create attempt.
    repo._table.before_update = [lambda item: None, _bump_version]

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["id"] == "wine"
    assert "wine" in repo._table.store[_CFG]["items"]


def test_update_and_delete_mid_drain_succeed_on_their_first_attempt(handler):
    # WHIT-405 — [A7] update/delete never run the backfill, so a mid-drain store must not cost
    # them a retry. If either ever started migrating inline, its own version bump would
    # guarantee a CCFE and halve its budget — this pins one update_item call each.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    repo.list_categories()                                   # mid-drain, marker absent
    assert "colorSlotSchema" not in repo._table.store[_CFG]
    repo._table.update_calls.clear()

    repo.update_category("coffee", "Cafes", "Lifestyle", "coffee")
    assert len(repo._table.update_calls) == 1
    repo._table.update_calls.clear()

    repo.delete_category("cat0100")
    assert len(repo._table.update_calls) == 1
    assert repo._table.store[_CFG]["items"]["coffee"]["name"] == "Cafes"
    assert "cat0100" not in repo._table.store[_CFG]["items"]


def test_rows_already_holding_a_valid_slot_never_move_during_a_chunked_drain(handler):
    # WHIT-405 — [A8] "adding a category cannot repaint any other" has to survive the drain.
    # These five sit on deliberately non-designated slots, so a chunk that re-derived them
    # instead of leaving them alone would change their colour.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    pinned = {"cat0000": 19, "cat0060": 3, "cat0120": 12, "coffee": 9, "transport": 5}
    for cat_id, slot in pinned.items():
        repo._table.store[_CFG]["items"][cat_id][_SLOT] = Decimal(slot)

    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in pinned} == pinned
    assert all(_SLOT in cat for cat in stored.values())


def test_every_built_in_pass_one_entitles_is_stamped_by_the_first_chunk(handler):
    # WHIT-405 [A9] / WHIT-428. Ids sorting BEFORE every built-in used to push all 13 seeds
    # past the first chunk, which was the user-visible risk of chunking. Since WHIT-428 the
    # chunk is a prefix of the DRAIN ORDER, and pass 1 is emitted first — so a built-in
    # entitled to its designation can never fall past chunk 1. That is not a nicety: it is
    # what makes chunking equivalent to one shot now that pass 2's overflow moves.
    #
    # NOTE the premise must be read off color_slot_plan_order, not sorted(). Computing it from
    # sorted() still "passes" while asserting nothing about what the code actually writes.
    repository, repo = _repo_with_fake_table(handler)
    early = {f"aaa{index:04d}": {"id": f"aaa{index:04d}", "name": "A", "icon": "tag",
                                 "color": "#888888", "bucket": "Lifestyle", "parent": None}
             for index in range(60)}
    _legacy_store(repo, repository, extra=early)
    plan = repository.plan_color_slot_backfill(repo._table.store[_CFG]["items"])
    first_chunk = repository.color_slot_plan_order(plan)[:50]
    entitled = [cid for cid, slot in plan.items()
                if repository.SEED_CATEGORIES.get(cid, {}).get(_SLOT) == slot]
    assert len(entitled) == 13
    assert set(entitled) <= set(first_chunk), "a built-in's designation slipped past chunk 1"

    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in repository.SEED_CATEGORIES} == SEED_SLOTS


def test_a_chunk_that_loses_the_version_race_writes_nothing_and_a_later_read_recovers(handler):
    # WHIT-405 — [A10] a partial write is conditional too. A concurrent writer bumping the
    # version between this read's plan and its write must make the chunk a clean no-op — no
    # half-stamped rows, no marker — and the next read must still converge.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)
    repo._table.before_update.append(_bump_version)

    repo.list_categories()

    stored = repo._table.store[_CFG]
    assert not any(_SLOT in cat for cat in stored["items"].values()), "a lost race half-wrote"
    assert "colorSlotSchema" not in stored

    _drain(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    assert all(_SLOT in cat for cat in repo._table.store[_CFG]["items"].values())


# ---- WHIT-404: repeats past 20 categories spread instead of piling onto one slot ------------

def test_a_create_on_a_saturated_store_cannot_steal_a_slot_the_backfill_owes(handler):
    """The bug WHIT-404's first design shipped. An owed slot is held by NOBODY, so if the
    reservation were a WEIGHT rather than a hard exclusion it would tie with the singly-held
    slots and the tie-break would hand it straight over — permanently repainting the row the
    backfill was about to colour.

    The owed slot must be a NON-SEED slot for this to discriminate: if it belonged to a
    built-in, the non-seed preference would steer away from it by accident and the test would
    pass against the broken design too."""
    repository, repo = _repo_with_fake_table(handler)
    items = {cat_id: dict(seed) for cat_id, seed in repository.SEED_CATEGORIES.items()}
    # Every non-seed slot held EXCEPT 2, so the planner owes 2 to the one unslotted row.
    # (WHIT-415 moved coffee onto slot 9 and freed slot 4, so the non-seed set shifted.)
    for index, slot in enumerate([3, 4, 5, 12, 14, 19]):
        items[f"custom{index}"] = _cat(f"custom{index}", colorSlot=Decimal(slot))
    items["aaa"] = _cat("aaa")                          # unslotted -> owed the lowest free slot
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": items, "version": Decimal(1)}
    owed = repository.plan_color_slot_backfill(items)["aaa"]
    assert owed == 2, "fixture drifted: the unslotted row must be owed a non-seed slot"
    # The pre-loop backfill loses its race, so aaa is still unslotted when the slot is chosen.
    repo._table.before_update.append(_bump_version)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] != owed, "create stole the slot the backfill owed aaa"
    assert created["colorSlot"] == 3
    # And aaa really does still get that slot once the drain catches up.
    repo.list_categories()
    assert int(repo._table.store[_CFG]["items"]["aaa"]["colorSlot"]) == owed


def test_every_slot_holds_two_categories_before_any_slot_holds_three(handler):
    """The card's actual complaint: 30 categories used to leave 23 of them sharing one colour.
    Round-robin means the ramp fills evenly — and the seven slots no built-in owns go first."""
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                                    # 13 seeds
    slots = [int(repo.create_category(f"x{n}", f"X{n}", "Lifestyle", "tag")["colorSlot"])
             for n in range(27)]                              # categories 14 .. 40

    non_seed = sorted(frozenset(range(20)) - set(SEED_SLOTS.values()))
    assert slots[:7] == non_seed                              # lap 1: the free slots
    assert slots[7:14] == non_seed                            # lap 2: double up on those FIRST
    assert sorted(slots[14:]) == sorted(SEED_SLOTS.values())  # only then the built-ins
    holders = Counter(int(cat["colorSlot"])
                      for cat in repo._table.store[_CFG]["items"].values())
    assert set(holders) == set(range(20)) and set(holders.values()) == {2}


def test_the_backfill_planner_is_a_fixed_point_on_its_own_drain_order(handler):
    """Since WHIT-428 there is ONE assigner: create and the backfill planner both spread via
    least_held_color_slot. What keeps WHIT-405's chunked drain equivalent to one unchunked
    write is no longer a constant overflow — it is the ORDER. Persisting a prefix of
    color_slot_plan_order and re-planning must reproduce the one-shot plan exactly.

    This is the fail-on-revert guard for the order. Swap color_slot_plan_order back to
    sorted() and it diverges on 132 of these 250 stores, because an alphabetically-early
    overflow row can then be persisted onto a slot pass 1 had claimed for a built-in, and the
    robbed built-in lands somewhere new on the re-plan. Under the old CONSTANT overflow the
    robbed row fell through to the same value, which is why sorted() used to be safe.

    Not the only thing that catches it — WHIT-405's chunk-equivalence tests do too. This one
    isolates the PURE planner from the write path, so its failure names the rule rather than a
    drain that happens to disagree."""
    import random
    import repository_category
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(404)
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK

    for trial in range(250):
        original = _random_legacy_store(repository, rng)
        one_shot = repository.plan_color_slot_backfill(copy.deepcopy(original))
        order = repository.color_slot_plan_order(one_shot)[:chunk]
        partial = copy.deepcopy(original)
        for cat_id in order:                                  # persist the first chunk
            partial[cat_id][_SLOT] = Decimal(one_shot[cat_id])
        replanned = repository.plan_color_slot_backfill(partial)

        drained = {cid: one_shot[cid] for cid in order}
        drained.update(replanned)
        assert drained == one_shot, f"trial {trial}: chunked planning diverged from one shot"


# ---- WHIT-404 QA: the adversarial half -----------------------------------------------------
# The tests above cover the RULE (least_held_color_slot as a pure function) and one clean run of
# creates on a pristine store. These cover the rule THROUGH create_category on stores that are
# contended, uneven, mid-drain, or corrupt. Every expected value comes from the real exported
# functions or is read back out of the store — nothing re-derives the rule.

def test_two_creates_racing_on_a_saturated_store_still_land_on_different_slots(handler):
    # [A6] contention past 20 categories. test_two_creates_racing_never_land_on_the_same_slot
    # proves the loser re-reads BELOW saturation, where "is this slot taken" still discriminates.
    # Past 20 every slot is taken, so only the COUNT does.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    for n in range(7):
        repo.create_category(f"x{n}", f"X{n}", "Lifestyle", "tag")   # 20 live: every slot held once
    assert set(_slot_histogram(repo).values()) == {1}, "fixture drifted: store is not saturated"

    def concurrent_create(item):
        item["items"]["beer"] = _cat("beer", "Lifestyle", colorSlot=Decimal(2))
        item["version"] = item["version"] + 1
    repo._table.before_update.append(concurrent_create)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    holders = _slot_histogram(repo)
    assert created["colorSlot"] != 2, "the loser piled onto the slot the winner just doubled"
    assert created["colorSlot"] == 3
    assert holders[2] == 2 and holders[3] == 2
    assert max(holders.values()) == 2       # no slot reached three while another sat on one


def test_a_delete_at_saturation_hands_the_freed_capacity_to_the_next_create(handler):
    # [A7] Below 20 a delete makes a slot FREE and the free branch reuses it (already covered).
    # Past 20 a delete usually only makes a slot LESS HELD — that count has to drop for real, or
    # the ramp stays permanently uneven after any deletion.
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    for n in range(9):
        repo.create_category(f"x{n}", f"X{n}", "Lifestyle", "tag")   # 22 live: slots 2 and 3 doubled
    holders = _slot_histogram(repo)
    assert holders[2] == 2 and holders[3] == 2, "fixture drifted"
    stored = repo._table.store[_CFG]["items"]
    assert int(stored["x7"][_SLOT]) == 2

    repo.delete_category("x7")                       # one of slot 2's two holders
    assert _slot_histogram(repo)[2] == 1

    # The freed capacity, not the next non-seed slot along: 2 is the least-held again.
    assert repo.create_category("wine", "Wine", "Lifestyle", "glass")["colorSlot"] == 2

    repo.delete_category("x1")
    repo.delete_category("x8")                       # both of slot 3's holders
    assert _slot_histogram(repo)[3] == 0
    # Genuinely free again -> the free branch, exactly as below 20 categories.
    assert repo.create_category("beer", "Beer", "Lifestyle", "glass")["colorSlot"] == 3
    assert max(_slot_histogram(repo).values()) == 2


def test_creates_mid_drain_on_a_saturated_store_spread_without_touching_an_owed_slot(handler):
    # [A8] the WHIT-405 chunked drain crossed with saturation. The first three creates land
    # mid-drain: `reserved` covers all 13 built-in slots, so they are squeezed into the seven the
    # ramp has left, every one already held — the only place the hard exclusion and the least-held
    # rule both bind. By the fourth the drain has finished and `reserved` is empty; it spreads on
    # the least-held rule alone, which is worth keeping because it proves a new create walks AWAY
    # from the legacy slot-0 pile-up (slot 0 is held 194 times by then).
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 200)          # 213 rows, none slotted
    repo.list_categories()                           # chunk 1 lands; the rest is still owed

    got = [repo.create_category(f"w{n}", f"W{n}", "Lifestyle", "glass")["colorSlot"]
           for n in range(4)]

    # WHIT-428 dropped an `isdisjoint(SEED_SLOTS)` assertion here. It was WRONG, not merely
    # stale: 10/11/13/15 are built-in hues the create is legitimately DOUBLING UP on, not
    # stealing — under the drain order all 13 built-ins are stamped in chunk 1, so by now
    # nothing is owed to them at all. The theft case it was reaching for needs a store where a
    # built-in's hue is still owed, which is
    # test_a_create_cannot_rob_a_builtin_when_the_spread_backfill_owes_every_slot.
    #
    # These four sit in the all-owed fallback (`reserved` covers every slot). The cap now rides
    # in as `discouraged`, so each create takes the least-held slot NOT over the repaint
    # allowance instead of the lowest over-cap one the fallback used to drop the cap for — so
    # the created row is never one the repaint would immediately evict (WHIT-439). Before the
    # fix this read [2, 8, 13, 15], where 2 and 8 were over the cap.
    assert len(set(got)) == 4, f"four creates mid-drain shared a colour: {got}"
    assert got == [10, 11, 13, 15]

    _drain(repo, limit=30)
    stored = repo._table.store[_CFG]["items"]
    assert all(_SLOT in cat for cat in stored.values()), "a row was left permanently unslotted"
    # The built-ins still land on the hues they were solved for...
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    # ...and no created row was repainted by a later chunk.
    assert [int(stored[f"w{n}"][_SLOT]) for n in range(4)] == got


def test_every_create_takes_a_least_held_slot_however_uneven_the_ramp_is(handler):
    # [A9] the invariant, over randomised create/delete churn. The evenness test above is a
    # straight run on a pristine store where the histogram is flat at every step. DELETES make it
    # uneven, and an uneven ramp is the only thing separating "least-held" from "round-robin".
    # The expected value is read out of the STORE before each create, never re-derived.
    import random
    rng = random.Random(404)
    saturated_creates = 0

    for trial in range(40):
        _, repo = _repo_with_fake_table(handler)
        repo.list_categories()
        made = 0
        for _ in range(50):
            items = repo._table.store[_CFG]["items"]
            if len(items) <= 21 or rng.random() < 0.72:
                before = _slot_histogram(repo)
                made += 1
                slot = int(
                    repo.create_category(f"c{made}", f"C{made}", "Lifestyle", "tag")[_SLOT])
                if min(before.values()) > 0:
                    saturated_creates += 1
                assert before[slot] == min(before.values()), (
                    f"trial {trial}: create took slot {slot} (held {before[slot]} times) while "
                    f"{min(before.values())} was the least-held count")
            else:
                repo.delete_category(rng.choice(sorted(items)))
            # ...and below 20 live categories nothing changed: the colours are still all distinct.
            live = _slot_histogram(repo)
            if sum(live.values()) <= 20:
                assert max(live.values()) == 1, f"trial {trial}: a duplicate under 20 categories"

    # Guard the guard: if the generator stopped reaching saturation this would test nothing.
    assert saturated_creates >= 200, saturated_creates


def test_color_slot_counts_counts_duplicates_and_still_dedupes_to_the_taken_set(handler):
    # [A10] the derivation, and the _coerce_slot boundary (19 in, 20 out) it depends on —
    # that coercion is all that stands between a corrupt row and an undefined colour on the
    # client. A set masquerading as a Counter passes every duplicate-free test in the suite,
    # then silently turns the whole least-held rule back into lowest-free.
    import repository
    items = {
        "lo": _cat("lo", colorSlot=Decimal(0)),
        "lo2": _cat("lo2", colorSlot=Decimal(0)),        # DUPLICATE: counts 2, used still {0}
        "hi": _cat("hi", colorSlot=Decimal(19)),
        "over": _cat("over", colorSlot=Decimal(20)),     # exactly at the limit -> out
        "exp": _cat("exp", colorSlot=Decimal("1E+1")),   # 10, in exponent form
        "ten": _cat("ten", colorSlot=Decimal(10)),       # the same slot by another spelling
        "huge": _cat("huge", colorSlot=Decimal("1E+30")),
        "nan": _cat("nan", colorSlot=Decimal("NaN")),
        "inf": _cat("inf", colorSlot=Decimal("Infinity")),
        "neg": _cat("neg", colorSlot=Decimal(-1)),
        "frac": _cat("frac", colorSlot=Decimal("3.5")),
        "bool": _cat("bool", colorSlot=True),            # bool subclasses int — must read as junk
        "none": _cat("none", colorSlot=None),
        "dict": _cat("dict", colorSlot={"n": 3}),
        "blank": _cat("blank", colorSlot="  "),
        "float": _cat("float", colorSlot=7.0),           # DynamoDB never returns a float
        "absent": _cat("absent"),
    }

    counts = repository.color_slot_counts(items)

    assert counts == Counter({0: 2, 10: 2, 19: 1})
    assert set(counts) == {0, 10, 19}
    assert 5 not in counts and counts[5] == 0 and 5 not in counts   # a read must not INSERT
    # The real consumer agrees: the planner treats exactly those three as taken.
    plan = repository.plan_color_slot_backfill(items)
    assert len(plan) == 12
    assert set(plan.values()).isdisjoint({0, 10, 19})


def test_a_legacy_store_of_thirty_categories_spreads_its_repeats(handler):
    # [A11] WHIT-428 closed the scope gap WHIT-404 recorded here, and this is where that
    # decision is written down. WHIT-404 spread repeats on the CREATE path only; the backfill
    # kept a constant slot-0 overflow, because WHIT-405's chunked drain was equivalent to one
    # unchunked write ONLY while that overflow was constant. So a store MIGRATING with 30
    # categories used to land 11 of them on Eating Out's colour — permanently, since a slot is
    # never recomputed. Teaching pass 2 the least-held rule needed the drain order to change
    # too (see color_slot_plan_order); with both, the same store now lands 2 per colour.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 17)           # 13 built-ins + 17 custom = 30, none slotted

    _drain(repo)

    holders = _slot_histogram(repo)
    assert sum(holders.values()) == 30
    assert holders[0] == 2, "Eating Out's colour is piled again — did the overflow stop moving?"
    assert sorted(holders.values()) == [1] * 10 + [2] * 10
    assert max(holders.values()) == 2
    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS


def test_a_create_may_never_take_a_free_slot_a_builtin_is_owed_even_when_all_are_owed(handler):
    # [A12] the fallback branch, END TO END. The unit test pins the branch's return value; this
    # pins what it costs the user. When the plan owes all 20 slots `candidates` is empty, and if
    # that fallback reaches the FREE branch it hands out a slot that is free only because the
    # backfill has not written it yet — the exact theft `reserved` exists to stop.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: {k: v for k, v in seed.items() if k != _SLOT}
             for cid, seed in repository.SEED_CATEGORIES.items()}
    items["zsquatter"] = _cat("zsquatter", colorSlot=Decimal(0))
    for n in range(21):
        items[f"cat{n:04d}"] = _cat(f"cat{n:04d}")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": items, "version": Decimal(1)}
    owed = repository.plan_color_slot_backfill(items)
    assert set(owed.values()) == set(range(20)), "fixture drifted: not every slot is owed"
    assert owed["travel"] == 1
    repo._table.before_update.append(_bump_version)   # the pre-loop backfill loses its race

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] != owed["travel"], "create stole the slot the backfill owed travel"
    _drain(repo, limit=30)
    stored = repo._table.store[_CFG]["items"]
    assert int(stored["travel"][_SLOT]) == 1, "travel was repainted off its designated hue"
    assert all(_SLOT in cat for cat in stored.values())


def test_a_create_cannot_rob_a_builtin_when_the_spread_backfill_owes_every_slot(handler):
    # WHIT-428 — the fail-on-revert guard for `protected`. Once the backfill SPREADS, a
    # saturated store's plan owes all 20 slots for real (before, the overflow was the single
    # constant 0), so `candidates` is empty and the fallback runs — and that branch ignores
    # `reserved` by design. Without `protected` it picks the lowest zero-count slot, which is
    # eatingout's 0, and Eating Out is pushed onto 7 where it collides with Gifts. Permanently:
    # pass 1 only entitles a built-in while its slot is free.
    #
    # The fixture is the shape that exposes it: every built-in unslotted, a squatter already on
    # each of the seven non-built-in slots (so the seed slots have ZERO stored holders and win
    # the least-held tie-break), and enough custom rows to saturate.
    repository, repo = _repo_with_fake_table(handler)
    import repository_category
    items = {cid: {k: v for k, v in seed.items() if k != _SLOT}
             for cid, seed in repository.SEED_CATEGORIES.items()}
    non_seed = sorted(set(range(20)) - set(SEED_SLOTS.values()))
    assert len(non_seed) == 7
    for n, slot in enumerate(non_seed):
        items[f"squat{n}"] = _cat(f"squat{n}", colorSlot=Decimal(slot))
    for n in range(30):
        items[f"cat{n:04d}"] = _cat(f"cat{n:04d}")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                               "items": items, "version": Decimal(1)}
    owed = repository.plan_color_slot_backfill(items)
    assert set(owed.values()) == set(range(20)), "fixture drifted: not every slot is owed"
    protected = repository_category._designated_builtin_slots(owed)
    assert protected == frozenset(SEED_SLOTS.values()), "every built-in should be owed its hue"
    repo._table.before_update.append(_bump_version)   # the pre-loop backfill loses its race

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] not in protected, \
        "create robbed a built-in of its designated hue from the all-owed fallback"
    _drain(repo, limit=30)
    stored = repo._table.store[_CFG]["items"]
    # The whole solved table survives — not just the one the create happened to aim at.
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    assert all(_SLOT in cat for cat in stored.values())


def test_the_backfill_plan_is_ordered_pass_one_first_so_a_chunk_cannot_rob_a_builtin(handler):
    # WHIT-428 — the pin on the load-bearing but invisible contract. `_write_color_slots` takes
    # its chunk as a prefix of color_slot_plan_order, which is just the plan's build order; a
    # stray sorted() in a future refactor would silently re-open the divergence with no obvious
    # symptom (colours would just be slightly wrong on legacy stores). Assert the order at the
    # planner end AND that the real write used it, so a break is caught at both ends.
    repository, repo = _repo_with_fake_table(handler)
    early = {f"aaa{index:04d}": {"id": f"aaa{index:04d}", "name": "A", "icon": "tag",
                                 "color": "#888888", "bucket": "Lifestyle", "parent": None}
             for index in range(60)}
    _legacy_store(repo, repository, extra=early)      # seed ids all sort AFTER the aaa rows
    items = repo._table.store[_CFG]["items"]
    plan = repository.plan_color_slot_backfill(items)

    order = repository.color_slot_plan_order(plan)
    entitled = [cid for cid, slot in plan.items()
                if repository.SEED_CATEGORIES.get(cid, {}).get(_SLOT) == slot]
    assert order[:len(entitled)] == sorted(entitled), "pass-1 rows are no longer emitted first"
    assert order[len(entitled):] == sorted(order[len(entitled):]), "pass 2 is not alphabetical"
    assert order != sorted(order), "fixture drifted: the order is indistinguishable from sorted"

    repo.list_categories()                            # one chunk lands
    names = repo._table.update_calls[-1][1]            # (expression, names, values)
    written = [names[f"#cat{index}"] for index in range(len(names)) if f"#cat{index}" in names]
    assert written == order[:50], "the write did not use the drain order"


# ---- WHIT-428: the one-off repaint of already-migrated, piled stores ------------------------
# PART 1 above stops FUTURE migrations piling. These cover the second half: stores that already
# migrated under the old constant slot-0 overflow are levelled once, behind a schema-2 marker,
# then never again. Every expected value comes from the real exported planners or is read back
# out of the store — nothing re-derives the rule.


def test_a_store_that_already_migrated_onto_one_shared_slot_is_repainted_level(handler):
    # The card's own example, from the other side: this store already finished its migration
    # under the old rule, so PART 1 alone plans NOTHING for it — every row holds a valid slot.
    # 30 rows, allowance = ceil(30/20) = 2.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 17)               # 13 built-ins + 17 all on slot 0
    before = _slot_histogram(repo)
    assert before[0] == 18, "fixture drifted: the store is not piled"
    assert repository.plan_color_slot_backfill(repo._table.store[_CFG]["items"]) == {}

    _drain(repo)

    holders = _slot_histogram(repo)
    assert sum(holders.values()) == 30
    assert max(holders.values()) == 2
    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_an_already_level_store_is_stamped_without_repainting_anything(handler):
    # The population that must cost as little as possible: schema 1, already level. One
    # marker-only write, no colour touched, then silent forever. This is also the
    # fail-on-revert guard for the schema bump — revert _COLOR_SLOT_SCHEMA to 1 and the
    # marker-only write never happens, so `writes` is 0 and this reddens.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 0)                # 13 built-ins, each on its own hue
    before = {cid: int(cat[_SLOT]) for cid, cat in repo._table.store[_CFG]["items"].items()}

    writes = _drain(repo)

    assert writes == 1
    expression, names, values = repo._table.update_calls[-1]
    assert set(names) == {"#v", "#schema"}, "an already-level store rewrote a colour"
    assert values[":schema"] == _schema()
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before


def test_a_repaint_never_moves_the_sole_holder_of_a_colour(handler):
    # The permanence promise: a colour worn by ONE category is never a mover. The guard is on
    # the `holders[allowance:]` boundary in _repaint_movers — make it `allowance - 1` and this
    # reddens. (It is NOT a guard on the allowance arithmetic: ceil(n/20) is already >= 1 for
    # every non-empty store, so there is nothing there to get wrong.)
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}
    assert repository.plan_color_slot_repaint(items) == {}
    before = {cid: int(cat[_SLOT]) for cid, cat in items.items()}

    _drain(repo)

    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before


def test_a_built_in_on_its_designated_slot_is_never_the_row_that_moves(handler):
    # Keeper priority. eatingout shares slot 0 with custom rows that sort BEFORE it
    # alphabetically, so plain alphabetical order would evict the built-in. Its designation
    # must win instead — a built-in never loses the hue it was solved for.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(20):
        cat_id = f"aaa{index:04d}"                   # sorts before "eatingout"
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(0))
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}
    plan = repository.plan_color_slot_repaint(items)
    assert "eatingout" not in plan, "the repaint evicted a built-in from its designated hue"

    _drain(repo)

    stored = repo._table.store[_CFG]["items"]
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS


def test_a_repaint_moves_the_theoretical_minimum_number_of_rows(handler):
    # Minimal churn, tested rather than commented. Every moved colour is a colour some user
    # watched change, so "only the rows above the allowance move" has to be enforced: a full
    # re-plan would move ~24% more, including rows a POST already told the client about.
    import random
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(428)
    checked = 0

    for _ in range(120):
        items = {}
        for index in range(rng.randint(1, 90)):
            cat_id = f"cat{index:04d}"
            items[cat_id] = _cat(cat_id, colorSlot=Decimal(rng.randrange(20)))
        allowance = max(1, -(-len(items) // 20))
        counts = Counter(int(cat[_SLOT]) for cat in items.values())
        minimum = sum(max(0, held - allowance) for held in counts.values())
        assert len(repository.plan_color_slot_repaint(items)) == minimum
        checked += minimum > 0

    assert checked >= 40, f"the generator stopped producing piled stores: {checked}"


def test_a_chunked_repaint_lands_exactly_where_one_unchunked_write_would_have(handler):
    # The repaint's own [A1]. The allowance depends ONLY on how many rows the store has, never
    # on where they sit, so persisting a prefix leaves the re-plan looking at the same number —
    # which is what makes the chunked repaint equivalent to one unchunked write. Verified over
    # randomised piled stores, with the write count bounded by the number of chunks.
    import random
    import repository_category
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(_PROPERTY_SEED + 2)
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK
    saw_multi_chunk = 0

    for trial in range(120):
        _, repo = _repo_with_fake_table(handler)
        items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
        for index in range(rng.randint(30, 200)):
            cat_id = f"cat{index:04d}"
            items[cat_id] = _cat(cat_id, colorSlot=Decimal(rng.choice([0, 0, 0, 1, 2])))
        repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES",
                                   "items": copy.deepcopy(items), "version": Decimal(1),
                                   "colorSlotSchema": Decimal(1)}
        one_shot = repository.plan_color_slot_repaint(copy.deepcopy(items))
        expected = {cid: int(one_shot[cid]) if cid in one_shot else int(cat[_SLOT])
                    for cid, cat in items.items()}
        if len(one_shot) > chunk:
            saw_multi_chunk += 1

        writes = _drain(repo, limit=40)

        stored = repo._table.store[_CFG]["items"]
        assert {cid: int(cat[_SLOT]) for cid, cat in stored.items()} == expected, \
            f"trial {trial}: chunked repaint diverged from one shot"
        assert writes == max(1, -(-len(one_shot) // chunk)), f"trial {trial}: {writes} writes"

    assert saw_multi_chunk >= 20, saw_multi_chunk


def test_the_repaint_planner_is_a_fixed_point_on_its_own_drain_order(handler):
    # The repaint's [A2], isolating the PURE planner from the write path so a failure names the
    # rule rather than a drain that happens to disagree. Same shape as the backfill's.
    import random
    import repository_category
    repository, _ = _repo_with_fake_table(handler)
    rng = random.Random(_PROPERTY_SEED + 3)
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK

    for trial in range(150):
        items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
        for index in range(rng.randint(30, 150)):
            cat_id = f"cat{index:04d}"
            items[cat_id] = _cat(cat_id, colorSlot=Decimal(rng.choice([0, 0, 1, 2, 3])))
        one_shot = repository.plan_color_slot_repaint(copy.deepcopy(items))
        order = repository.color_slot_plan_order(one_shot)[:chunk]
        partial = copy.deepcopy(items)
        for cat_id in order:
            partial[cat_id][_SLOT] = Decimal(one_shot[cat_id])

        # Guard the guard: an empty plan compares {} to {} and would pass forever.
        assert one_shot, f"trial {trial}: fixture drifted, nothing to repaint"

        replanned = repository.plan_color_slot_repaint(partial)
        drained = {cid: one_shot[cid] for cid in order}
        drained.update(replanned)
        assert drained == one_shot, f"trial {trial}: chunked repaint planning diverged"


def test_repainting_a_store_twice_changes_nothing(handler):
    # Safe to run twice — but the teeth are in WHAT it settled on, not just that it stopped:
    # a repaint stubbed out to do nothing would also "settle" and never write again.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    _drain(repo)
    settled = {cid: int(cat[_SLOT]) for cid, cat in repo._table.store[_CFG]["items"].items()}
    holders = _slot_histogram(repo)
    assert max(holders.values()) <= -(-sum(holders.values()) // 20), "settled while still piled"
    repo._table.update_calls.clear()

    repo.list_categories()
    repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == settled


def test_a_store_already_at_schema_two_is_never_repainted_even_when_piled(handler):
    # "At most once" — the fail-on-revert guard for the marker actually gating stage 2. A store
    # stamped schema 2 that is nonetheless piled (however it got that way) must be left alone:
    # a colour the user has been shown does not change twice.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40, schema=2)
    items = repo._table.store[_CFG]["items"]
    assert repository.plan_color_slot_repaint(items) != {}, "fixture drifted: not piled"
    before = {cid: int(cat[_SLOT]) for cid, cat in items.items()}

    repo.list_categories()
    repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before


def test_a_delete_that_lowers_the_allowance_does_not_reopen_a_settled_store(handler):
    # This is what separates "the rule genuinely converges" from "the marker is quietly
    # carrying the whole thing". 41 rows -> allowance 3; delete one -> 40 rows -> allowance 2,
    # so the PLANNER would now find movers. The settled store must still do nothing.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 28)               # 13 + 28 = 41 rows
    _drain(repo)
    assert max(_slot_histogram(repo).values()) == 3

    # Delete a row that is NOT on the crowded slot, so that slot still holds 3 while the
    # allowance drops to 2 — otherwise the delete itself levels the store and proves nothing.
    stored = repo._table.store[_CFG]["items"]
    crowded = _slot_histogram(repo).most_common(1)[0][0]
    victim = next(cid for cid, cat in stored.items()
                  if int(cat[_SLOT]) != crowded and cid not in SEED_SLOTS)
    repo.delete_category(victim)
    items = repo._table.store[_CFG]["items"]
    assert len(items) == 40
    assert repository.plan_color_slot_repaint(items) != {}, "the allowance did not drop"
    before = {cid: int(cat[_SLOT]) for cid, cat in items.items()}
    repo._table.update_calls.clear()

    repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before


def test_a_repaint_in_progress_shows_the_same_colours_on_every_read(handler):
    # The narrowed promise, pinned on the STABLE case: with no create or delete interleaved, a
    # user reloading mid-repaint sees an identical colour map every time. (An interleaved write
    # DOES shift not-yet-written rows — accepted deliberately, documented on `colorSlot`.)
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 140)
    views = []

    for _ in range(20):
        before = len(repo._table.update_calls)
        views.append({row["id"]: row[_SLOT] for row in repo.list_categories()})
        if len(repo._table.update_calls) == before:
            break
    else:
        raise AssertionError("the repaint did not converge")

    assert len(views) > 2, "fixture drifted: the repaint finished in a single write"
    assert all(view == views[0] for view in views), \
        "a colour previewed mid-repaint changed with nothing else touching the store"


def test_no_row_written_by_one_repaint_chunk_is_ever_rewritten(handler):
    # The other half: storage never moves a row twice, even when a create and a delete land
    # between chunks. A colour that has actually been SAVED is permanent.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 140)
    original = {cid: int(cat[_SLOT])
                for cid, cat in repo._table.store[_CFG]["items"].items()}
    # A row is "written by the repaint" once its stored slot differs from the piled value it
    # started on. From that moment its colour is saved, and must never change again.
    moved = {}

    for step in range(20):
        before = len(repo._table.update_calls)
        repo.list_categories()
        stored = repo._table.store[_CFG]["items"]
        for cat_id, cat in stored.items():
            slot = int(cat[_SLOT])
            if original.get(cat_id) is not None and slot != original[cat_id]:
                assert moved.setdefault(cat_id, slot) == slot, \
                    f"{cat_id} was rewritten from {moved[cat_id]} to {slot}"
        if len(repo._table.update_calls) == before:
            break
        if step == 0:
            repo.create_category("wine", "Wine", "Lifestyle", "glass")
        if step == 1:
            repo.delete_category("cat0001")

    assert moved, "fixture drifted: the repaint never moved anything"


def test_a_repaint_expression_never_exceeds_dynamodbs_4kb_limit(handler):
    # The repaint reuses the backfill's write shape, so FakeTable's 4KB guard applies to it
    # too — but nothing exercised it through a repaint plan until now.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 200)

    _drain(repo, limit=40)

    biggest = max(len(call[0].encode()) for call in repo._table.update_calls)
    # Guard the guard: a marker-only write is ~60 bytes and would pass this trivially. A full
    # 50-clause chunk is what has to fit, so require the fixture actually produced one.
    assert biggest > 1000, f"fixture drifted: the biggest write was only {biggest} bytes"
    assert biggest < 4096 // 2, f"a repaint write reached {biggest} bytes"


def test_a_store_needing_both_a_backfill_and_a_repaint_is_not_stamped_until_both_land(handler):
    # The `settled` flag. A store with an unslotted row AND a pre-existing pile needs both
    # stages; stamping on the backfill's last chunk would strand the repaint's row on a shared
    # colour permanently. Drop `settled` from `drained` and this reddens.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(24):                          # piled onto eatingout's hue
        cat_id = f"cat{index:04d}"
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(0))
    items["zzznew"] = _cat("zzznew")                 # ...and one row with no slot at all
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}
    assert repository.plan_color_slot_backfill(items) != {}

    repo.list_categories()                           # the backfill stage lands, alone
    config = repo._table.store[_CFG]
    assert repository.plan_color_slot_backfill(config["items"]) == {}, "backfill did not finish"
    assert repository.plan_color_slot_repaint(config["items"]) != {}, "fixture is not piled"
    assert "colorSlotSchema" not in config or config["colorSlotSchema"] != _schema(), \
        "stamped while the repaint was still owed"

    _drain(repo)

    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    assert max(_slot_histogram(repo).values()) <= 2


def test_a_create_mid_backfill_keeps_its_slot_once_the_repaint_has_also_run(handler):
    # WHIT-428's create-path cap, END TO END — the bug the plan critic found. Mid-backfill the
    # stored counts cover only the rows already stamped, while the repaint's allowance is
    # computed from the WHOLE store. Without the cap the create picks a slot the backfill then
    # piles past the allowance, and the repaint evicts the freshly created row — repainting a
    # colour the POST had already told the client about. 69 unslotted + 5 already on slot 2,
    # and an id that sorts after them so it is the lowest-priority keeper. Without the cap the
    # POST returns slot 2 and the store settles it on 0; with it, POST and storage agree.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(5):
        cat_id = f"crowd{index}"
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(2))
    for index in range(69):
        cat_id = f"cat{index:04d}"
        items[cat_id] = _cat(cat_id)                 # unslotted
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1)}

    created = repo.create_category("zwine", "Wine", "Lifestyle", "glass")
    _drain(repo, limit=40)

    stored = repo._table.store[_CFG]["items"]
    assert int(stored["zwine"][_SLOT]) == created[_SLOT], \
        "the repaint evicted the row POST had already given a colour"
    assert {cid: int(stored[cid][_SLOT]) for cid in SEED_SLOTS} == SEED_SLOTS
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_a_create_is_never_repainted_whenever_it_lands_in_the_migration(handler):
    # The property behind the test above: wherever a create lands — before the drain, between
    # chunks, or after the marker — the slot the POST returned is the slot that ends up stored.
    repository, _ = _repo_with_fake_table(handler)

    for reads_before in range(4):
        _, repo = _repo_with_fake_table(handler)
        items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
        for index in range(6):
            items[f"crowd{index}"] = _cat(f"crowd{index}", colorSlot=Decimal(3))
        for index in range(90):
            items[f"cat{index:04d}"] = _cat(f"cat{index:04d}")
        repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                                   "version": Decimal(1)}
        for _ in range(reads_before):
            repo.list_categories()

        created = repo.create_category("zwine", "Wine", "Lifestyle", "glass")
        _drain(repo, limit=40)

        stored = repo._table.store[_CFG]["items"]
        assert int(stored["zwine"][_SLOT]) == created[_SLOT], \
            f"created row repainted when the create landed after {reads_before} reads"


def test_the_repaint_keys_on_the_map_key_not_the_inner_id(handler):
    # The rest of the module keys on the MAP KEY; a row whose inner "id" disagrees must be
    # planned, moved and returned under the map key, or it is stamped in the DB under one name
    # and returned under another.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(5):
        key = f"k{index:02d}"
        items[key] = {"id": f"zzz{4 - index}", "name": "X", "icon": "tag", "color": "#888888",
                      "bucket": "Lifestyle", "parent": None, _SLOT: Decimal(2)}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    plan = repository.plan_color_slot_repaint(items)

    assert set(plan) <= {f"k{index:02d}" for index in range(5)}
    assert "k00" not in plan, "the keeper was chosen by the inner id, not the map key"


def test_a_versionless_store_previews_the_repaint_without_ever_writing(handler):
    # No version means no optimistic lock to condition on, so the write is skipped — but the
    # read must still be correct and must never raise. The levelled colours are shown from the
    # plan; storage is untouched.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40)
    del repo._table.store[_CFG]["version"]
    before = {cid: int(cat[_SLOT]) for cid, cat in repo._table.store[_CFG]["items"].items()}

    rows = repo.list_categories()
    repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before
    assert max(Counter(row[_SLOT] for row in rows).values()) <= 3


def test_a_repaint_survives_every_built_in_sitting_on_another_built_ins_slot(handler):
    # The only shape where the designation and alphabetical tie-breaks disagree: rotate the
    # seed table by one, so every built-in holds some OTHER built-in's designated hue and none
    # of them can claim keeper priority. No committed fixture produces this.
    repository, repo = _repo_with_fake_table(handler)
    designated = [SEED_SLOTS[cid] for cid in SEED_SLOTS]
    rotated = designated[1:] + designated[:1]
    items = {}
    for cat_id, slot in zip(SEED_SLOTS, rotated):
        items[cat_id] = {**repository.SEED_CATEGORIES[cat_id], _SLOT: Decimal(slot)}
    for index in range(30):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(rotated[0]))
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    _drain(repo, limit=40)

    holders = _slot_histogram(repo)
    assert max(holders.values()) <= max(1, -(-sum(holders.values()) // 20))
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_an_empty_and_a_single_row_store_settle_in_one_write(handler):
    # Edge states. An empty store is the "every category deleted" case the marker exists for;
    # a single row has allowance 1 and must not be touched.
    repository, repo = _repo_with_fake_table(handler)
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": {},
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    assert _drain(repo) == 1
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    assert repo.list_categories() == []

    _, repo = _repo_with_fake_table(handler)
    only = {"solo": _cat("solo", colorSlot=Decimal(4))}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": only,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    assert _drain(repo) == 1
    assert int(repo._table.store[_CFG]["items"]["solo"][_SLOT]) == 4


def test_the_planners_never_mutate_the_store_they_are_given(handler):
    # The planners are projections, not applications — list_categories holds these same row
    # objects and reads them again to build the response, so a planner writing through them
    # would hand the client colours the store does not hold. Also pins that planning twice on
    # the same input gives the same answer, which the chunked drain relies on.
    repository, repo = _repo_with_fake_table(handler)
    items = {cid: dict(cat) for cid, cat in repository.SEED_CATEGORIES.items()}
    for index in range(24):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    items["zzznew"] = _cat("zzznew")                 # unslotted: forces the backfill stage
    before = copy.deepcopy(items)

    first = repository.plan_color_slot_stage(items, repainted=False)
    second = repository.plan_color_slot_stage(items, repainted=False)

    assert items == before, "a planner mutated the store it was handed"
    assert first == second, "planning twice on the same store gave two answers"
    assert repository.plan_new_category_slot(items) == repository.plan_new_category_slot(items)
    assert items == before, "plan_new_category_slot mutated the store it was handed"


def test_a_versionless_store_mid_backfill_previews_without_writing(handler):
    # The read must stay correct and must never raise when there is no version to condition on
    # — and storage must be untouched, including by the planners themselves.
    repository, repo = _repo_with_fake_table(handler)
    _unslotted_store(repo, repository, 40)
    del repo._table.store[_CFG]["version"]
    before = copy.deepcopy(repo._table.store[_CFG]["items"])

    rows = repo.list_categories()
    repo.list_categories()

    assert repo._table.update_calls == []
    assert repo._table.store[_CFG]["items"] == before
    assert all(0 <= row[_SLOT] < 20 for row in rows), "a preview handed out an unusable slot"


def test_editing_a_category_mid_migration_echoes_the_colour_the_list_shows(handler):
    # PATCH used to echo the row's STORED slot while GET returned the previewed one, so
    # mid-migration an edit made the category's chart colour visibly flip back to its old
    # value until the next refetch (the client writes the PATCH response straight into its
    # cached list). Both answers now come from the same planner. Echo the stored value again
    # and this reddens.
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 140)              # 153 rows: the repaint needs 3 chunks
    repo.list_categories()                           # chunk 1 lands; the rest is still owed
    listed = {row["id"]: row[_SLOT] for row in repo.list_categories()}
    # Pick the victim AFTER the last read: each read lands another chunk, so a row chosen
    # earlier may already have been written — and then its stored slot equals its previewed
    # one and the assertion below passes whatever PATCH echoes. Assert the gap explicitly.
    items = repo._table.store[_CFG]["items"]
    pending = repository.plan_color_slot_repaint(items)
    victim = next(cid for cid in pending
                  if cid.startswith("cat") and pending[cid] != int(items[cid][_SLOT]))
    assert listed[victim] != int(items[victim][_SLOT]), \
        "fixture drifted: this row's stored colour already equals its previewed one"

    edited = repo.update_category(victim, "Renamed", "Living", "tag")

    assert edited[_SLOT] == listed[victim], "PATCH echoed a colour the list does not show"
    assert type(edited[_SLOT]) is int, "PATCH must carry a plain int, like GET and POST"

    _drain(repo, limit=40)
    assert int(repo._table.store[_CFG]["items"][victim][_SLOT]) == edited[_SLOT], \
        "the colour PATCH echoed is not the one that settled"


# ======================================================================================
# Folded from test_categories_reservation_properties.py (WHIT-462) — WHIT-427/429/439: colorSlot reservation invariants. Bodies verbatim.
# ======================================================================================

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


# ======================================================================================
# Folded from test_categories_whit427_gaps.py (WHIT-462) — WHIT-427/439: _backfill_expression shape + SlotPreference. Bodies verbatim.
# ======================================================================================

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


# ======================================================================================
# Folded from test_categories_whit428_gaps.py (WHIT-462) — WHIT-428 (round 1): repaint write-policy / chunking. Bodies verbatim.
# ======================================================================================

class _NetworkError(Exception):
    """A BotoCoreError stand-in: a connect/read timeout is NOT a ClientError, so it takes
    _write_color_slots' bare `except Exception` arm."""


def _only_the_migration_write_fails(repo, error):
    """Make ONLY the colour-slot write fail, leaving create/update/delete healthy.

    Setting FakeTable.update_error makes EVERY write fail, so create's own conditional write
    would raise the same exception and a test could not tell which call site propagated it.
    Routed on the ABSENCE of #id — the same discriminator FakeTable itself uses to recognise
    the migration's write shape."""
    real = repo._table.update_item

    def _update_item(**kwargs):
        if "#id" not in kwargs["ExpressionAttributeNames"]:
            raise error
        return real(**kwargs)

    repo._table.update_item = _update_item


def _levelled(repo) -> bool:
    """Is every colour worn by no more categories than the ramp forces? Spelled out here
    rather than imported: a helper that called _repaint_allowance would agree with a broken
    allowance and prove nothing."""
    holders = _slot_histogram(repo)
    rows = sum(holders.values())
    return max(holders.values()) <= max(1, -(-rows // 20))


# --- [A1]-[A4], [A14] the write policy, driven through a REPAINT chunk --------


def test_a_read_fails_open_when_the_repaint_chunk_is_throttled(handler):
    """WHIT-428 — [A1] a throttled REPAINT must not 500 the seven read routes.

    The impl suite proves this for the BACKFILL. The repaint is a second call site with a
    different plan and settled=True; nothing drove a throttle through it. Flip the
    strict=False argument in list_categories and this reddens.
    """
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40)               # 53 rows, all customs on slot 0
    before = {cid: int(cat[_SLOT])
              for cid, cat in repo._table.store[_CFG]["items"].items()}
    repo._table.update_error = _throttle()

    rows = repo.list_categories()                    # must not raise

    # The response is still the LEVELLED preview, computed in memory from the plan.
    assert max(Counter(row[_SLOT] for row in rows).values()) <= 3
    assert len(rows) == 53
    # Nothing landed and the marker is untouched, so a later read retries the whole thing.
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1

    repo._table.update_error = None
    _drain(repo, limit=40)
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_a_read_fails_open_when_the_repaint_chunk_hits_a_network_error(handler):
    """WHIT-428 — [A2] a timeout is not a ClientError. Through a repaint plan it must still
    be swallowed on the read path, or /breakdown, /budgets, /insights and the webhook's
    budget-alert path all 500 on a store that has simply not finished levelling."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40)
    repo._table.update_error = _NetworkError("connection reset by peer")

    rows = repo.list_categories()                    # must not raise

    assert len(rows) == 53
    assert all(isinstance(row[_SLOT], int) and 0 <= row[_SLOT] < 20 for row in rows)
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1


def test_a_create_fails_closed_on_a_network_error_in_the_repaint_chunk(handler):
    """WHIT-428 — [A3] the opposite policy, on the branch NOTHING covers today.

    test_create_fails_closed_when_the_backfill_write_errors drives a ClientError, which exits
    via handle_database_error. The bare `except Exception: if strict: raise` is the only path
    a timeout takes on a write, and it had no test. Swap that `raise` for a `pass` and the
    POST silently reports a colour it never stored; this reddens.
    """
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40)
    # ONLY the repaint chunk fails: if create's own write failed too, the exception would
    # propagate from there and the test would pass however _write_color_slots behaved.
    _only_the_migration_write_fails(repo, _NetworkError("connection reset by peer"))

    with pytest.raises(_NetworkError):
        repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert "wine" not in repo._table.store[_CFG]["items"], \
        "the create landed on top of a migration write that never happened"
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1


def test_a_version_race_inside_a_repaint_chunk_writes_nothing_and_recovers(handler):
    """WHIT-428 — [A4] a concurrent writer bumps the version between the repaint's read and
    its conditional write. The chunk must be a no-op success (not a 409 on a GET), leave every
    stored colour alone, leave the marker unstamped, and be picked up by the next read."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    before = {cid: int(cat[_SLOT])
              for cid, cat in repo._table.store[_CFG]["items"].items()}
    # A concurrent writer lands between our get_item and our update_item.
    repo._table.before_update.append(
        lambda item: item.__setitem__("version", item["version"] + Decimal(1)))

    rows = repo.list_categories()                    # must not raise, must not 409

    assert len(rows) == 73
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1

    _drain(repo, limit=40)
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_two_readers_racing_one_repaint_chunk_agree_on_every_colour(handler):
    """WHIT-428 — [A14] two Lambda invocations read the same store, both plan the repaint, one
    write wins. The loser must return the SAME colour map — the planner is pure, so losing the
    race costs nothing — and must not raise."""
    repository, repo_a = _repo_with_fake_table(handler)
    _piled_store(repo_a, repository, 60)
    repo_b = repository.CategoryRepository()
    repo_b._table = repo_a._table                    # same table, second invocation
    seen = {}

    # B does a whole read (and lands its own chunk) between A's read and A's write.
    def _b_goes_first(_item):
        seen["b"] = {row["id"]: row[_SLOT] for row in repo_b.list_categories()}

    repo_a._table.before_update.append(_b_goes_first)

    seen["a"] = {row["id"]: row[_SLOT] for row in repo_a.list_categories()}

    assert seen["a"] == seen["b"], "two concurrent readers disagreed about a colour"
    # A lost the version race, so exactly ONE chunk landed: B's.
    assert len(repo_a._table.update_calls) == 2      # A's rejected attempt + B's write
    assert repo_a._table.store[_CFG]["version"] == 2


# --- [A5]-[A6] marker semantics ----------------------------------------------


def test_a_store_stamped_beyond_schema_two_is_left_completely_alone(handler):
    """WHIT-428 — [A5] _is_slot_migrated compares `>=`, so a store a FUTURE migration already
    stamped 3 must not be dragged back through this one. Change that `>=` to `==` and a piled
    schema-3 store repaints and re-stamps itself down to 2, which is how a two-way version
    flap between deploys starts."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 40, schema=3)
    before = {cid: int(cat[_SLOT])
              for cid, cat in repo._table.store[_CFG]["items"].items()}

    for _ in range(3):
        repo.list_categories()

    assert repo._table.update_calls == []
    assert {cid: int(cat[_SLOT])
            for cid, cat in repo._table.store[_CFG]["items"].items()} == before
    assert repo._table.store[_CFG]["colorSlotSchema"] == 3


def test_write_color_slots_refuses_to_be_called_without_settled(handler):
    """WHIT-428 — [A6] `settled` is keyword-only with NO default, on purpose: a call site that
    forgets it would stamp schema 2 early and strand the repaint's rows on a shared colour
    FOREVER — a silent permanent bug rather than a loud one. Give it a default and this
    reddens."""
    import repository_category

    parameter = inspect.signature(
        repository_category.CategoryRepository._write_color_slots).parameters["settled"]

    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty
    with pytest.raises(TypeError):
        repository_category.CategoryRepository()._write_color_slots(
            Decimal(1), {}, strict=False)


# --- [A7]-[A8] the repaint's own chunk / expression boundaries ---------------


@pytest.mark.parametrize("piled, movers, writes", [(53, 50, 1), (54, 51, 2)])
def test_a_repaint_of_exactly_one_chunk_settles_in_one_write(handler, piled, movers, writes):
    """WHIT-428 — [A7] the repaint's chunk boundary, both sides. Exactly
    _COLOR_SLOT_WRITE_CHUNK movers must drain AND stamp in a single write; one more must take
    two, with the marker withheld until the second. An off-by-one in `drained`, or a change to
    the chunk cap, moves one of these two."""
    repository, repo = _repo_with_fake_table(handler)
    import repository_category
    _piled_store(repo, repository, piled)
    assert repository_category._COLOR_SLOT_WRITE_CHUNK == 50, "fixture drifted with the cap"
    plan = repository.plan_color_slot_repaint(repo._table.store[_CFG]["items"])
    assert len(plan) == movers, "fixture drifted: wrong number of movers"

    repo.list_categories()
    first_write_stamped = repo._table.store[_CFG]["colorSlotSchema"] == _schema()

    assert first_write_stamped is (writes == 1)
    assert _drain(repo, limit=10) == writes
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    assert _levelled(repo)


@pytest.mark.parametrize("clauses, fits", [(129, True), (130, False)])
def test_the_documented_4kb_clause_boundary_is_exactly_where_the_comment_says(
    handler, monkeypatch, clauses, fits
):
    """WHIT-428 — [A8] _COLOR_SLOT_WRITE_CHUNK's comment claims 129 clauses (4070 bytes) is the
    last that fits and 130 (4103) is rejected. The repaint now rides the SAME write shape, so
    that arithmetic guards two migrations, not one — and nothing checked it. Raise the chunk
    to the claimed ceiling and the write must still land; one past it and the real service
    (and FakeTable) reject the expression, which on a read is swallowed and leaves the store
    unstamped forever.

    Note the numbers only hold WITH the marker clause in the same write, so the plan is sized
    to drain in one. A partial chunk is 33 bytes smaller.
    """
    repository, repo = _repo_with_fake_table(handler)
    import repository_category
    monkeypatch.setattr(repository_category, "_COLOR_SLOT_WRITE_CHUNK", clauses)
    items = {f"cat{index:04d}": _cat(f"cat{index:04d}") for index in range(clauses)}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1)}

    repo.list_categories()                           # fail-open: never raises either way

    expression = repo._table.update_calls[0][0]
    assert "#schema" in expression, "sized wrong: the marker clause must be in the write"
    assert len(expression.encode()) == (4070 if fits else 4103)
    assert (len(expression.encode()) <= _MAX_UPDATE_EXPRESSION_BYTES) is fits
    stamped = repo._table.store[_CFG].get("colorSlotSchema") == _schema()
    assert stamped is fits, "an over-4KB write appeared to succeed"


# --- [A9]-[A10] preview leaks ------------------------------------------------


def test_the_backfill_stage_comes_first_and_cannot_stamp_while_a_repaint_follows(handler):
    """WHIT-428 — [A9] stage ordering on a store that needs BOTH: the plan handed back must be
    the backfill's, and it must carry settled=False so the marker waits for the repaint.

    (Purity of the planners is pinned by the impl suite's
    test_the_planners_never_mutate_the_store_they_are_given, which covers plan_new_category_slot
    too — not repeated here.)"""
    import repository

    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    for index in range(30):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    items["zzunslotted"] = _cat("zzunslotted")

    plan, settled = repository.plan_color_slot_stage(items, repainted=False)

    assert plan == {"zzunslotted": plan["zzunslotted"]}, "the backfill stage must come first"
    assert settled is False, "a repaint still follows, so this plan cannot stamp"


def test_a_read_mid_backfill_shows_stored_colours_not_the_repaint_it_is_about_to_do(handler):
    """WHIT-428 — [A10] the same leak, end to end. While the BACKFILL stage is the one being
    persisted, a piled row must still read the colour it actually holds. Showing the repaint's
    preview here would repaint the chart a request early — and then again when the allowance
    shifts under a create."""
    repository, repo = _repo_with_fake_table(handler)
    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    for index in range(30):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    items["zzunslotted"] = _cat("zzunslotted")
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    rows = {row["id"]: row[_SLOT] for row in repo.list_categories()}

    assert {rows[f"cat{index:04d}"] for index in range(30)} == {0}, \
        "a piled row previewed its repaint colour while the backfill was still draining"
    previewed = rows["zzunslotted"]                  # the backfill's own row IS previewed
    assert isinstance(previewed, int) and 0 <= previewed < 20 and previewed != 0
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1, "stamped before the repaint ran"

    _drain(repo, limit=40)
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


# --- [A11] the assigner's new `protected` tier -------------------------------


def test_protected_only_bites_once_every_slot_is_owed(handler):
    """WHIT-428 — [A11] `protected` is the SECOND tier: while any slot is un-owed it must not
    change the answer at all, and when a caller protects everything the fallback must still
    return a slot rather than raising ValueError on min([]) — that would 500 a POST.
    Drop the `spare or range(...)` guard and the second half reddens."""
    import repository

    counts = Counter({slot: 1 for slot in range(20)})
    every_slot = frozenset(range(20))

    # Nothing is excluded, so protected is irrelevant and the ordinary least-held answer wins.
    assert (repository.least_held_color_slot(counts, repository.SlotPreference(protected=every_slot))
            == repository.least_held_color_slot(counts, repository.SlotPreference()))
    # Every slot owed AND every slot protected: defensive, but it must not raise.
    slot = repository.least_held_color_slot(
        counts, repository.SlotPreference(excluded=every_slot, protected=every_slot))
    assert isinstance(slot, int) and 0 <= slot < 20


# --- [A12]-[A13] hostile stored data -----------------------------------------


def test_a_repaint_moves_rows_whose_ids_are_hostile_to_dynamodb(handler):
    """WHIT-428 — [A12] the repaint stamps `#items.#catN.#slot`. A row keyed by a DynamoDB
    reserved word, or one carrying a dot (which would be read as a nested path if it were ever
    inlined), or unicode + whitespace, must land on exactly that map key. Inline any id into
    the expression and DynamoDB either mis-writes a nested path or rejects the reserved word —
    and on the read path that failure is SWALLOWED, so the store would simply never level."""
    repository, repo = _repo_with_fake_table(handler)
    hostile = ["a.b", "Size", "NAME", "with space", "café — unicode"]
    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    for cat_id in hostile:
        items[cat_id] = _cat(cat_id, colorSlot=Decimal(0))
    for index in range(20):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    _drain(repo, limit=40)

    stored = repo._table.store[_CFG]["items"]
    for cat_id in hostile:
        assert cat_id in stored, f"{cat_id!r} lost its map key"
        assert 0 <= int(stored[cat_id][_SLOT]) < 20
    assert any(int(stored[cat_id][_SLOT]) != 0 for cat_id in hostile), \
        "fixture drifted: no hostile row was actually moved by the repaint"
    expressions = " ".join(call[0] for call in repo._table.update_calls)
    for cat_id in hostile:
        assert cat_id not in expressions, f"{cat_id!r} was inlined instead of aliased"
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


def test_corrupt_slots_on_top_of_a_pile_still_settle_level_and_stamp_once(handler):
    """WHIT-428 — [A13] the two stages meeting on hostile data: rows whose stored slot is a
    string / float / bool / negative / out-of-range are ABSENT to the histogram but PRESENT in
    the row count the allowance is derived from. Both stages must still run, in order, and the
    store must settle level with no corrupt value surviving — then stay silent."""
    repository, repo = _repo_with_fake_table(handler)
    items = {cat_id: dict(cat) for cat_id, cat in repository.SEED_CATEGORIES.items()}
    corrupt = {"zs": "7", "zf": Decimal("7.5"), "zn": Decimal(-5), "zb": True,
               "zo": Decimal(999)}
    for cat_id, raw in corrupt.items():
        items[cat_id] = _cat(cat_id, colorSlot=raw)
    for index in range(40):
        items[f"cat{index:04d}"] = _cat(f"cat{index:04d}", colorSlot=Decimal(0))
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1), "colorSlotSchema": Decimal(1)}

    _drain(repo, limit=40)

    stored = repo._table.store[_CFG]["items"]
    for cat_id in corrupt:
        value = stored[cat_id][_SLOT]
        assert not isinstance(value, (str, bool)) and 0 <= int(value) < 20 \
            and Decimal(value) == int(value), f"{cat_id} kept a corrupt slot: {value!r}"
    assert _levelled(repo)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()
    repo._table.update_calls.clear()
    repo.list_categories()
    assert repo._table.update_calls == [], "the migration ran a second time"


# --- [A15]-[A16] handler level: criterion 6, no new way to 500 ---------------


def test_get_categories_mid_repaint_is_a_200_even_when_the_write_is_throttled(handler,
                                                                              monkeypatch):
    """WHIT-428 — [A15] the read routes, at the HTTP boundary. GET /categories is the shape
    every other category read (and shared/budget_alerts.py fire_if_crossed) shares: it must be
    a 200 carrying id/name/bucket for every row, mid-repaint, with the migration write
    failing."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    repo._table.update_error = _throttle()
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)

    response = handler.lambda_handler(
        {"rawPath": "/categories", "requestContext": {"http": {"method": "GET"}}}, None)

    assert response["statusCode"] == 200
    body = json.loads(response["body"])
    assert len(body) == 73
    # budget_alerts.fire_if_crossed keys names/buckets off exactly these three fields.
    assert all(row["id"] and row["name"] and row["bucket"] for row in body)
    assert all(isinstance(row[_SLOT], int) and 0 <= row[_SLOT] < 20 for row in body)


def test_post_categories_mid_repaint_returns_201_and_a_plain_integer_slot(handler,
                                                                         monkeypatch):
    """WHIT-428 — [A16] POST mid-repaint. The created colour must reach the client as a JSON
    integer (the repo converts the stored Decimal back to int for exactly this reason), and it
    must be the colour the store finally settles on."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: FakeBudgetRepo())

    response = handler.lambda_handler(_categories_event(), None)

    assert response["statusCode"] == 201
    body = json.loads(response["body"])
    assert type(body[_SLOT]) is int and 0 <= body[_SLOT] < 20

    _drain(repo, limit=40)
    stored = repo._table.store[_CFG]["items"][body["id"]]
    assert int(stored[_SLOT]) == body[_SLOT], \
        "the repaint evicted the colour POST already returned to the client"
    assert _levelled(repo)


# --- [A17]-[A18] convergence and the neighbouring write paths ----------------


def test_a_very_large_piled_store_converges_without_ever_breaching_4kb(handler):
    """WHIT-428 — [A17] scale. A store far past anything the impl suite drains must still
    finish, in ceil(movers / chunk) writes and no more, with every expression inside the 4KB
    cap and the marker written exactly once, at the end."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 587)              # 600 rows, allowance 30
    import repository_category
    movers = len(repository.plan_color_slot_repaint(repo._table.store[_CFG]["items"]))
    chunk = repository_category._COLOR_SLOT_WRITE_CHUNK

    writes = _drain(repo, limit=movers // chunk + 5)

    assert writes == -(-movers // chunk)
    assert max(len(call[0].encode()) for call in repo._table.update_calls) \
        < _MAX_UPDATE_EXPRESSION_BYTES
    assert _levelled(repo)
    assert sum(1 for call in repo._table.update_calls if ":schema" in call[2]) == 1


def test_update_and_delete_mid_repaint_land_on_their_first_attempt(handler):
    """WHIT-428 — [A18] the two write paths that do NOT drain the migration. Neither may be
    dragged into a version race by it: a PATCH or DELETE mid-repaint must take exactly one
    write each, and must not undo a chunk that already landed."""
    repository, repo = _repo_with_fake_table(handler)
    _piled_store(repo, repository, 60)
    repo.list_categories()                           # land one repaint chunk
    assert repo._table.store[_CFG]["colorSlotSchema"] == 1, "fixture drifted: it settled"
    landed = {cat_id: int(cat[_SLOT])
              for cat_id, cat in repo._table.store[_CFG]["items"].items()}
    repo._table.update_calls.clear()

    repo.update_category("cat0000", "Renamed", "Living", "tag")
    repo.delete_category("cat0001")

    assert len(repo._table.update_calls) == 2, "a neighbouring write retried"
    stored = repo._table.store[_CFG]["items"]
    assert stored["cat0000"]["name"] == "Renamed"
    assert int(stored["cat0000"][_SLOT]) == landed["cat0000"]
    assert "cat0001" not in stored
    _drain(repo, limit=40)
    assert repo._table.store[_CFG]["colorSlotSchema"] == _schema()


# ======================================================================================
# Folded from test_categories_whit428_round2.py (WHIT-462) — WHIT-428 (round 2): PATCH echo + plan_new_category_slot. Bodies verbatim.
# ======================================================================================

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
