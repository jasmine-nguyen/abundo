"""Cross-file drift-pin for the budget `available` (spendable) formula (WHIT-549).

The spendable a budget row shows is computed in TWO places that MUST agree:

    - server: lambda_api/handler.py  -> row["available"] = unified_available(target, buffer, payback)
    - client: src/context.tsx        -> the `?? (b.budget + (b.rollover ? b.carryover : 0)
                                          + b.spreadAdjustment)` fallback, used when an older
                                          server omits the field

If the two drift, a user on an old app build (falling back to the client formula) sees a
different number than the server sends. Nothing else guards this pair, so this test:

  1. pins the client fallback expression as TEXT — it must appear verbatim at BOTH read
     sites (budgetViews + budgetDetail), so a one-sided edit fails loudly; and
  2. pins that the server engine `unified_available(target, buffer, payback)` equals that
     same parts-sum for the four row kinds (rollover / spread / plain / income), so a change
     to either side (e.g. a clamp or rounding sneaking into the engine) goes red.

Parses the TypeScript twin as TEXT (no JS runtime in the pytest suite).
"""

import pathlib
import re
from decimal import Decimal

import pytest

pytestmark = pytest.mark.crosslang

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TS_TWIN = _REPO_ROOT / "src" / "context.tsx"

# The exact client fallback, sans the leading `b.available ?? (` and trailing `)` — the
# parts-sum the server's `available` must reproduce. Both read sites carry it verbatim.
_CLIENT_FALLBACK = "b.budget + (b.rollover ? b.carryover : 0) + b.spreadAdjustment"


def _client_available(budget, rollover, carryover, spread_adjustment):
    """A faithful Python transcription of `_CLIENT_FALLBACK`. Kept in lock-step with the
    string above (the text test below asserts the string is what the client actually runs)."""
    return budget + (carryover if rollover else 0) + spread_adjustment


def test_the_client_fallback_appears_verbatim_at_both_read_sites():
    # budgetViews + budgetDetail each compute `available` the same way. Exactly two occurrences —
    # a one-sided edit (or a third, unguarded copy) fails here.
    ts = _TS_TWIN.read_text()
    occurrences = ts.count(_CLIENT_FALLBACK)
    assert occurrences == 2, f"expected the client fallback at both read sites, found {occurrences}"


def test_both_sites_use_the_nullish_guarded_read_not_the_bare_sum():
    # The read must be `b.available ?? (<fallback>)` — `??` (not `||`) so a legitimate server 0
    # is kept. Pins the guard so a refactor can't drop back to the bare parts-sum.
    ts = _TS_TWIN.read_text()
    guarded = f"b.available ?? ({_CLIENT_FALLBACK})"
    assert ts.count(guarded) == 2, "both read sites must use the `b.available ?? (...)` guarded form"


@pytest.mark.parametrize(
    "budget, rollover, carryover, spread_adjustment, buffer_term, payback_term",
    [
        # rollover: server buffer = live carryover, payback 0; client adds carryover.
        (Decimal("100"), True, Decimal("300"), Decimal("0"), Decimal("300"), Decimal("0")),
        # spread: server payback = spread adjustment, buffer 0; client adds spreadAdjustment.
        (Decimal("250"), False, Decimal("0"), Decimal("1390.91"), Decimal("0"), Decimal("1390.91")),
        # plain budget: no cushion either side.
        (Decimal("80"), False, Decimal("0"), Decimal("0"), Decimal("0"), Decimal("0")),
        # income earn-target: excluded from both cushions server-side, so both terms 0.
        (Decimal("5000"), False, Decimal("0"), Decimal("0"), Decimal("0"), Decimal("0")),
    ],
)
def test_server_engine_matches_the_client_parts_sum(
    shared, budget, rollover, carryover, spread_adjustment, buffer_term, payback_term
):
    # The server passes (target, buffer_term, payback_term) into unified_available; the client
    # sums (budget, rollover?carryover:0, spreadAdjustment). For every row kind the two agree.
    server = shared.spend.unified_available(budget, buffer_term, payback_term)
    client = _client_available(budget, rollover, carryover, spread_adjustment)
    assert server == client
