"""WHIT-350 (adversarial gaps) — the _combined_target wrapper around the new shared
fold_subtree. The implementer's test_combined_target_clamps_each_bucket_after_aggregating
only ever yields 0 (a single refund-heavy posted bucket, no pending) and asserts with
`==` (which an int 0 also satisfies). These lock the two contracts that leaves untested:

  * the wrapper must ADD posted + pending — a bug returning only one bucket survives the
    all-zeros test but not a case where BOTH buckets net positive;
  * empty ids must yield a Decimal (the docstring's named "yields Decimal, not int"
    contract) — the existing == 0 check passes for int 0 too, so the TYPE is unlocked.

Pure function; driven through the `alerts` fixture only so shared/ (spend + budget_alerts)
is importable exactly as the sibling tests do.
"""

from decimal import Decimal


def test_combined_target_adds_posted_and_pending_both_nonzero(lam):
    # [A_CT_ADD] (P0) posted nets +40 (petrol -60 spend, tolls +20 refund) and pending
    # nets +15 (a separate pending leg), each survives its independent clamp, so the alert
    # combined target = 40 + 15 = 55 — the SAME figure /budgets' posted+pending shows for
    # this subtree. The clamps-to-0 test never exercises this addition. [fail-on-revert]
    # a wrapper returning only folded["posted"] gives 40; a per-id clamp gives 60+0.
    import spend, budget_alerts
    ids = {"car", "petrol", "tolls"}
    per_id = spend.summarise_transactions([
        {"transaction_id": "a", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-60"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},
        {"transaction_id": "b", "account_id": "up-spending", "category": "tolls",
         "amount": Decimal("20"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},
        {"transaction_id": "c", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-15"), "status": "pending", "date": "2026-07-10",
         "counts_to_budget": True},
    ], ids, clamp=False)
    assert budget_alerts._combined_target(per_id, ids) == Decimal("55")


def test_combined_target_negative_posted_does_not_drag_pending(lam):
    # [A_CT_INDEP] (P0) posted nets NEGATIVE (-30, floored to 0) while pending nets +25.
    # Independent clamp: the negative posted must not cancel the pending. Combined = 0 + 25.
    # [fail-on-revert] clamping the COMBINED sum (max(0, -30+25)) would give 0, not 25.
    import spend, budget_alerts
    ids = {"car", "petrol"}
    per_id = spend.summarise_transactions([
        {"transaction_id": "a", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-10"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},
        {"transaction_id": "b", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("40"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},   # posted nets -30 -> floor 0
        {"transaction_id": "c", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-25"), "status": "pending", "date": "2026-07-10",
         "counts_to_budget": True},   # pending nets +25, must survive
    ], ids, clamp=False)
    assert budget_alerts._combined_target(per_id, ids) == Decimal("25")


def test_combined_target_empty_ids_returns_decimal_not_int(lam):
    # [A_CT_EMPTY] (P1) A corrupt/empty subtree must yield a Decimal, not int — the named
    # docstring contract ("Seed Decimal(0) so an empty set yields Decimal, not int"). The
    # implementer's == 0 check passes for int 0 too, so the TYPE was never locked.
    # [fail-on-revert] a fold seeded with int 0 + max(0, ...) would return int 0 here.
    import budget_alerts
    result = budget_alerts._combined_target({"a": {"posted": Decimal("9"), "pending": Decimal("3")}}, set())
    assert result == Decimal("0")
    assert isinstance(result, Decimal)


def test_combined_target_net_zero_present_entry_contributes_zero_decimal(lam):
    # [A_CT_ZERODICT] (P2) With clamp=False a category can net to {posted:0, pending:0}
    # (a refund exactly cancels its spend) and still be PRESENT in per_id. fold_subtree must
    # treat that present-zero entry the same as absence: 0, and the result stays Decimal.
    import spend, budget_alerts
    ids = {"car", "petrol"}
    per_id = spend.summarise_transactions([
        {"transaction_id": "a", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("-30"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},
        {"transaction_id": "b", "account_id": "up-spending", "category": "petrol",
         "amount": Decimal("30"), "status": "posted", "date": "2026-07-10",
         "counts_to_budget": True},   # exactly cancels -> present entry {0, 0}
    ], ids, clamp=False)
    assert per_id["petrol"] == {"posted": Decimal("0"), "pending": Decimal("0")}  # precondition
    result = budget_alerts._combined_target(per_id, ids)
    assert result == Decimal("0")
    assert isinstance(result, Decimal)
