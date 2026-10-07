"""QA for WHIT-653: the skewed-fee reconcile tier (a settled charge dated one day
EARLIER than its pending, with a small fee folded into the amount). Covers what the
implementer's section in test_reconcile.py leaves open: the real Westpac account, the
re-send that follows a merge, the other carried fields, tier competition, sign/zero,
ragged dates, account scoping, the merge log, and the budget-alert outcome."""

from decimal import Decimal

_ANZ_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"
_WESTPAC_ACCOUNT_ID = "A3AC9195-9E8D-48B8-86D0-46D130D7F64A"   # -> westpac-altitude-qantas-black
_UP_ACCOUNT_ID = "3zVQJ8Btz_IRmqp78VrQnQ"                      # -> up-spending

_PEND_DESC = "Pending - ANTHROPIC* CLAUDE SUB      SAN FRANCISOUS"
_POST_DESC = "ANTHROPIC* CLAUDE SUB SAN FRANCIS USA"
_MERCHANT = "ANTHROPIC* CLAUDE SUB"


def _txn(lam, *, txn_id, amount, authorized_date, pending, category="GENERAL_SERVICES",
         account_id=_WESTPAC_ACCOUNT_ID, description=None, merchant_name=_MERCHANT, date=None):
    if description is None:
        description = _PEND_DESC if pending else _POST_DESC
    return lam.banksync.normalise({
        "id": txn_id, "date": date or authorized_date, "authorizedDate": authorized_date,
        "description": description, "merchantName": merchant_name, "amount": amount,
        "accountId": account_id, "accountName": "Altitude Qantas Black",
        "category": category, "pending": pending, "type": "PAYMENT",
        "pendingTransactionId": None,
    })


def _pending(repo, lam, txn_id="PEND", amount=Decimal("-170.01"), authorized_date="2026-09-27",
             category="subs", **extra):
    kw = {k: extra.pop(k) for k in ("account_id", "description", "merchant_name", "date") if k in extra}
    row = _txn(lam, txn_id=txn_id, amount=amount, authorized_date=authorized_date,
               pending=True, category=category, **kw)
    row.update(extra)
    repo.insert_transactions([row])
    return row


def _posted(lam, txn_id="POST", amount=Decimal("-175.11"), authorized_date="2026-09-26", **kw):
    return _txn(lam, txn_id=txn_id, amount=amount, authorized_date=authorized_date,
                pending=False, **kw)


def _acc(txn):
    return "ACCOUNT#" + txn["account_id"]


# [A1] P0 — the live pair on the REAL Westpac account (the implementer's anchor runs on ANZ).
def test_claude_pair_on_the_westpac_account_merges(lam, repo):
    _pending(repo, lam)
    posted = _posted(lam)
    assert posted["account_id"] == "westpac-altitude-qantas-black"

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    assert list(store) == [(_acc(posted), "TXN#POST")]
    row = store[(_acc(posted), "TXN#POST")]
    assert row["amount"] == Decimal("-175.11")
    assert row["category"] == "subs"
    assert row["date"] == "2026-09-27"


# [A2] P0 — BankSync re-sends the settled row (UTC date again) for days. The merged row
# must keep the pending's day and the user's category, and stay a single row.
def test_resend_after_a_skewed_fee_merge_keeps_the_day_and_category(lam, repo):
    _pending(repo, lam, notes="claude max")
    repo.insert_or_reconcile([_posted(lam)])

    repo.insert_or_reconcile([_posted(lam)])

    store = repo._table.store
    assert len(store) == 1
    row = next(iter(store.values()))
    assert row["date"] == "2026-09-27"
    assert row["authorized_date"] == "2026-09-27"
    assert row["category"] == "subs"
    assert row["notes"] == "claude max"
    assert row["amount"] == Decimal("-175.11")


# [A4] P1 — tags and budget_excluded carry off the pending like the other tiers.
def test_skewed_fee_merge_carries_tags_and_budget_excluded(lam, repo):
    _pending(repo, lam, tags=["work"], budget_excluded=True)

    repo.insert_or_reconcile([_posted(lam)])

    row = repo._table.store[(_acc(_posted(lam)), "TXN#POST")]
    assert row["tags"] == ["work"]
    assert row["budget_excluded"] is True


# [A5] P0 — a same-day tip twin is claimed by the tip tier before the fee tier sees the
# skewed one: the next-day pending survives.
def test_same_day_tip_twin_beats_a_skewed_fee_twin(lam, repo):
    _pending(repo, lam, txn_id="SAMEDAY", amount=Decimal("-50.00"), authorized_date="2026-09-26",
             category="same")
    _pending(repo, lam, txn_id="NEXTDAY", amount=Decimal("-50.00"), authorized_date="2026-09-27",
             category="next")

    repo.insert_or_reconcile([_posted(lam, amount=Decimal("-51.00"))])

    store = repo._table.store
    acc = _acc(_posted(lam))
    assert (acc, "TXN#SAMEDAY") not in store
    assert (acc, "TXN#NEXTDAY") in store
    assert store[(acc, "TXN#POST")]["category"] == "same"


# [A6] P1 — two fee-sized candidates: the lowest pending id wins, and the other survives.
def test_two_fee_candidates_take_the_lowest_pending_id(lam, repo):
    _pending(repo, lam, txn_id="P2", amount=Decimal("-170.01"), category="second")
    _pending(repo, lam, txn_id="P1", amount=Decimal("-171.00"), category="first")

    repo.insert_or_reconcile([_posted(lam)])

    store = repo._table.store
    acc = _acc(_posted(lam))
    assert (acc, "TXN#P1") not in store
    assert (acc, "TXN#P2") in store
    assert store[(acc, "TXN#POST")]["category"] == "first"


# [A7] P1 — two pendings, two fee postings in one batch: each pending is used once.
def test_two_fee_pairs_in_one_batch_each_merge_once(lam, repo):
    _pending(repo, lam, txn_id="PA", amount=Decimal("-100.00"), category="a")
    _pending(repo, lam, txn_id="PB", amount=Decimal("-100.00"), category="b")

    repo.insert_or_reconcile([_posted(lam, txn_id="X1", amount=Decimal("-103.00")),
                              _posted(lam, txn_id="X2", amount=Decimal("-103.00"))])

    store = repo._table.store
    acc = _acc(_posted(lam))
    assert sorted(sk for _, sk in store) == ["TXN#X1", "TXN#X2"]
    assert {store[(acc, "TXN#X1")]["category"], store[(acc, "TXN#X2")]["category"]} == {"a", "b"}


# [A8] P0 — income is never a fee match: a larger credit after a smaller pending credit.
def test_credit_pair_with_skew_and_growth_does_not_merge(lam, repo):
    _pending(repo, lam, amount=Decimal("100.00"))

    repo.insert_or_reconcile([_posted(lam, amount=Decimal("103.00"))])

    assert len(repo._table.store) == 2


# [A9] P1 — a zero-amount pending (Westpac stores the FOREIGN FEE line at 0) never matches.
def test_zero_amount_pending_is_never_a_fee_twin(lam, repo):
    _pending(repo, lam, amount=Decimal("0"))

    repo.insert_or_reconcile([_posted(lam, amount=Decimal("-0.01"))])

    assert len(repo._table.store) == 2


# [A10] P0 — the skew is exactly one day: two days apart does not merge.
def test_two_day_skew_with_fee_does_not_merge(lam, repo):
    _pending(repo, lam, authorized_date="2026-09-28")

    repo.insert_or_reconcile([_posted(lam)])

    assert len(repo._table.store) == 2


# [A11] P1 — same-day pending with a fee-sized gap is the TIP tier's job (and merges there):
# the new tier must not change that outcome — row keeps its own day, no date inheritance.
def test_same_day_fee_sized_gap_still_merges_via_tip_tier_without_date_shift(lam, repo):
    _pending(repo, lam, authorized_date="2026-09-26")

    repo.insert_or_reconcile([_posted(lam)])

    store = repo._table.store
    row = store[(_acc(_posted(lam)), "TXN#POST")]
    assert len(store) == 1
    assert row["date"] == "2026-09-26"


# [A12] P1 — calendar edges: month and year boundaries.
def test_skewed_fee_merges_across_month_and_year_boundaries(lam, repo):
    _pending(repo, lam, txn_id="PM", amount=Decimal("-100.00"), authorized_date="2026-10-01")
    _pending(repo, lam, txn_id="PY", amount=Decimal("-200.00"), authorized_date="2027-01-01")

    repo.insert_or_reconcile([_posted(lam, txn_id="XM", amount=Decimal("-103.00"),
                                      authorized_date="2026-09-30"),
                              _posted(lam, txn_id="XY", amount=Decimal("-206.00"),
                                      authorized_date="2026-12-31")])

    store = repo._table.store
    acc = _acc(_posted(lam))
    assert sorted(sk for _, sk in store) == ["TXN#XM", "TXN#XY"]
    assert store[(acc, "TXN#XM")]["date"] == "2026-10-01"
    assert store[(acc, "TXN#XY")]["date"] == "2027-01-01"


# [A13] P0 — the pending must be on the SAME account.
def test_skewed_fee_does_not_cross_accounts(lam, repo):
    _pending(repo, lam, account_id=_UP_ACCOUNT_ID)

    repo.insert_or_reconcile([_posted(lam)])

    assert len(repo._table.store) == 2


# [A14] P1 — a posted row with NO authorized_date and a fee-sized gap: the blank-auth tier
# stays exact-amount, so it does not merge (the new tier is not reached).
def test_blank_auth_posted_with_fee_gap_does_not_merge(lam, repo):
    _pending(repo, lam)
    posted = _posted(lam, date="2026-09-29")
    posted["authorized_date"] = None

    repo.insert_or_reconcile([posted])

    assert len(repo._table.store) == 2


# [A15] P1 — a pooled pending with no amount must not crash the fee tier.
def test_pending_missing_amount_is_skipped_by_fee_tier(lam, repo):
    pending = _pending(repo, lam)
    stored = repo._table.store[(_acc(pending), "TXN#PEND")]
    stored.pop("amount")

    repo.insert_or_reconcile([_posted(lam)])

    assert len(repo._table.store) == 2


# [A16] P1 — the merge deletes a row, so the INFO line is the only trace.
def test_skewed_fee_merge_logs_both_ids_and_amounts(lam, repo, caplog):
    _pending(repo, lam)
    caplog.set_level("INFO")

    repo.insert_or_reconcile([_posted(lam)])

    merged = [r for r in caplog.records if "skewed-fee twin merged" in r.getMessage()]
    assert len(merged) == 1
    message = merged[0].getMessage()
    assert "posted=POST (auth 2026-09-26)" in message
    assert "pending=PEND (auth 2026-09-27)" in message
    assert "amount=-175.11" in message
    assert "pending_amount=-170.01" in message


# [A17] P0 — the headroom constant has one home, and it's 5%.
def test_skew_fee_headroom_is_five_percent_and_used_by_reconcile(lam):
    import constants
    assert constants.SKEW_FEE_HEADROOM == Decimal("0.05")
    assert lam.reconcile.SKEW_FEE_HEADROOM is constants.SKEW_FEE_HEADROOM


# [A18] P0 — the tip tier's 25% limit is untouched by the refactor: +25% same-day merges,
# +25.01% does not.
def test_tip_tier_boundary_unchanged(lam, repo):
    _pending(repo, lam, txn_id="T1", amount=Decimal("-100.00"), authorized_date="2026-09-26")
    _pending(repo, lam, txn_id="T2", amount=Decimal("-100.00"), authorized_date="2026-09-20",
             category="t2")

    repo.insert_or_reconcile([_posted(lam, txn_id="X1", amount=Decimal("-125.00")),
                              _posted(lam, txn_id="X2", amount=Decimal("-125.01"),
                                      authorized_date="2026-09-20")])

    store = repo._table.store
    acc = _acc(_posted(lam))
    assert (acc, "TXN#T1") not in store
    assert (acc, "TXN#T2") in store
