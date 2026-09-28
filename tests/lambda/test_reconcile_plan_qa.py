"""QA tests for the settlement planner (WHIT-624): edges the acceptance tests leave out,
plus parity between the REAL save (`insert_or_reconcile` on FakeTable) and the in-memory
`apply_plan` the budget-alert preview uses, over the same data."""

from decimal import Decimal

_BANK_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _bank_row(txn_id, amount, authorized_date="2026-06-29", pending=True, date="2026-06-29",
              category="FOOD_AND_DRINK", merchant_name="SQ *KKV INTERNATIONAL PTY",
              description="SQ *KKV INTERNATIONAL PTY"):
    return {
        "id": txn_id, "date": date, "authorizedDate": authorized_date,
        "description": description, "merchantName": merchant_name,
        "amount": amount, "accountId": _BANK_ACCOUNT_ID,
        "accountName": "ANZ Rewards Black Visa", "category": category,
        "pending": pending, "type": "PAYMENT", "pendingTransactionId": None,
    }


def _norm(lam, txn_id, amount, **kw):
    return lam.banksync.BankSyncClient.normalise(_bank_row(txn_id, Decimal(amount), **kw))


def _rows_by_id(store):
    return {row["transaction_id"]: {k: v for k, v in row.items() if k not in ("pk", "sk")}
            for row in store.values()}


def _preview(lam, pre_rows, batch, is_unfiled=None):
    """What the alert preview computes: plan over the pre-write snapshot, applied in memory."""
    reconcile = lam.reconcile
    by_id = {tid: dict(row) for tid, row in pre_rows.items()}
    stored = {t["transaction_id"]: by_id[t["transaction_id"]] for t in batch
              if t.get("status") != "pending" and t["transaction_id"] in by_id}
    pools = {}
    for row in pre_rows.values():
        if row.get("status") == "pending":
            pools.setdefault(row["account_id"], []).append(
                {**row, "pk": f"ACCOUNT#{row['account_id']}", "sk": f"TXN#{row['transaction_id']}"})
    plan = reconcile.plan_reconcile(batch, stored, pools)
    return {tid: {k: v for k, v in row.items() if k not in ("pk", "sk") and v is not None}
            for tid, row in reconcile.apply_plan(by_id, plan, is_unfiled).items()}


# [A1] P0 — real save and preview agree on a mixed batch, including the drift the old
# preview had: a pending re-sync whose stored row holds a user category + rule stamp.
def test_real_save_and_preview_agree_on_a_mixed_batch(lam, repo):
    stored_pending = _norm(lam, "PEND-RESYNC", "-9.00", date="2026-07-01", authorized_date="2026-07-01")
    stored_pending.update(category="groceries", filed_by_rule="rule-7", notes="weekly")
    twin = _norm(lam, "PEND-TWIN", "-5.50")
    twin.update(category="coffee")
    stored_posted = _norm(lam, "POST-OLD", "-12.00", pending=False,
                          date="2026-06-29", authorized_date="2026-06-29")
    stored_posted.update(category="eating out")
    repo.insert_transactions([stored_pending, twin, stored_posted])
    pre_rows = _rows_by_id(repo._table.store)

    batch = [
        _norm(lam, "PEND-RESYNC", "-9.40", date="2026-07-01", authorized_date="2026-07-01"),
        _norm(lam, "POST-NEW", "-5.50", pending=False, date="2026-07-02"),
        _norm(lam, "POST-OLD", "-12.00", pending=False, date="2026-07-03", authorized_date="2026-06-28"),
        _norm(lam, "POST-LONE", "-3.00", pending=False, authorized_date="2026-07-02", date="2026-07-02"),
    ]
    preview = _preview(lam, pre_rows, [dict(t) for t in batch])

    repo.insert_or_reconcile(batch)

    assert _rows_by_id(repo._table.store) == preview
    assert "PEND-TWIN" not in preview
    assert preview["PEND-RESYNC"]["filed_by_rule"] == "rule-7"
    assert preview["PEND-RESYNC"]["amount"] == Decimal("-9.40")
    assert preview["POST-NEW"]["category"] == "coffee"


# [A2] P0 — a batch of re-sends only never scans the pending pool (same query count as
# the old lazy _ensure_pool: pools load only for accounts with a first settlement).
def test_resend_only_batch_does_not_scan_pending_pools(lam, repo):
    stored = _norm(lam, "POST", "-12.00", pending=False)
    repo.insert_transactions([stored])
    repo._table.query_calls = 0

    repo.insert_or_reconcile([_norm(lam, "POST", "-12.00", pending=False),
                              _norm(lam, "PEND-NEW", "-4.00")])

    assert repo._table.query_calls == 0


# [A3] P0 — two identical postings, one pending: the twin is consumed exactly once.
def test_one_pending_is_consumed_by_at_most_one_of_two_identical_postings(lam):
    reconcile = lam.reconcile
    pending = {**_norm(lam, "PEND", "-5.50"), "pk": "ACCOUNT#a", "sk": "TXN#PEND"}
    first = _norm(lam, "POST-1", "-5.50", pending=False)
    second = _norm(lam, "POST-2", "-5.50", pending=False)
    account = first["account_id"]

    plan = reconcile.plan_reconcile([first, second], {}, {account: [pending]})

    assert plan.steps == [("settle", first, pending), ("insert", second)]
    assert plan.stale_pending_keys == [("ACCOUNT#a", "TXN#PEND")]


# [A4] P1 — pools are per account: an identical pending on ANOTHER account is never taken.
def test_pending_on_another_account_is_never_matched(lam):
    reconcile = lam.reconcile
    posted = _norm(lam, "POST", "-5.50", pending=False)
    other = {**_norm(lam, "PEND", "-5.50"), "account_id": "other", "pk": "ACCOUNT#other", "sk": "TXN#PEND"}

    plan = reconcile.plan_reconcile([posted], {}, {"other": [other]})

    assert plan.steps == [("insert", posted)]
    assert plan.stale_pending_keys == []


# [A6] P1 — a twin stored under the posted row's OWN key is overwritten, not deleted.
def test_twin_under_the_posted_rows_own_key_is_kept_not_deleted(lam):
    reconcile = lam.reconcile
    posted = _norm(lam, "SAME", "-5.50", pending=False)
    own_pk = f"ACCOUNT#{posted['account_id']}"
    twin = {**_norm(lam, "SAME", "-5.50"), "pk": own_pk, "sk": "TXN#SAME", "category": "coffee"}

    plan = reconcile.plan_reconcile([posted], {}, {posted["account_id"]: [twin]})
    rows = reconcile.apply_plan({"SAME": twin}, plan)

    assert plan.stale_pending_keys == []
    assert rows["SAME"]["category"] == "coffee"
    assert rows["SAME"]["status"] == "posted"


# [A7] P1 — is_unfiled gates only the first-settlement carry: a raw pending category does
# not clobber the posted's own, and counts_to_budget follows the category that landed.
def test_is_unfiled_gates_the_settlement_carry_and_recomputes_the_budget_flag(lam):
    reconcile = lam.reconcile
    posted = _norm(lam, "POST", "-5.50", pending=False)
    posted.update(category="coffee", counts_to_budget=False)
    twin = {**_norm(lam, "PEND", "-5.50"), "pk": "ACCOUNT#a", "sk": "TXN#PEND", "category": "FOOD_AND_DRINK"}

    plan = reconcile.plan_reconcile([posted], {}, {posted["account_id"]: [twin]})
    rows = reconcile.apply_plan({}, plan, is_unfiled=lambda category: category == "FOOD_AND_DRINK")

    assert rows["POST"]["category"] == "coffee"
    assert rows["POST"]["counts_to_budget"] is True


# [A8] P1 — neither apply_plan nor plan_reconcile mutate what the caller passed in.
def test_apply_plan_leaves_the_callers_rows_and_pools_intact(lam):
    reconcile = lam.reconcile
    pending = {**_norm(lam, "PEND", "-5.50"), "pk": "ACCOUNT#a", "sk": "TXN#PEND", "category": "coffee"}
    posted = _norm(lam, "POST", "-5.50", pending=False)
    rows_by_id = {"PEND": pending}
    pools = {posted["account_id"]: [pending]}
    snapshot = {"PEND": dict(pending)}

    reconcile.apply_plan(rows_by_id, reconcile.plan_reconcile([posted], {}, pools))

    assert rows_by_id == snapshot
    assert pools == {posted["account_id"]: [pending]}


# [A9] P1 — the skewed-date merge log still reaches INFO with the root logger at WARNING
# (the Lambda runtime default) now that it comes from the `reconcile` logger.
def test_skewed_merge_log_is_emitted_at_info_from_the_reconcile_logger(lam, caplog, monkeypatch):
    import logging
    reconcile = lam.reconcile
    root = logging.getLogger()
    monkeypatch.setattr(root, "level", logging.WARNING)
    pending = {**_norm(lam, "PEND", "-12.00", authorized_date="2026-06-29"),
               "pk": "ACCOUNT#a", "sk": "TXN#PEND"}
    posted = _norm(lam, "POST", "-12.00", pending=False, authorized_date="2026-06-28")

    reconcile.plan_reconcile([posted], {}, {posted["account_id"]: [pending]})

    merged = [r for r in caplog.records if "skewed-date twin merged" in r.getMessage()]
    assert len(merged) == 1
    assert merged[0].name == "reconcile"
