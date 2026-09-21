"""WHIT-312: `summarise_earned` — the total income (all Income-bucket categories)
for the Insights Earned-vs-Spent chart. Income is stored POSITIVE (sign=+1), a single
aggregate is returned, and it clamps at >= 0. It reuses the shared `_spend_contribution`
gate, so counts_to_budget / budget_excluded / status handling is proven elsewhere; these
tests pin what is specific to earned: the +sign, the Income-id gate, and the clamp.
"""

from decimal import Decimal


def _txn(amount, *, category="salary", status="posted", counts=True, budget_excluded=None):
    txn = {
        "transaction_id": f"t-{amount}-{category}",
        "amount": Decimal(str(amount)),
        "category": category,
        "status": status,
        "counts_to_budget": counts,
    }
    if budget_excluded is not None:
        txn["budget_excluded"] = budget_excluded
    return txn


def test_earned_sums_positive_income_posted_and_pending(shared):
    totals = shared.spend.summarise_earned(
        [_txn(2500, status="posted"), _txn(300, status="pending")],
        {"salary"},
    )
    assert totals == {"posted": Decimal("2500"), "pending": Decimal("300")}


def test_earned_spans_all_income_ids_not_just_one(shared):
    # Every id in the income set counts, not only a "target" category.
    totals = shared.spend.summarise_earned(
        [_txn(2000, category="salary"), _txn(75, category="dividends")],
        {"salary", "dividends"},
    )
    assert totals == {"posted": Decimal("2075"), "pending": Decimal("0")}


def test_earned_ignores_non_income_categories(shared):
    # A spend category id is not in the income set, so it never contributes.
    totals = shared.spend.summarise_earned(
        [_txn(-40, category="coffee"), _txn(2500, category="salary")],
        {"salary"},
    )
    assert totals == {"posted": Decimal("2500"), "pending": Decimal("0")}


def test_earned_net_reversal_clamps_to_zero(shared):
    # A clawback bigger than the earnings can't drive earned negative.
    totals = shared.spend.summarise_earned(
        [_txn(100, status="posted"), _txn(-250, status="posted")],
        {"salary"},
    )
    assert totals == {"posted": Decimal("0"), "pending": Decimal("0")}


def test_earned_honours_budget_excluded_and_counts(shared):
    totals = shared.spend.summarise_earned(
        [
            _txn(1000),
            _txn(500, budget_excluded=True),
            _txn(400, counts=False),
        ],
        {"salary"},
    )
    assert totals == {"posted": Decimal("1000"), "pending": Decimal("0")}


def test_earned_empty_when_no_income(shared):
    totals = shared.spend.summarise_earned([_txn(-40, category="coffee")], {"salary"})
    assert totals == {"posted": Decimal("0"), "pending": Decimal("0")}


# --- adversarial gaps (qa) — WHIT-312 ----------------------------------------


def test_earned_same_category_net_positive_reversal_keeps_the_net(shared):
    # [A15] A partial reversal in the SAME income category (net still positive) must leave the
    # actual net — not clamp to 0 (that only happens net-negative) and not ignore the
    # reversal and report the gross. 2500 - 100 = 2400.
    totals = shared.spend.summarise_earned(
        [_txn(2500, status="posted"), _txn(-100, status="posted")],
        {"salary"},
    )
    assert totals == {"posted": Decimal("2400"), "pending": Decimal("0")}


def test_earned_reversal_in_one_category_reduces_the_shared_aggregate(shared):
    # summarise_earned is a SINGLE aggregate across every income id: a clawback in one
    # category eats into another category's earnings in the same bucket. 3000 - 200 = 2800.
    totals = shared.spend.summarise_earned(
        [_txn(3000, category="salary"), _txn(-200, category="dividends")],
        {"salary", "dividends"},
    )
    assert totals == {"posted": Decimal("2800"), "pending": Decimal("0")}
