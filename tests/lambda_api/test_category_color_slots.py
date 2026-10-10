"""Permanent chart colour-slot (colorSlot) tests for the category endpoints.

A category's chart colour is a STORED integer, assigned once and never recomputed, so
adding or deleting a category cannot repaint any other one (WHIT-404/415/429).

The `handler` fixture (conftest.py) makes lambda_api importable in isolation and puts
`shared/` on the path, so `import repository_category` inside a test resolves under it.
"""

import json
from collections import Counter
from decimal import Decimal

import pytest

from _api_event import api_event
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


# --- stored slots read safely and never repaint (WHIT-829) -------------------


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
