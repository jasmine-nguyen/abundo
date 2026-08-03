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

There is deliberately NO pin on the value 20. Both sides agreeing on 25 is a correct
state, so a pin would only cry wolf; the cross-check is self-sufficient. (The
loan-facts ceiling is pinned because every mirror there derives from one file, so a
typo had nothing to disagree with. Not the case here — these are two independent
literals.)
"""

import pytest

from _chart_ramp import (
    assignment_order,
    category_colors,
    parse_order,
    parse_ramp,
    ramp_source_path,
)

_FABRICATED = (
    "export const CATEGORY_COLORS = [\n  '#000000', '#ffffff',\n] as const;\n"
    "export const ASSIGNMENT_ORDER = [\n  1, 0,\n] as const;\n"
)


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


def test_the_client_ramp_file_is_found_and_parses():
    """Sanity-guard the reader itself: if the client declarations are renamed or
    reshaped so nothing matches, fail here with a clear 'update the parser' signal
    rather than letting the comparisons below pass vacuously on empty lists."""
    ramp = category_colors()
    assert len(set(ramp)) == len(ramp), f"the client ramp repeats a colour: {ramp}"
    assert assignment_order()


def test_the_parsers_read_fabricated_source():
    """A guard's normal state is green, so a reader that quietly stopped reading would
    look exactly like a healthy run. Drive the parsers against source whose answer is
    known, so 'it still reads something real' is itself pinned."""
    assert parse_ramp(_FABRICATED) == ["#000000", "#ffffff"]
    assert parse_order(_FABRICATED) == [1, 0]


@pytest.mark.parametrize(
    "unreadable",
    [
        pytest.param("// export const CATEGORY_COLORS = ['#000000'];", id="commented-out"),
        pytest.param("export const CATEGORY_COLORS = [] as const;", id="empty"),
        pytest.param(_FABRICATED * 2, id="declared-twice"),
    ],
)
def test_the_ramp_parser_refuses_source_it_cannot_read(unreadable):
    """The other half: anything ambiguous must raise, never return a short list that
    the drift comparison would then treat as the app's real ramp."""
    with pytest.raises(AssertionError):
        parse_ramp(unreadable)


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
    ABSENT, the backfill would hand it a different one, and it would repaint
    PERMANENTLY — for every existing user, silently."""
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

