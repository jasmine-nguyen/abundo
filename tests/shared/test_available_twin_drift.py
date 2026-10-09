"""Drift-pin for the budget `available` (spendable) formula (WHIT-549).

The server computes it (lambda_api/handler.py -> unified_available(target, buffer, payback)) and
the app shows it as sent; since WHIT-840 the app holds no copy of the formula. The test fixtures
build `available` like the server (src/__tests__/factory.ts serverAvailable), as
target + (rollover ? carryover : 0) + spread adjustment. This pins that the server engine still
equals that parts-sum for the four row kinds (rollover / spread / plain / income), so a clamp or
rounding sneaking into the engine goes red.
"""

from decimal import Decimal

import pytest

pytestmark = pytest.mark.crosslang


def _client_available(budget, rollover, carryover, spread_adjustment):
    """The parts-sum the test fixtures use for `available` (factory.ts serverAvailable)."""
    return budget + (carryover if rollover else 0) + spread_adjustment


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
    # The server passes (target, buffer_term, payback_term) into unified_available; the fixtures
    # sum (budget, rollover?carryover:0, spreadAdjustment). For every row kind the two agree.
    server = shared.spend.unified_available(budget, buffer_term, payback_term)
    client = _client_available(budget, rollover, carryover, spread_adjustment)
    assert server == client
