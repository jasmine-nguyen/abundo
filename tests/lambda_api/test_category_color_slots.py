"""Permanent chart colour-slot (colorSlot) tests for the category endpoints.

A category's chart colour is a STORED integer, assigned once and never recomputed, so
adding or deleting a category cannot repaint any other one (WHIT-404/415/429).

The `handler` fixture (conftest.py) makes lambda_api importable in isolation and puts
`shared/` on the path, so `import repository` inside a test resolves under it.
"""

import json
from collections import Counter
from decimal import Decimal

import pytest

from _chart_ramp import assignment_order as client_assignment_order
from _category_fakes import (
    _before_next_update, budget_repo,
    _CFG, _SLOT, _cat, _categories_event,
    _repo_with_fake_table, _slot_histogram,
)


# The solved slot table (see repository_category.SEED_CATEGORIES): each built-in in its own hue family, spread around the ramp.
SEED_SLOTS = {
    "eatingout": 0, "travel": 1, "fitness": 6, "gifts": 7, "health": 8, "coffee": 9,
    "utilities": 10, "groceries": 11, "shopping": 13, "transport": 15, "phonenet": 16,
    "pets": 17, "subs": 18,
}


def test_seed_slots_are_the_solved_table(handler):
    import repository_category
    slots = {cid: cat["colorSlot"] for cid, cat in repository_category.SEED_CATEGORIES.items()}
    assert slots == SEED_SLOTS
    assert len(set(slots.values())) == 13          # distinct: no two built-ins share a colour
    assert all(0 <= s < 20 for s in slots.values())


def test_create_takes_the_lowest_free_slot(handler):
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                          # seed (slots 0,1,6,7,8,9,10,11,13,15,16,17,18)

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    assert created["colorSlot"] == 2                # lowest free under the solved table
    assert repo._table.store[_CFG]["items"]["wine"]["colorSlot"] == 2


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


def test_least_held_color_slot_is_the_lowest_free_slot_below_saturation(handler):
    """While any slot is free, least-held IS lowest-free — a free slot has count 0 and always
    wins, so WHIT-404 changed nothing for a store under 20 categories."""
    import repository_category
    assert repository_category.least_held_color_slot(Counter()) == 0
    assert repository_category.least_held_color_slot(Counter({0: 1, 1: 1, 2: 1})) == 3
    assert repository_category.least_held_color_slot(Counter({0: 1, 2: 1, 3: 1})) == 1  # delete freed 1
    # A deleted BUILT-IN's slot is reused immediately too — the non-seed preference decides
    # which colour to DOUBLE UP on, and that question does not exist while a slot is free.
    seeds_minus_eatingout = Counter({slot: 1 for slot in range(1, 20)})
    assert repository_category.least_held_color_slot(seeds_minus_eatingout) == 0
    # Junk outside the ramp cannot make a real slot look taken, and reading a missing slot
    # must not INSERT it (a plain dict here would raise instead).
    junk = Counter({99: 5, -1: 3})
    assert repository_category.least_held_color_slot(junk) == 0
    assert set(junk) == {99, -1}


def test_least_held_color_slot_spreads_repeats_instead_of_piling_on_one(handler):
    """WHIT-404: past 20 categories a duplicate is unavoidable, but it must not always be the
    SAME duplicate. Before this, every category past the 20th took slot 0."""
    import repository_category
    full = Counter({slot: 1 for slot in range(20)})
    assert repository_category.least_held_color_slot(full) == 2       # lowest non-seed slot
    full[2] += 1
    assert repository_category.least_held_color_slot(full) == 3       # next non-seed, not 2 again
    # Saturated but uneven: the emptiest slot wins even though it is not the lowest. (A merely
    # FREE slot 7 would not discriminate — the old lowest-free walk answers 7 too.)
    uneven = Counter({slot: 2 for slot in range(20)})
    uneven[0] = 5
    uneven[7] = 1
    assert repository_category.least_held_color_slot(uneven) == 7


def test_least_held_color_slot_prefers_slots_no_builtin_owns(handler):
    """WHIT-404 option B: a repeat has to land somewhere, and doubling up on a colour only a
    custom category wears beats doubling up on Eating Out's. Derived from SEED_CATEGORIES, so
    it cannot drift if the seeds are retuned."""
    import repository
    import repository_category
    seed_slots = {int(cat["colorSlot"]) for cat in repository_category.SEED_CATEGORIES.values()}
    non_seed = repository_category._NON_SEED_COLOR_SLOTS
    assert non_seed == frozenset(range(20)) - seed_slots
    # slot 0 (Eating Out) and slot 2 (no built-in) both held once: the non-seed slot wins even
    # though 0 is the lower number.
    full = Counter({slot: 1 for slot in range(20)})
    assert repository_category.least_held_color_slot(full) == 2
    # ...but count still dominates preference: a seed slot held ONCE beats a non-seed held twice.
    full.update({slot: 1 for slot in sorted(non_seed)})
    assert repository_category.least_held_color_slot(full) == 0


def test_slot_survives_json_encoding_as_a_number(handler):
    """DynamoDB hands back Decimal; the client reads JSON. Pin the seam between the slices."""
    import repository
    _, repo = _repo_with_fake_table(handler)
    repo.list_categories()
    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")

    decoded = json.loads(json.dumps(created, default=float))

    assert decoded["colorSlot"] == 2
    # `type is int`, not isinstance: bool passes isinstance(int), and a Decimal would encode
    # to 2.0 (a float) — the POST body must match the int GET returns.
    assert type(decoded["colorSlot"]) is int


def test_a_stored_row_without_an_id_field_does_not_break_the_read(handler):
    """Malformed DATA must not fail the read — list_categories is on the read path of every
    category-reading route."""
    _, repo = _repo_with_fake_table(handler)
    repo.list_categories()                           # seed
    repo._table.store[_CFG]["items"]["orphan"] = {
        k: v for k, v in _cat("orphan").items() if k != "id"}

    assert len(repo.list_categories()) == 14


def test_a_config_item_without_a_version_does_not_break_the_read(handler):
    _, repo = _repo_with_fake_table(handler)
    repo.list_categories()                           # seed
    del repo._table.store[_CFG]["version"]
    repo._table.update_calls.clear()

    assert len(repo.list_categories()) == 13
    assert repo._table.update_calls == []


def test_two_creates_racing_never_land_on_the_same_slot(handler):
    """The slot is computed INSIDE the retry loop, so the loser re-reads and sees the
    winner's slot taken. Hoist it out of the loop and both creates land on 2."""
    repository, repo = _repo_with_fake_table(handler)
    repo.list_categories()                           # seeded; lowest free = 2

    def concurrent_create(item):
        item["items"]["beer"] = _cat("beer", "Lifestyle", colorSlot=Decimal(2))
        item["version"] = item["version"] + 1
    _before_next_update(repo._table, concurrent_create)

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
    import repository_category
    assignment_order = client_assignment_order()
    assert sorted(assignment_order) == list(range(len(assignment_order)))  # a true permutation

    ramp = sorted(assignment_order[cat["colorSlot"]]
                  for cat in repository_category.SEED_CATEGORIES.values())
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
# fix at all. These compute the RESOLVED RAMP LAYOUT from repository_category.SEED_CATEGORIES and assert
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
    import repository_category
    ramp = _seed_ramp(repository_category)

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
    import repository_category
    assert _neighbouring_runs(_seed_ramp(repository_category)) == [
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
    _before_next_update(repo._table, concurrent_create)

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
    import repository_category
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

    counts = repository_category.color_slot_counts(items)

    assert counts == Counter({0: 2, 10: 2, 19: 1})
    assert set(counts) == {0, 10, 19}
    assert 5 not in counts and counts[5] == 0 and 5 not in counts   # a read must not INSERT
    # The real consumer agrees: the create planner treats exactly those three as taken.
    assert repository_category.plan_new_category_slot(items) == 1


def test_a_freed_slot_is_genuinely_reused_not_just_reusable(handler):
    """WHIT-429 — the vacuous test_deleting_a_category_frees_its_slot_for_reuse only ever showed
    a LOWER free slot getting picked, never the freed one itself. Build a settled store holding
    every slot, free ONE non-seed slot by deleting its sole holder, and assert the next create
    lands on exactly that slot — the only genuinely free one."""
    import repository_category

    _, repo = _repo_with_fake_table(handler)
    # 13 seeds on their designated slots, plus one custom row on each of the 7 non-seed slots, so
    # all 20 slots are held exactly once.
    non_seed = sorted(repository_category.least_held_color_slot.__globals__["_NON_SEED_COLOR_SLOTS"])
    items = {cid: dict(cat) for cid, cat in repository_category.SEED_CATEGORIES.items()}
    for slot in non_seed:
        cat_id = f"custom{slot:02d}"
        items[cat_id] = {"id": cat_id, "name": cat_id, "icon": "tag", "color": "#888888",
                         "bucket": "Lifestyle", "parent": None, _SLOT: Decimal(slot)}
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": items,
                               "version": Decimal(1)}

    freed = non_seed[0]
    repo.delete_category(f"custom{freed:02d}")        # slot `freed` is now held by nobody

    created = repo.create_category("wine", "Wine", "Lifestyle", "glass")
    assert created[_SLOT] == freed


def test_post_categories_returns_201_and_a_plain_integer_slot(handler, monkeypatch):
    """The created colour must reach the client as a JSON integer (the repo converts the
    stored Decimal back to int for exactly this reason), and it must be the stored colour."""
    _, repo = _repo_with_fake_table(handler)
    repo.list_categories()                           # seed
    monkeypatch.setattr(handler, "CategoryRepository", lambda: repo)
    monkeypatch.setattr(handler, "BudgetRepository", lambda: budget_repo())

    response = handler.lambda_handler(_categories_event(), None)

    assert response["statusCode"] == 201
    body = json.loads(response["body"])
    assert type(body[_SLOT]) is int and body[_SLOT] == 2
    stored = repo._table.store[_CFG]["items"][body["id"]]
    assert int(stored[_SLOT]) == body[_SLOT]


def test_creating_on_a_store_whose_categories_were_all_deleted_still_gets_slot_zero(handler):
    """_ensure_seeded only writes when the config ITEM is absent, so once the user has deleted
    every category the item survives with an empty map and the next create really does call
    plan_new_category_slot({}). It must hand out slot 0 in a single write."""
    _, repo = _repo_with_fake_table(handler)
    repo._table.store[_CFG] = {"pk": "CATEGORIES", "sk": "CATEGORIES", "items": {},
                               "version": Decimal(1)}

    created = repo.create_category("gym", "Gym", "Lifestyle", "dumbbell")

    assert created[_SLOT] == 0 and type(created[_SLOT]) is int
    assert len(repo._table.update_calls) == 1, "create wrote more than once"
    assert int(repo._table.store[_CFG]["items"]["gym"][_SLOT]) == 0
