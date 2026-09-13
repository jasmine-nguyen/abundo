"""Unit tests for the unified "Smoothing" engine in shared/spend.py (WHIT-547, slice 1 of
the WHIT-546 epic): `payback_slice` (this cycle's even repayment of a spread bill, starting
the current cycle), `unified_available` (budget + buffer - slice), and `accrue_buffer` (fold
one completed cycle's leftover into the running buffer). Pure arithmetic; no repos, no AWS.

The invariant every payback test circles back to: a bill of `amount` spread over N cycles is
repaid in even whole-cent slices across cycles 0..N-1 that sum to EXACTLY the amount — so the
plan nets to zero and no cent is created or lost. Unlike spread_adjustment (a full +amount
cushion in cycle 0, clawed back afterwards), smoothing repays starting THIS cycle with no
cushion cycle.
"""

from decimal import Decimal

import pytest


# --- payback_slice: even repayment starting the current cycle --------------------

# The card's amounts, plus the divisible/edge cases the split has to survive.
_PLANS = [
    ("1390.91", 4),   # the Insurance bill that motivated the epic
    ("100.00", 3),    # not evenly divisible — the odd cent must land somewhere
    ("0.01", 3),      # one cent over three cycles: one slice carries it, two are zero
    ("250.00", 1),    # a single repayment cycle (index 0 only)
    ("999.99", 24),   # the max cycle count
]


@pytest.mark.parametrize("amount, cycles", _PLANS)
def test_slices_sum_back_to_exactly_the_amount(shared, amount, cycles):
    # FAIL-ON-REVERT for the cent-exact split: a naive amount/cycles rounding would drift by a
    # cent on the non-divisible cases and break net-zero.
    amount = Decimal(amount)
    slices = [shared.spend.payback_slice(amount, cycles, i) for i in range(cycles)]
    assert all(s <= 0 for s in slices)
    assert sum(slices, Decimal(0)) == -amount


def test_index_0_is_a_repayment_not_a_cushion(shared):
    # The whole point vs. spread_adjustment: smoothing takes a slice off the CURRENT cycle
    # (negative), where the old spread handed out a full +amount cushion at index 0.
    amount = Decimal("100.00")
    assert shared.spend.payback_slice(amount, 3, 0) == Decimal("-33.34")     # a repayment now
    assert shared.spend.spread_adjustment(amount, 3, 0) == amount            # (old spread: cushion)


def test_odd_cents_land_on_the_earliest_slices(shared):
    # $100 over 3: 10000 cents = 3333*3 + 1 -> the earliest slice carries the extra cent.
    assert shared.spend.payback_slice(Decimal("100.00"), 3, 0) == Decimal("-33.34")
    assert shared.spend.payback_slice(Decimal("100.00"), 3, 1) == Decimal("-33.33")
    assert shared.spend.payback_slice(Decimal("100.00"), 3, 2) == Decimal("-33.33")


def test_returns_decimal_not_float(shared):
    # The signature promises Decimal; a stray int/100 float would drift cents downstream.
    result = shared.spend.payback_slice(Decimal("100.00"), 3, 0)
    assert isinstance(result, Decimal)


def test_last_repayment_is_index_n_minus_1_and_the_plan_is_over_after(shared):
    # FAIL-ON-REVERT for the off-by-one: index cycles-1 is the LAST slice; index cycles is past
    # the plan and contributes nothing (repayment spans 0..cycles-1, unlike spread's 1..cycles).
    amount = Decimal("1390.91")
    assert shared.spend.payback_slice(amount, 4, 3) == Decimal("-347.72")  # last slice
    assert shared.spend.payback_slice(amount, 4, 4) == Decimal(0)          # past the plan


def test_far_past_and_negative_index_contribute_nothing(shared):
    amount = Decimal("1390.91")
    assert shared.spend.payback_slice(amount, 24, 24) == Decimal(0)
    assert shared.spend.payback_slice(amount, 24, 500) == Decimal(0)
    assert shared.spend.payback_slice(amount, 3, -1) == Decimal(0)


def test_single_cycle_plan_repays_the_whole_bill_at_index_0(shared):
    assert shared.spend.payback_slice(Decimal("250.00"), 1, 0) == Decimal("-250.00")
    assert shared.spend.payback_slice(Decimal("250.00"), 1, 1) == Decimal(0)


def test_zero_cycles_never_divides_and_stays_at_zero(shared):
    # cycles>=1 in practice (SPREAD_MIN_CYCLES), but the guard must keep a 0 out of divmod
    # rather than raising, and a 0-length plan repays nothing.
    assert shared.spend.payback_slice(Decimal("100.00"), 0, 0) == Decimal(0)


def test_a_zero_amount_repays_nothing(shared):
    assert all(shared.spend.payback_slice(Decimal("0.00"), 4, i) == Decimal(0) for i in range(4))


def test_a_negative_amount_still_nets_to_minus_amount(shared):
    # A refund-shaped amount shouldn't break the invariant (slices become positive, summing to
    # -amount). No aligned plan produces one, but the math must stay consistent.
    amount = Decimal("-100.00")
    slices = [shared.spend.payback_slice(amount, 3, i) for i in range(3)]
    assert sum(slices, Decimal(0)) == -amount  # == +100.00


# --- unified_available: budget + buffer - this cycle's slice ---------------------


def test_unified_available_composes_budget_buffer_and_payback(shared):
    assert shared.spend.unified_available(Decimal("250"), Decimal("40"), Decimal("-60")) == Decimal("230")
    assert shared.spend.unified_available(Decimal("250"), Decimal("0"), Decimal("0")) == Decimal("250")


def test_total_taken_off_spendable_over_the_plan_equals_the_bill(shared):
    # The epic's core identity, provable from slice-1 primitives: with a flat budget and no
    # buffer, the drop below budget each cycle is the slice, and those drops sum to the bill.
    budget, amount, cycles = Decimal("250"), Decimal("1390.91"), 4
    drops = [
        budget - shared.spend.unified_available(budget, Decimal("0"), shared.spend.payback_slice(amount, cycles, i))
        for i in range(cycles)
    ]
    assert sum(drops, Decimal(0)) == amount


# --- accrue_buffer: one cycle's signed leftover -> the running buffer ------------


def test_accrue_buffer_grows_on_underspend_and_shrinks_on_overspend(shared):
    assert shared.spend.accrue_buffer(Decimal("0"), Decimal("250"), Decimal("200")) == Decimal("50")   # under
    assert shared.spend.accrue_buffer(Decimal("50"), Decimal("250"), Decimal("400")) == Decimal("-100")  # over
    assert shared.spend.accrue_buffer(Decimal("0"), Decimal("250"), Decimal("250")) == Decimal("0")    # exact


def test_accrue_buffer_is_exactly_the_signed_leftover(shared):
    # FAIL-ON-REVERT: pins accrue_buffer to `buffer + (target - spend)`, the single-window
    # leftover rule the rollover seal uses, so a later drift is caught.
    assert shared.spend.accrue_buffer(Decimal("12.50"), Decimal("250.00"), Decimal("94.10")) == Decimal("168.40")


def test_accrue_buffer_chains_across_cycles(shared):
    # Five cycles of $250 budget clearing a -1043.77 spike deficit: reaches positive on cycle 5.
    buffer = Decimal("-1043.77")
    for _ in range(4):
        buffer = shared.spend.accrue_buffer(buffer, Decimal("250"), Decimal("0"))
    assert buffer == Decimal("-43.77")            # still in the hole after 4 clean cycles
    buffer = shared.spend.accrue_buffer(buffer, Decimal("250"), Decimal("0"))
    assert buffer == Decimal("206.23")            # recovered on the 5th


# ============================================================================
# WHIT-547 — adversarial GAP tests (QA). Independent of the implementer's suite
# above: large-amount rounding, sub-cent precision, cycles at the real max (24),
# unified_available with no clamping, accrue_buffer sign+order, and cushion-leak
# guards pinning payback_slice's index+1 mapping independent of the index-0 cushion.
# ============================================================================

from itertools import permutations  # noqa: E402

SPREAD_MAX_CYCLES = 24  # mirrors lambda_api/constants.py


# --- payback_slice: large amounts & the real max cycle count stay cent-exact ----


def test_very_large_amount_slices_sum_back_exactly_no_rounding_drift(shared):
    # [A5] a naive amount/cycles float/Decimal split drifts cents on a big, non-divisible
    # amount; the whole-cent divmod must stay exact.
    amount = Decimal("12345678.99")
    slices = [shared.spend.payback_slice(amount, SPREAD_MAX_CYCLES, i) for i in range(SPREAD_MAX_CYCLES)]
    assert all(s <= 0 for s in slices)
    assert sum(slices, Decimal(0)) == -amount


def test_max_cycles_non_divisible_is_net_zero_and_ends_at_index_23(shared):
    # [A6] $100 over the real max 24: 10000c = 416*24 + 16, so 16 slices carry the extra cent.
    # Pins net-zero AND the off-by-one at the top of the range.
    amount = Decimal("100.00")
    slices = [shared.spend.payback_slice(amount, 24, i) for i in range(24)]
    assert sum(slices, Decimal(0)) == -amount
    assert slices[0] == Decimal("-4.17")   # earliest slice carries a cent
    assert slices[16] == Decimal("-4.16")  # after the 16 extras run out
    assert shared.spend.payback_slice(amount, 24, 23) == Decimal("-4.16")  # last slice
    assert shared.spend.payback_slice(amount, 24, 24) == Decimal(0)        # past the plan


# --- sub-cent precision: ROUND_HALF_UP through spread_adjustment -----------------


def test_sub_cent_amount_rounds_half_up_to_whole_cents(shared):
    # [A7] amount is meant to be pre-quantised; the half-up guard means a stray 100.005 is
    # repaid as 100.01 (up), 100.004 as 100.00 (down). Pins the boundary so a change to the
    # rounding mode (e.g. ROUND_DOWN / banker's) is caught.
    up = [shared.spend.payback_slice(Decimal("100.005"), 4, i) for i in range(4)]
    assert sum(up, Decimal(0)) == Decimal("-100.01")
    down = [shared.spend.payback_slice(Decimal("100.004"), 4, i) for i in range(4)]
    assert sum(down, Decimal(0)) == Decimal("-100.00")
    # away-from-zero on the negative side stays symmetric.
    neg = [shared.spend.payback_slice(Decimal("-100.005"), 4, i) for i in range(4)]
    assert sum(neg, Decimal(0)) == Decimal("100.01")


# --- cushion-leak guards: payback_slice must never hand out a positive cushion ---


@pytest.mark.parametrize("amount, cycles", [
    ("1390.91", 4), ("100.00", 3), ("0.01", 3), ("250.00", 1), ("999.99", 24),
])
def test_payback_slice_is_never_positive_for_a_positive_bill_across_a_sweep(shared, amount, cycles):
    # [A8] the epic's whole distinction from spread_adjustment: smoothing has NO +amount
    # cushion cycle. If payback_slice ever passed the raw index (not index+1) it would hit
    # spread_adjustment's `index==0 -> +amount` branch and leak a cushion. Sweep well outside
    # the plan on both sides; a positive here is a cushion leak.
    amount = Decimal(amount)
    for i in range(-3, cycles + 4):
        assert shared.spend.payback_slice(amount, cycles, i) <= 0


def test_payback_slice_index0_is_the_ordinal_1_slice_not_the_cushion(shared):
    # [A9] pins the index+1 mapping directly: payback_slice(_, N, 0) must equal
    # spread_adjustment's FIRST claw-back slice (ordinal 1), never its index-0 cushion. This
    # is what keeps payback_slice independent of any future edit to the index-0 cushion.
    amount = Decimal("1390.91")
    for cycles in (1, 3, 4, 24):
        assert shared.spend.payback_slice(amount, cycles, 0) == shared.spend.spread_adjustment(amount, cycles, 1)
        assert shared.spend.payback_slice(amount, cycles, 0) != amount  # not the cushion


def test_payback_slice_maps_every_index_to_the_next_ordinal_slice(shared):
    # [A10] the full index i -> ordinal i+1 contract across the range, so a drift to `index`
    # or `index+2` is caught, not just at index 0.
    amount = Decimal("100.00")
    cycles = 4
    for i in range(cycles):
        assert shared.spend.payback_slice(amount, cycles, i) == shared.spend.spread_adjustment(amount, cycles, i + 1)


# --- unified_available: pure sum, no clamping (payback can drive it negative) ----


def test_unified_available_does_not_clamp_a_negative_result(shared):
    # [A11] a payback slice bigger than budget+buffer must show a real negative spendable, not
    # a clamped 0. Also catches a `budget + buffer - payback` sign flip (that would give +130
    # here). The pure primitive must not hide an overdrawn category.
    assert shared.spend.unified_available(Decimal("100"), Decimal("-50"), Decimal("-80")) == Decimal("-30")
    # a positive buffer can lift a big payback back above zero.
    assert shared.spend.unified_available(Decimal("100"), Decimal("200"), Decimal("-80")) == Decimal("220")


# --- accrue_buffer: sign correctness AND order-independence across mixed cycles --


def test_accrue_buffer_mixed_cycles_value_catches_a_sign_flip(shared):
    # [A12] fold under+over+exact+over. Correct signed leftover fold lands at -30; a
    # `buffer - (target - spend)` sign flip would land at +30. Order-independence alone can't
    # catch the flip (both sides are still additive), so this pins the value.
    cycles = [
        (Decimal("250"), Decimal("100")),   # +150 under
        (Decimal("250"), Decimal("400")),   # -150 over
        (Decimal("250"), Decimal("250")),   #    0 exact
        (Decimal("100"), Decimal("130")),   #  -30 over
    ]
    buffer = Decimal("0")
    for target, spend in cycles:
        buffer = shared.spend.accrue_buffer(buffer, target, spend)
    assert buffer == Decimal("-30")


def test_accrue_buffer_is_order_independent_across_mixed_cycles(shared):
    # [A13] the buffer is a running sum of signed leftovers, so the ORDER cycles are folded
    # must not matter (a sinking-fund end-state depends only on totals). Guards against a
    # future non-additive rule (caps/clamps mid-fold) sneaking in.
    cycles = [
        (Decimal("250"), Decimal("100")),
        (Decimal("250"), Decimal("400")),
        (Decimal("250"), Decimal("250")),
        (Decimal("100"), Decimal("130")),
    ]
    def fold(seq):
        b = Decimal("0")
        for target, spend in seq:
            b = shared.spend.accrue_buffer(b, target, spend)
        return b
    baseline = fold(cycles)
    for perm in permutations(cycles):
        assert fold(perm) == baseline
