"""The OTHER direction of the WHIT-432 mirror: server -> client (WHIT-432 QA).

WHIT-432's stated goal is that "a future server-side re-space reddens the client". The
pin it added — src/__tests__/seedSlotSync.logic.test.ts [A7] — reads the real .py, but
lives in JEST, which a server-only pull request skips. So this file is the mirror image:
the same comparison run from the pytest side, which a server change DOES reach.

WHIT-436 closed the trigger gap generally: this file reads a client file (via
ramp_source_path), so it is marked `crosslang` and the twin-guards.yml drift job runs it
on any src/ or shared/ change — a client-only OR server-only edit. That replaced the old
per-file `paths:` pins (the [B7]/[B7b] trigger checks that used to live here, and the
client-tests.yml `shared/repository_category.py` entry they policed).

Covers, by checklist id:
  [B5]  BUILTIN_CATEGORY_INDEX parses out of the shipped client file
  [B6]  every seeded built-in's fallback position == ASSIGNMENT_ORDER[its seed slot]
"""

import re

import pytest

from _chart_ramp import assignment_order, category_colors, ramp_source_path

pytestmark = pytest.mark.crosslang

# `export const BUILTIN_CATEGORY_INDEX: Record<string, number> = { ... };` — anchored at
# the start of a line so the several comment mentions of the name cannot match, and
# comments are stripped first so a commented-out entry is not counted as live.
_COMMENT = re.compile(r"//[^\n]*|/\*.*?\*/", re.DOTALL)
_DECLARATION = re.compile(
    r"^export const BUILTIN_CATEGORY_INDEX[^=]*=\s*\{(.*?)\}", re.MULTILINE | re.DOTALL
)
_PAIR = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\d+)")


def parse_builtin_index(text: str) -> dict:
    """{built-in id -> its id-derived ramp position}, out of the client TypeScript.

    Asserts rather than returns short: a silently-empty map would make [B6] vacuous,
    which is the one failure mode a drift guard cannot afford (green is its normal
    state, so a reader that stopped reading looks exactly like a healthy run).
    """
    bodies = _DECLARATION.findall(_COMMENT.sub("", text))
    assert len(bodies) == 1, (
        "expected exactly one `export const BUILTIN_CATEGORY_INDEX = {...}` declaration, "
        f"found {len(bodies)} — if it was renamed or reshaped, update this parser; if "
        "there are two, delete the dead one."
    )
    index = {name: int(value) for name, value in _PAIR.findall(bodies[0])}
    assert index, (
        "parsed zero entries out of BUILTIN_CATEGORY_INDEX — the entry shape changed; "
        "update the parser in tests/shared/test_builtin_fallback_drift_whit432.py"
    )
    return index


@pytest.fixture
def slots(shared):
    """The server's colour-slot module, imported under `shared`'s sys.path.

    Same fixture as test_color_slot_ramp_drift.py's: repository_category is in
    conftest._REIMPORT, so it is shed afterwards and cannot leak into lambda_api.
    """
    import repository_category

    return repository_category


def test_the_builtin_index_parser_reads_fabricated_source():
    """[B5] Drive the parser against source whose answer is known, so "it still reads
    something real" is itself pinned — and against source it must refuse, so it can
    never return a short map that [B6] would compare vacuously."""
    good = "export const BUILTIN_CATEGORY_INDEX: Record<string, number> = {\n  a: 1, b: 2,\n};\n"
    assert parse_builtin_index(good) == {"a": 1, "b": 2}
    # a commented-out entry is not a live one
    commented = (
        "export const BUILTIN_CATEGORY_INDEX: Record<string, number> = {\n"
        "  a: 1, /* b: 2, */\n};\n"
    )
    assert parse_builtin_index(commented) == {"a": 1}
    for unreadable in ("// export const BUILTIN_CATEGORY_INDEX = { a: 1 };", good * 2, ""):
        with pytest.raises(AssertionError):
            parse_builtin_index(unreadable)


def test_every_builtin_fallback_equals_its_seed_slots_ramp_position(slots):
    """[B6] The WHIT-432 contract, checked from the side a server-only change triggers.

    A built-in resolves its colour two ways: CATEGORY_COLORS[ASSIGNMENT_ORDER[stored
    colorSlot]] when the slot has arrived, and CATEGORY_COLORS[BUILTIN_CATEGORY_INDEX[id]]
    when it has not. Re-space a seed slot here and only the first moves, so the same
    category paints two different colours depending on whether that user's row has been
    backfilled yet — which is precisely the bug WHIT-432 closed for
    shopping/transport/phonenet."""
    index = parse_builtin_index(ramp_source_path().read_text())
    order = assignment_order()
    ramp = category_colors()

    assert set(index) == set(slots.SEED_CATEGORIES), (
        "the client fallback table and the server seed no longer know the same category "
        f"ids: client-only {sorted(set(index) - set(slots.SEED_CATEGORIES))}, "
        f"server-only {sorted(set(slots.SEED_CATEGORIES) - set(index))}"
    )
    assert len(index) == 13

    drift = {
        category_id: {
            "seed_slot": category["colorSlot"],
            "server_paints": ramp[order[category["colorSlot"]]],
            "client_fallback_paints": ramp[index[category_id]],
        }
        for category_id, category in slots.SEED_CATEGORIES.items()
        if index[category_id] != order[category["colorSlot"]]
    }
    assert not drift, (
        "built-in colour drift: BUILTIN_CATEGORY_INDEX in "
        f"{ramp_source_path().name} must equal ASSIGNMENT_ORDER[the seed colorSlot] for "
        f"every built-in, and these disagree: {drift}. A user whose row has been "
        "backfilled sees one colour and a user whose row has not sees another. If you "
        "re-spaced a seed slot on purpose, move the client table in the same commit."
    )

    # Non-vacuity: the loop above proves nothing if the two tables are trivially equal
    # because ASSIGNMENT_ORDER is the identity. It is a real permutation, so at least one
    # built-in's seed slot differs from the ramp position it resolves to.
    assert any(
        category["colorSlot"] != order[category["colorSlot"]]
        for category in slots.SEED_CATEGORIES.values()
    )

