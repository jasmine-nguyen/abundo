"""Cross-language guard on the category colour-slot contract (WHIT-406).

The server hands each category a permanent `colorSlot` in [0, _COLOR_SLOT_COUNT)
(shared/repository_category.py). The client resolves it as

    hex = CATEGORY_COLORS[ASSIGNMENT_ORDER[slot]]        (src/chartColors.ts)

so the server's slot range is only correct because the client ramp happens to be the
same length. Nothing tied the two together. Shorten the ramp and every stored slot
past its end resolves to `undefined` — an invisible wedge, a category silently gone
from the chart — and because slots are PERMANENT the bad numbers are already written
into user rows before anyone looks.

What this adds is not "a test that goes red". Roughly twenty assertions already
hard-bake the number 20 (tests/lambda_api/test_categories.py, and client-side
src/__tests__/chartColors.logic.test.ts, chartSlotEdges.logic.test.ts and
categoryColour.logic.test.ts). Those all fail on a one-sided change — but they read as
routine test upkeep, and the obvious repair is to update your own side's 20s, which
turns the suite green while the two languages now genuinely disagree. These tests are
the ones that name the OTHER language in the failure. Changing the slot count is a
multi-file edit; treat a red here as "the other side has not moved yet", not as a
number to bump.

The client half of this contract is guarded from Jest by
src/__tests__/seedSlotSync.logic.test.ts, which reads the .py. That is NOT redundant with
this file, it is the other direction: CI runs each suite on a different trigger, so a
server-only change skips Jest and a client-only change skips pytest. This file reads a
client file, so it is marked `crosslang` and the twin-guards.yml drift job runs it on any
src/ change (WHIT-436, replacing the old src/chartColors.ts pin in python-tests.yml).
Only this side ties CATEGORY_COLORS itself to the slot count — the Jest side compares
against ASSIGNMENT_ORDER.length.

There is deliberately NO pin on the value 20. Both sides agreeing on 25 is a correct
state, so a pin would only cry wolf; the cross-check is self-sufficient. (The
loan-facts ceiling is pinned because every mirror there derives from one file, so a
typo had nothing to disagree with. Not the case here — these are two independent
literals.)
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


@pytest.fixture
def slots(shared):
    """The server's colour-slot module, imported under `shared`'s sys.path.

    Same trick as the `database_error` fixture in conftest.py: `repository_category`
    is not on the `shared` namespace, so the import happens here rather than being
    repeated in every test. It is in conftest's _REIMPORT list, so it is shed
    afterwards — without that, it leaks and breaks the lambda_api suite.
    """
    import repository_category

    return repository_category


def test_server_slot_count_matches_the_client_ramp_length(slots):
    """The slot range the server hands out must have a colour for every slot in it."""
    server = slots._COLOR_SLOT_COUNT
    ramp = category_colors()
    assert server == len(ramp), (
        f"colour-slot drift: shared/repository_category.py hands out slots [0, {server}) "
        f"but {ramp_source_path().name} has {len(ramp)} colours — a stored slot past the "
        "end resolves to CATEGORY_COLORS[ASSIGNMENT_ORDER[slot]] === undefined and the "
        "category vanishes from the chart. Slots are PERMANENT, so shrinking the ramp "
        "orphans slots already written to user rows. Change both sides."
    )


def test_assignment_order_covers_exactly_the_server_slot_range(slots):
    """One assertion, three properties: the permutation is as long as the slot range,
    repeats no ramp position, and holds no value past the end of the ramp. That last
    one is the invisible-slice case — ASSIGNMENT_ORDER could stay 20 entries long and
    still index off the ramp, which the length check alone would not see."""
    server = slots._COLOR_SLOT_COUNT
    order = assignment_order()
    assert sorted(order) == list(range(server)), (
        f"colour-slot drift: shared/repository_category.py hands out slots [0, {server}) "
        f"but {ramp_source_path().name} ASSIGNMENT_ORDER is {order} — it must be a "
        "permutation of exactly that range, or a slot resolves to no colour."
    )


def test_every_seed_slot_is_inside_the_server_slot_range(slots):
    """The built-in categories carry hand-solved slots. If the slot range were ever
    lowered below one of them, _coerce_slot would read that built-in's stored slot as
    ABSENT and it would lose its colour — for every existing user, silently."""
    server = slots._COLOR_SLOT_COUNT
    outside = {
        category_id: category["colorSlot"]
        for category_id, category in slots.SEED_CATEGORIES.items()
        if not 0 <= category["colorSlot"] < server
    }
    assert not outside, (
        f"these built-in categories sit outside the slot range [0, {server}): {outside} "
        "— their stored slots would be treated as absent and reassigned, repainting "
        "built-in categories permanently."
    )


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
        "update the parser in tests/shared/test_color_slot_ramp_drift.py"
    )
    return index


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
