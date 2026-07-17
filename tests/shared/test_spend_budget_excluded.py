"""WHIT-296: a user's `budget_excluded` override drops a transaction from budget
math. The gate lives in one place — `_spend_contribution` in shared/spend.py — so
every summariser (budgets, breakdown, uncategorized, income) and everything built on
them (over-budget alerts, AI Insights) honours it from this one change.

`summarise_transactions` is the public entry that funnels through the gate, so we
assert behaviour through it rather than reaching for the private helper.
"""

from decimal import Decimal


def _txn(amount, *, category="coffee", budget_excluded=None, counts=True, status="posted"):
    txn = {
        "transaction_id": f"t-{amount}",
        "amount": Decimal(str(amount)),
        "category": category,
        "status": status,
        "counts_to_budget": counts,
    }
    # Sparse: only set the override when the caller asks, mirroring a stored row.
    if budget_excluded is not None:
        txn["budget_excluded"] = budget_excluded
    return txn


def test_excluded_transaction_does_not_count(shared):
    # A -$40 coffee charge the bank counts, but the user marked as a transfer, adds
    # nothing to the coffee bar.
    totals = shared.spend.summarise_transactions(
        [_txn(-40, budget_excluded=True)], {"coffee"}
    )
    assert totals == {}  # no contributing transaction -> no bucket


def test_non_excluded_transaction_still_counts(shared):
    # Same charge without the override contributes its full spend — proves the gate
    # only fires on the override, not on the field merely existing (fail-on-revert:
    # if the gate change is reverted, the excluded case above would also count here's
    # amount, so these two together pin the behaviour).
    totals = shared.spend.summarise_transactions(
        [_txn(-40, budget_excluded=False)], {"coffee"}
    )
    assert totals["coffee"]["posted"] == Decimal("40")


def test_absent_override_counts_like_before(shared):
    # A row with no budget_excluded key at all behaves exactly as pre-WHIT-296.
    totals = shared.spend.summarise_transactions([_txn(-40)], {"coffee"})
    assert totals["coffee"]["posted"] == Decimal("40")


def test_excluded_charge_removed_from_a_mixed_set(shared):
    # Two coffee charges, one excluded: only the counting one lands in the bar.
    totals = shared.spend.summarise_transactions(
        [_txn(-40, budget_excluded=True), _txn(-15)], {"coffee"}
    )
    assert totals["coffee"]["posted"] == Decimal("15")
