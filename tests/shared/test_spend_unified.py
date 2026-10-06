"""Unit tests for `unified_available` in shared/spend.py (WHIT-547): a smoothed category's
spendable is budget + buffer + this cycle's (negative) payback slice. Pure arithmetic; no
repos, no AWS.
"""

from decimal import Decimal


def test_unified_available_composes_budget_buffer_and_payback(shared):
    assert shared.spend.unified_available(Decimal("250"), Decimal("40"), Decimal("-60")) == Decimal("230")
    assert shared.spend.unified_available(Decimal("250"), Decimal("0"), Decimal("0")) == Decimal("250")


def test_unified_available_does_not_clamp_a_negative_result(shared):
    # A payback slice bigger than budget+buffer must show a real negative spendable, not
    # a clamped 0. Also catches a `budget + buffer - payback` sign flip (that would give +130
    # here). The pure primitive must not hide an overdrawn category.
    assert shared.spend.unified_available(Decimal("100"), Decimal("-50"), Decimal("-80")) == Decimal("-30")
    # a positive buffer can lift a big payback back above zero.
    assert shared.spend.unified_available(Decimal("100"), Decimal("200"), Decimal("-80")) == Decimal("220")
