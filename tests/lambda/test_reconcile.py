"""Tests for pending→posted reconciliation in the BankSync webhook
(`TransactionRepository.insert_or_reconcile`) and its wiring in `process_transaction`.

Real data drives the scenarios: on settlement BankSync issues a NEW id with
`pendingTransactionId: null` (e.g. pending b726e693 → posted 14e463, both
authorizedDate 2026-06-29, -5.50), so a blind insert would leave a duplicate and
lose the user's category. These tests build rows through `banksync.normalise`
so the stored shapes match production, and inject a FakeTable via `repo._table`.
"""

from decimal import Decimal

import pytest

from _feed_fakes import FakeCategoryRepo
from _rule_ingest_fakes import KKV_RULE, FakeRuleStore

# A real BankSync account id (resolves via ACCOUNT_ID_MAP to an internal id).
_BANK_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _bank_row(txn_id, amount, authorized_date="2026-06-29", pending=True,
              category="FOOD_AND_DRINK", pending_transaction_id=None, date="2026-06-29",
              description="SQ *KKV INTERNATIONAL PTY", merchant_name="SQ *KKV INTERNATIONAL PTY"):
    return {
        "id": txn_id,
        "date": date,
        "authorizedDate": authorized_date,
        "description": description,
        "merchantName": merchant_name,
        "amount": amount,
        "accountId": _BANK_ACCOUNT_ID,
        "accountName": "ANZ Rewards Black Visa",
        "category": category,
        "pending": pending,
        "type": "PAYMENT",
        "pendingTransactionId": pending_transaction_id,
    }


def _norm(lam, **kw):
    return lam.banksync.normalise(_bank_row(**kw))


def _seed_pending(repo, lam, **kw):
    """Store a (typically already user-categorised) transaction and return it."""
    txn = _norm(lam, **kw)
    repo.insert_transactions([txn])
    return txn


def _acc(txn):
    return "ACCOUNT#" + txn["account_id"]


# --- the core bug: pending→posted with a new id -----------------------------


def test_reconcile_carries_category_and_deletes_pending(lam, repo):
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert store[(acc, "TXN#B")]["category"] == "coffee"   # carried onto the posted row
    assert (acc, "TXN#A") not in store                      # stale pending removed
    assert len(store) == 1                                   # no duplicate


def test_twin_under_the_posted_rows_own_key_is_kept_not_deleted(lam, repo):
    # The pending settles under its OWN id: its twin sits at the posted row's key, so
    # deleting the "stale" twin would delete the settled charge itself.
    _seed_pending(repo, lam, txn_id="SAME", amount=Decimal("-5.50"), pending=True, category="coffee")
    posted = _norm(lam, txn_id="SAME", amount=Decimal("-5.50"), pending=False)
    # A stale read misses the stored row, so the twin comes from the pending pool and
    # reaches the settle step instead of an in-place update.
    repo.get_transaction = lambda pk, sk, consistent=False: None

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    assert list(store) == [(_acc(posted), "TXN#SAME")]
    assert store[(_acc(posted), "TXN#SAME")]["category"] == "coffee"
    assert store[(_acc(posted), "TXN#SAME")]["status"] == "posted"


def test_settled_charge_keeps_its_swipe_date_not_the_settlement_date(lam, repo):
    # Fail-on-revert: a charge swiped a week ago that settles today must NOT
    # jump to today's date. The pending and its posted twin share authorizedDate
    # (2026-06-22, the swipe day); only the booking `date` moves to 2026-06-29 on
    # settlement. After reconcile the surviving posted row must still read 2026-06-22.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-42.00"),
                  authorized_date="2026-06-22", date="2026-06-22", pending=True, category="groceries")
    posted = _norm(lam, txn_id="B", amount=Decimal("-42.00"),
                   authorized_date="2026-06-22", date="2026-06-29",  # booked/settled a week later
                   pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    row = repo._table.store[(_acc(posted), "TXN#B")]
    assert row["date"] == "2026-06-22"              # swipe day — does NOT jump to settlement day
    assert row["authorized_date"] == "2026-06-22"
    assert row["category"] == "groceries"           # category still carried across settlement


# --- blank authorized_date on settlement (ANZ) ------------------------------
# Some ANZ settlements arrive with authorized_date BLANK. The exact/tip tiers key on it,
# so without a fallback the pending twin is orphaned (a duplicate) AND the settled row
# keeps its settlement date instead of the swipe day. A blank-auth tier matches on
# amount + merchant-in-description + a date window, then inherits the swipe date.


def test_blank_auth_settlement_reconciles_and_inherits_swipe_date(lam, repo):
    # Fail-on-revert: swiped 07-17 (pending); settled 07-21 with NO authorized_date. Must
    # still match the twin, carry category, inherit the swipe date, and delete the pending.
    _seed_pending(repo, lam, txn_id="PEND", amount=Decimal("-74.46"),
                  authorized_date="2026-07-17", date="2026-07-17", pending=True, category="eating out",
                  description="POS AUTHORISATION ISAN THAI STREET FOOD PTYMELBOURNE AU",
                  merchant_name="ISAN THAI STREET FOOD")
    posted = _norm(lam, txn_id="POST", amount=Decimal("-74.46"),
                   authorized_date="", date="2026-07-21", pending=False, category="FOOD_AND_DRINK",
                   description="ISAN THAI STREET FOOD     MELBOURNE", merchant_name="ISAN THAI STREET FOOD")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    row = store[(acc, "TXN#POST")]
    assert row["date"] == "2026-07-17"              # swipe day, inherited from the twin
    assert row["authorized_date"] == "2026-07-17"
    assert row["category"] == "eating out"          # category still carried across settlement
    assert (acc, "TXN#PEND") not in store            # pending twin removed — no duplicate
    assert len(store) == 1


def test_resync_does_not_regress_a_corrected_blank_auth_date(lam, repo):
    # After the first reconcile fixed the row to 07-17, BankSync re-sends the same posted
    # (still blank auth, booking date 07-21) within the feed window. The re-sync must KEEP
    # 07-17, not clobber it back to the settlement day.
    existing = _norm(lam, txn_id="POST", amount=Decimal("-74.46"), authorized_date="2026-07-17",
                     date="2026-07-17", pending=False, merchant_name="ISAN THAI STREET FOOD",
                     description="ISAN THAI STREET FOOD MELBOURNE")
    repo.insert_transactions([existing])

    resent = _norm(lam, txn_id="POST", amount=Decimal("-74.46"), authorized_date="", date="2026-07-21",
                   pending=False, merchant_name="ISAN THAI STREET FOOD",
                   description="ISAN THAI STREET FOOD MELBOURNE")
    repo.insert_or_reconcile([resent])

    row = repo._table.store[(_acc(resent), "TXN#POST")]
    assert row["date"] == "2026-07-17"              # corrected swipe day preserved
    assert row["authorized_date"] == "2026-07-17"


def test_blank_auth_does_not_merge_a_different_merchant(lam, repo):
    # A coincidental same-amount pending for a DIFFERENT merchant must not be consumed.
    _seed_pending(repo, lam, txn_id="PEND", amount=Decimal("-74.46"),
                  authorized_date="2026-07-17", date="2026-07-17", pending=True,
                  description="POS AUTHORISATION COLES SUPERMARKET MELBOURNE AU",
                  merchant_name="COLES SUPERMARKET")
    posted = _norm(lam, txn_id="POST", amount=Decimal("-74.46"), authorized_date="", date="2026-07-21",
                   pending=False, description="ISAN THAI STREET FOOD MELBOURNE",
                   merchant_name="ISAN THAI STREET FOOD")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#PEND") in store                # different merchant -> not merged
    assert store[(acc, "TXN#POST")]["date"] == "2026-07-21"  # no twin -> no inherit
    assert len(store) == 2


def test_blank_auth_does_not_merge_outside_the_date_window(lam, repo):
    # Same merchant + amount, but the pending is 20 days older than the settlement — well
    # past the window — so it must not be swept in.
    _seed_pending(repo, lam, txn_id="PEND", amount=Decimal("-74.46"),
                  authorized_date="2026-07-01", date="2026-07-01", pending=True,
                  description="POS AUTHORISATION ISAN THAI STREET FOOD PTYMELBOURNE AU",
                  merchant_name="ISAN THAI STREET FOOD")
    posted = _norm(lam, txn_id="POST", amount=Decimal("-74.46"), authorized_date="", date="2026-07-21",
                   pending=False, description="ISAN THAI STREET FOOD MELBOURNE",
                   merchant_name="ISAN THAI STREET FOOD")

    repo.insert_or_reconcile([posted])

    assert (_acc(posted), "TXN#PEND") in repo._table.store   # outside window -> not merged
    assert len(repo._table.store) == 2


def test_blank_auth_single_word_merchant_does_not_reconcile(lam, repo):
    # A one-word merchant is too weak to trust for a delete-a-pending merge (mirrors the
    # tip tier), so a blank-auth posted with a single-word merchant falls through to insert.
    _seed_pending(repo, lam, txn_id="PEND", amount=Decimal("-74.46"),
                  authorized_date="2026-07-17", date="2026-07-17", pending=True,
                  description="POS AUTHORISATION ISAN MELBOURNE AU", merchant_name="ISAN")
    posted = _norm(lam, txn_id="POST", amount=Decimal("-74.46"), authorized_date="", date="2026-07-21",
                   pending=False, description="ISAN MELBOURNE", merchant_name="ISAN")

    repo.insert_or_reconcile([posted])

    assert (_acc(posted), "TXN#PEND") in repo._table.store   # single-word merchant -> no merge
    assert len(repo._table.store) == 2


def test_reconcile_carries_notes_and_tags_onto_posted(lam, repo):
    # WHIT-275: a note/tags on a pending charge must survive settlement, exactly as
    # category does. notes/tags aren't bank fields (normalise strips them), so inject
    # them onto the stored pending row directly.
    pending = _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                            authorized_date="2026-06-29", pending=True, category="coffee")
    acc = _acc(pending)
    repo._table.store[(acc, "TXN#A")]["notes"] = "reimburse from work"
    repo._table.store[(acc, "TXN#A")]["tags"] = ["work", "travel"]

    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([posted])

    row = repo._table.store[(acc, "TXN#B")]
    assert row["notes"] == "reimburse from work"   # note carried
    assert row["tags"] == ["work", "travel"]        # tags carried
    assert row["category"] == "coffee"              # category still carried too
    assert (acc, "TXN#A") not in repo._table.store  # stale pending removed


# --- WHIT-329: a still-pending re-send under the same id keeps the user's fields ------


def test_pending_resync_preserves_notes_tags_and_budget_excluded(lam, repo):
    # The same fields the settled path carries (WHIT-275/296) must survive a pending
    # re-send too. These aren't bank fields, so inject them onto the stored pending row.
    pending = _seed_pending(repo, lam, txn_id="A", amount=Decimal("-260.00"),
                            pending=True, category="health")
    acc = _acc(pending)
    repo._table.store[(acc, "TXN#A")]["notes"] = "gap fee"
    repo._table.store[(acc, "TXN#A")]["tags"] = ["health", "claimable"]
    repo._table.store[(acc, "TXN#A")]["budget_excluded"] = True

    resent = _norm(lam, txn_id="A", amount=Decimal("-260.00"),
                   pending=True, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([resent])

    row = repo._table.store[(acc, "TXN#A")]
    assert row["category"] == "health"
    assert row["notes"] == "gap fee"
    assert row["tags"] == ["health", "claimable"]
    assert row["budget_excluded"] is True


# --- tip-adjusted settlement (WHIT-116) -------------------------------------


def test_tip_within_headroom_reconciles(lam, repo):
    # A tip added at settlement makes the amount differ (5.50 -> 6.00, +9%), so the
    # EXACT-amount tier misses — but the tip tier (same day + merchant + within +25%)
    # now catches it. Same merchant string on both rows.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-6.00"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store                          # stale pending removed
    assert store[(acc, "TXN#B")]["category"] == "coffee"        # category carried
    assert len(store) == 1                                       # no duplicate


def test_tip_real_doordash_shape_reconciles(lam, repo):
    # The live pair that raised this card: the PENDING auth has NO merchantName and a
    # noisy "POS AUTHORISATION  DD *DOORDASH XUANBANHC ..." description; the SETTLED
    # charge carries the clean merchant column, +$2 tip. The posted merchant words
    # ("DOORDASH XUANBANHC") must be found in the pending's raw description.
    _seed_pending(
        repo, lam, txn_id="A", amount=Decimal("-24.53"), authorized_date="2026-06-29",
        pending=True, category="eatingout", merchant_name="",
        description="POS AUTHORISATION         DD *DOORDASH XUANBANHC   +611800958316AU",
    )
    posted = _norm(
        lam, txn_id="B", amount=Decimal("-26.53"), authorized_date="2026-06-29",
        pending=False, category="FOOD_AND_DRINK", merchant_name="DD *DOORDASH XUANBANHC",
        description="DD *DOORDASH XUANBANHC    MELBOURNE",
    )

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store
    assert store[(acc, "TXN#B")]["category"] == "eatingout"
    assert len(store) == 1


def test_different_merchant_same_day_within_headroom_does_not_merge(lam, repo):
    # THE over-match guard: a DIFFERENT same-day merchant whose stripped description
    # coincidentally contains the token. "Nicole's Cafe" normalises to "nicoles cafe";
    # a raw substring test would find "coles" inside it. The word-level merchant gate
    # must block it — 'coles' is not a whole word in the pending description.
    _seed_pending(
        repo, lam, txn_id="A", amount=Decimal("-3.30"), authorized_date="2026-06-29",
        pending=True, category="coffee", merchant_name="",
        description="POS AUTHORISATION         NICOLE'S CAFE            MELBOURNE    AU",
    )
    posted = _norm(  # Coles, -4.00 (3.30 -> 4.00 is within +25%: 3.30*1.25 = 4.125)
        lam, txn_id="B", amount=Decimal("-4.00"), authorized_date="2026-06-29",
        pending=False, category="FOOD_AND_DRINK", merchant_name="COLES 0602",
        description="COLES 0602               MELBOURNE    AU",
    )

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store                                    # Nicole's untouched
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"
    assert len(store) == 2


def test_exact_amount_preferred_over_tip_candidate(lam, repo):
    # Pool has BOTH an exact-amount pending and a smaller tip-eligible one for the same
    # posted charge. Tier 2 (exact) must win; the tip candidate is left untouched.
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),   # tip-eligible for -6.00
                  authorized_date="2026-06-29", pending=True, category="groceries")
    _seed_pending(repo, lam, txn_id="A2", amount=Decimal("-6.00"),   # exact
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-6.00"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A2") not in store                              # exact twin consumed
    assert (acc, "TXN#A1") in store                                  # tip candidate untouched
    assert store[(acc, "TXN#B")]["category"] == "coffee"            # carried from the exact twin


# --- forward-compat: pendingTransactionId exact link ------------------------


def test_exact_pending_transaction_id_link(lam, repo):
    # authorized_date AND amount differ, so the heuristic would NOT match — only the
    # explicit link does. Proves the exact path works the day BankSync populates it.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-6.00"), authorized_date="2026-07-02",
                   pending=False, category="FOOD_AND_DRINK", pending_transaction_id="A")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"


def test_bogus_link_falls_through_to_heuristic(lam, repo):
    # A pending_transaction_id that isn't a stored pending must NOT crash or fabricate
    # a key — it falls through to the heuristic, which matches here.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), authorized_date="2026-06-29",
                   pending=False, category="FOOD_AND_DRINK", pending_transaction_id="ghost")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"


# --- batch behaviour --------------------------------------------------------


def test_batch_mix_reconciles_and_queries_once_per_account(lam, repo):
    _seed_pending(repo, lam, txn_id="P", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    repo._table.query_calls = 0

    batch = [
        _norm(lam, txn_id="C", amount=Decimal("-9.00"),
              authorized_date="2026-07-01", pending=True, category="FOOD_AND_DRINK"),   # new pending
        _norm(lam, txn_id="B", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),  # settles P
        _norm(lam, txn_id="D", amount=Decimal("-3.00"),
              authorized_date="2026-07-02", pending=False, category="FOOD_AND_DRINK"),  # no match
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert (acc, "TXN#C") in store                                   # new pending inserted
    assert (acc, "TXN#P") not in store                               # settled + deleted
    assert store[(acc, "TXN#B")]["category"] == "coffee"
    assert (acc, "TXN#D") in store                                   # unmatched posted inserted
    assert repo._table.query_calls == 1                              # pending pool fetched once


# --- consume-on-match across a batch (locks the pool.pop) --------------------


def test_consume_on_match_pool_exhausts(lam, repo):
    # One pending, two posted twins in the batch: the FIRST consumes it, the second
    # finds an empty pool and falls through to a plain insert. Without pool.pop, the
    # second would also match the pending and wrongly carry "coffee".
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    batch = [
        _norm(lam, txn_id="B", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="C", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert (acc, "TXN#A1") not in store                              # consumed by B
    assert store[(acc, "TXN#B")]["category"] == "coffee"
    assert store[(acc, "TXN#C")]["category"] == "FOOD_AND_DRINK"     # no twin left -> plain insert


# --- small edge coverage ----------------------------------------------------


def test_matched_pending_without_category_still_dedupes(lam, repo):
    # An uncategorised pending (falsy category) still gets reconciled/de-duped; the
    # posted keeps its own (bank) category rather than carrying an empty one.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store                          # stale pending removed
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"  # empty not carried


# --- WHIT-116 adversarial edges (QA) ----------------------------------------
# Gaps beyond the happy-path/AC tests: partial/FX settlement, merchant-vs-tie-break
# selection, None-amount pool rows, truncation, empty-category carry on the tip path,
# cross-tier pool.pop contention, single pool query, and direct locks on the two new
# pure helpers. All assert against the live production code and fail on revert.


def test_single_common_word_merchant_does_not_merge(lam, repo):
    # Money-safety (the >=2-word guard): a posted charge whose merchant cleans to a
    # SINGLE common word ("EXPRESS") must not consume an unrelated same-day pending
    # that merely contains that word ("COLES EXPRESS"). Without the guard the lone
    # word would match and DELETE the Coles pending, mis-carrying its category.
    _seed_pending(
        repo, lam, txn_id="A", amount=Decimal("-25.00"), authorized_date="2026-06-29",
        pending=True, category="groceries", merchant_name="",
        description="POS AUTHORISATION         COLES EXPRESS            MELBOURNE    AU",
    )
    posted = _norm(  # merchant cleans to the lone word "EXPRESS"; -28.00 is within +25%
        lam, txn_id="B", amount=Decimal("-28.00"), authorized_date="2026-06-29",
        pending=False, category="FOOD_AND_DRINK", merchant_name="EXPRESS 1234",
        description="EXPRESS 1234             MELBOURNE",
    )

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store                                   # Coles pending untouched
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"
    assert len(store) == 2


def test_only_merchant_matching_pending_consumed_not_lowest_id(lam, repo):
    # Two same-day pendings, BOTH within tip headroom of the posted charge. The only
    # discriminator is the merchant: A1 (lower id) is a different merchant, A2 (higher
    # id) is the real twin. The merchant gate must select A2 even though the tie-break
    # would otherwise grab the lowest id A1 — proving the gate runs BEFORE the tie-break.
    _seed_pending(
        repo, lam, txn_id="A1", amount=Decimal("-5.50"), authorized_date="2026-06-29",
        pending=True, category="groceries", merchant_name="",
        description="POS AUTHORISATION         WOOLWORTHS 1234           MELBOURNE    AU",
    )
    _seed_pending(
        repo, lam, txn_id="A2", amount=Decimal("-5.50"), authorized_date="2026-06-29",
        pending=True, category="coffee",  # default KKV description contains the merchant
    )
    posted = _norm(lam, txn_id="B", amount=Decimal("-6.00"),   # KKV, +tip within headroom
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A2") not in store                              # true twin consumed
    assert (acc, "TXN#A1") in store                                  # Woolworths untouched
    assert store[(acc, "TXN#B")]["category"] == "coffee"            # carried from A2, not A1


def test_pending_with_missing_amount_never_matches(lam, repo):
    # A pooled pending with no amount (defensive: DB rows shouldn't, but must never
    # KeyError). It has the matching merchant + day, so absent the None-guard the tip
    # tier would try _is_larger_within(item["amount"], ...) and raise. Must not crash,
    # must not match.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    # Strip amount off the stored pending (the pool is the DB scan of this store).
    acc = _acc(_norm(lam, txn_id="A", amount=Decimal("-5.50")))
    del repo._table.store[(acc, "TXN#A")]["amount"]

    posted = _norm(lam, txn_id="B", amount=Decimal("-6.00"),   # would tip-match if amount present
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])                          # must not raise

    store = repo._table.store
    assert (acc, "TXN#A") in store                                   # unmatched, survives
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"     # no carry
    assert len(store) == 2


# --- WHIT-117: exact twin must not be starved by a tip sibling across rows ---
# The companion of test_exact_and_tip_compete_for_one_pending_consumed_once (which
# runs the BENIGN order, exact-first). Here the tip-eligible posting is FIRST. On the
# old single-pass code it popped the one pending via the tip tier, so the exact posting
# behind it inserted UNCATEGORISED. The two-pass resolves all exact twins before any tip,
# so the exact posting wins its category regardless of batch order.


def test_exact_beats_tip_regardless_of_batch_order(lam, repo):
    # The same one-pending / exact+tip conflict must resolve identically whichever order
    # the two postings arrive in. Locks order-independence (a partial fix that only
    # reordered the loop would still fail one of the two orders).
    for order in (["B", "C"], ["C", "B"]):   # B=exact -5.50, C=tip -6.00
        repo._table.store.clear()
        _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                      authorized_date="2026-06-29", pending=True, category="coffee")
        rows = {
            "B": _norm(lam, txn_id="B", amount=Decimal("-5.50"), authorized_date="2026-06-29",
                       pending=False, category="FOOD_AND_DRINK"),
            "C": _norm(lam, txn_id="C", amount=Decimal("-6.00"), authorized_date="2026-06-29",
                       pending=False, category="FOOD_AND_DRINK"),
        }
        repo.insert_or_reconcile([rows[order[0]], rows[order[1]]])

        store = repo._table.store
        acc = _acc(rows["B"])
        assert store[(acc, "TXN#B")]["category"] == "coffee", order          # exact always wins
        assert store[(acc, "TXN#C")]["category"] == "FOOD_AND_DRINK", order  # tip never carries
        assert (acc, "TXN#A") not in store, order
        assert len(store) == 2, order


def test_two_pass_is_scoped_per_account(lam, repo):
    # The two-pass shares pools KEYED BY ACCOUNT, so exact-before-tip must not leak
    # across accounts: account 1's exact twin must not defer or steal account 2's tip.
    # Account 1: pending X1 -5.50, exact posting -5.50. Account 2: pending X2 -5.50,
    # tip posting -6.00. Both must settle their own account's pending.
    _ACCT2 = "3zVQJ8Btz_IRmqp78VrQnQ"  # -> up-spending (distinct from the default account)

    def _bank2(txn_id, amount, pending, category):
        row = _bank_row(txn_id, amount, authorized_date="2026-06-29",
                        pending=pending, category=category)
        row["accountId"] = _ACCT2
        row["accountName"] = "Up Spending"
        return lam.banksync.normalise(row)

    _seed_pending(repo, lam, txn_id="X1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    repo.insert_transactions([_bank2("X2", Decimal("-5.50"), pending=True, category="groceries")])

    batch = [
        _norm(lam, txn_id="P1", amount=Decimal("-5.50"),   # acct1 exact twin of X1
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _bank2("P2", Decimal("-6.00"), pending=False, category="FOOD_AND_DRINK"),  # acct2 tip twin of X2
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc1 = "ACCOUNT#" + batch[0]["account_id"]
    acc2 = "ACCOUNT#" + batch[1]["account_id"]
    assert acc1 != acc2
    assert store[(acc1, "TXN#P1")]["category"] == "coffee"      # acct1 settled its own pending
    assert (acc1, "TXN#X1") not in store
    assert store[(acc2, "TXN#P2")]["category"] == "groceries"   # acct2 settled its own pending
    assert (acc2, "TXN#X2") not in store
    assert len(store) == 2


# ---------------------------------------------------------------------------
# WHIT-117 GAP COVERAGE (adversarial half, authored by qa): multi-pending /
# multi-posting conflicts, exact-tier money-safety, pass-2-on-emptied-pool, the
# precomputed-match replay end-state, and degenerate batches. The four tests
# above use ONE pending + ONE-or-two postings; these exercise the batch shapes
# those miss. Each flips on the single-pass behaviour it names (two are refactor/
# money-safety guards, labelled as such).
# ---------------------------------------------------------------------------


def test_multiple_exact_twins_each_consumed_once(lam, repo):
    # GAP (money-safety of the exact tier across a batch): two indistinguishable same-day
    # same-amount pendings A1 "coffee" / A2 "tea" and two identical exact postings. Each
    # pending must be popped exactly once (no posting claims a pending already taken) and
    # the min-transaction_id tie-break is deterministic: the first posting takes A1.
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    _seed_pending(repo, lam, txn_id="A2", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="tea")
    batch = [
        _norm(lam, txn_id="P1", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="P2", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert store[(acc, "TXN#P1")]["category"] == "coffee"   # lowest-id pending -> 1st posting
    assert store[(acc, "TXN#P2")]["category"] == "tea"      # the other pending, not re-claimed
    assert (acc, "TXN#A1") not in store
    assert (acc, "TXN#A2") not in store
    assert len(store) == 2                                  # both consumed once, no ghost


# --- direct locks on the new pure helpers -----------------------------------


def test_is_larger_within_edges(lam):
    f = lambda a, s: lam.reconcile._is_larger_within(a, s, lam.reconcile.TIP_HEADROOM)
    D = Decimal
    # equal magnitude is inside the (inclusive) window
    assert f(D("-5"), D("-5")) is True
    # a real tip within +25%
    assert f(D("-5"), D("-6")) is True
    # exactly auth*1.25 (boundary, inclusive)
    assert f(D("-4"), D("-5")) is True
    # just over the boundary
    assert f(D("-4"), D("-5.01")) is False
    # settled SMALLER than auth -> never a tip (one-directional)
    assert f(D("-5"), D("-4.99")) is False
    # opposite signs / refunds are never tip-matches
    assert f(D("5"), D("-5")) is False          # positive auth
    assert f(D("-5"), D("5")) is False          # positive settled (refund)
    # zero auth or both zero -> guarded out (>= 0)
    assert f(D("0"), D("-1")) is False
    assert f(D("0"), D("0")) is False


def test_merchant_in_description_word_level(lam):
    g = lam.merchant._merchant_in_description
    # empty merchant never over-matches
    assert g("", "anything at all") is False
    # single short token is NOT a substring match: 'bp' is not a word in 'bpay'
    assert g("bp", "bpay convenience melbourne") is False
    # 'coles' is not a whole word inside 'nicoles'
    assert g("coles", "pos authorisation nicoles cafe melbourne au") is False
    # multi-word merchant as a consecutive run inside the noisy auth description
    assert g("DOORDASH XUANBANHC",
             "POS AUTHORISATION DD *DOORDASH XUANBANHC +611800958316AU") is True
    # order matters: the words must appear consecutively in order
    assert g("XUANBANHC DOORDASH",
             "POS AUTHORISATION DD *DOORDASH XUANBANHC AU") is False
    # a legitimate single-word whole-word match (the >=2-word delete guard lives in the
    # caller, not this helper)
    assert g("coles", "coles express melbourne au") is True


# --- WHIT-331: ANZ's Melbourne/UTC swipe-date skew --------------------------
# ANZ dates a pending record in Melbourne-local time and its settled twin in UTC, so a
# purchase swiped before 10:00 local carries two dates one day apart and the equal-date
# tiers miss it. Verbatim shapes from the live table: the pending description is
# fixed-width, and "SQ *KKV INTERNATIONAL PTY" exactly fills the 25-char merchant column
# so the suburb fuses onto it ("PTYSunshine").

_SKEW_PEND_DESC = "POS AUTHORISATION         SQ *KKV INTERNATIONAL PTYSunshine     AU"
_SKEW_POST_DESC = "SQ *KKV INTERNATIONAL PTY Sunshine"
_SKEW_POST_MERCHANT = "SQ *KKV INTERNATIONAL PTY "


def _skew_pending(repo, lam, txn_id="PEND", amount=Decimal("-11.00"),
                  authorized_date="2026-07-22", category="coffee", description=_SKEW_PEND_DESC):
    # merchant_name="" mirrors production: ANZ pendings carry no merchantName column.
    return _seed_pending(repo, lam, txn_id=txn_id, amount=amount,
                         authorized_date=authorized_date, date=authorized_date,
                         pending=True, category=category,
                         description=description, merchant_name="")


def _skew_posted(lam, txn_id="POST", amount=Decimal("-11.00"), authorized_date="2026-07-21",
                 date="2026-07-24", description=_SKEW_POST_DESC,
                 merchant_name=_SKEW_POST_MERCHANT):
    return _norm(lam, txn_id=txn_id, amount=amount, authorized_date=authorized_date,
                 date=date, pending=False, category="FOOD_AND_DRINK",
                 description=description, merchant_name=merchant_name)


def test_anz_skewed_date_pair_reconciles_and_keeps_the_melbourne_day(lam, repo):
    # THE bug: one $11 coffee stored twice because the pending said 07-22 (Melbourne)
    # and the settled row said 07-21 (UTC). Fail-on-revert anchor for the whole card.
    _skew_pending(repo, lam)
    posted = _skew_posted(lam)

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#PEND") not in store           # twin removed — no double count
    assert len(store) == 1
    row = store[(acc, "TXN#POST")]
    assert row["date"] == "2026-07-22"              # Melbourne day, the day it was swiped
    assert row["authorized_date"] == "2026-07-22"
    assert row["category"] == "coffee"              # user's category survives settlement


def test_resync_does_not_regress_a_skew_corrected_date(lam, repo):
    # BankSync re-sends a settled row for FEED_WINDOW_DAYS, each time carrying the UTC
    # date again. By then the pending is gone, so the row falls to the re-sync path — it
    # must keep the corrected Melbourne day instead of flipping back every sync.
    _skew_pending(repo, lam)
    repo.insert_or_reconcile([_skew_posted(lam)])
    assert repo._table.store[(_acc(_skew_posted(lam)), "TXN#POST")]["date"] == "2026-07-22"

    repo.insert_or_reconcile([_skew_posted(lam)])   # verbatim re-send, UTC date again

    row = repo._table.store[(_acc(_skew_posted(lam)), "TXN#POST")]
    assert row["date"] == "2026-07-22"
    assert row["authorized_date"] == "2026-07-22"


def test_resync_after_skew_merge_does_not_consume_an_unrelated_pending(lam, repo):
    # BankSync re-sends a settled row for FEED_WINDOW_DAYS. A SECOND genuine purchase at
    # the same shop for the same amount, dated a day after the settled row, is exactly the
    # shape the skew tier looks for — so without the re-send guard the re-send would eat
    # it, deleting a real pending and grafting its category onto the older row.
    _skew_pending(repo, lam)
    repo.insert_or_reconcile([_skew_posted(lam)])
    _skew_pending(repo, lam, txn_id="LATER", authorized_date="2026-07-22", category="lunch")

    repo.insert_or_reconcile([_skew_posted(lam)])

    store = repo._table.store
    assert (_acc(_skew_posted(lam)), "TXN#LATER") in store
    assert store[(_acc(_skew_posted(lam)), "TXN#POST")]["category"] == "coffee"


def test_two_genuine_consecutive_day_purchases_do_not_merge(lam, repo):
    # Same coffee, same price, bought two days running. The exact tier must claim the
    # same-day pending FIRST, leaving the next day's real purchase untouched.
    _skew_pending(repo, lam, txn_id="PEND21", authorized_date="2026-07-21")
    _skew_pending(repo, lam, txn_id="PEND22", authorized_date="2026-07-22")

    repo.insert_or_reconcile([_skew_posted(lam, authorized_date="2026-07-21")])

    store = repo._table.store
    acc = _acc(_skew_posted(lam))
    assert (acc, "TXN#PEND21") not in store         # exact same-day twin consumed
    assert (acc, "TXN#PEND22") in store             # the OTHER real purchase survives
    assert store[(acc, "TXN#POST")]["date"] == "2026-07-21"   # equal dates -> no carry


def test_both_consecutive_day_purchases_settle_without_losing_a_row(lam, repo):
    # Follow the pair all the way through settlement: two real purchases in, two out.
    _skew_pending(repo, lam, txn_id="PEND21", authorized_date="2026-07-21")
    _skew_pending(repo, lam, txn_id="PEND22", authorized_date="2026-07-22")

    repo.insert_or_reconcile([_skew_posted(lam, txn_id="POST21", authorized_date="2026-07-21")])
    repo.insert_or_reconcile([_skew_posted(lam, txn_id="POST22", authorized_date="2026-07-22")])

    store = repo._table.store
    assert {k[1] for k in store} == {"TXN#POST21", "TXN#POST22"}
    assert len(store) == 2                          # nothing lost, nothing duplicated


def test_skew_single_word_merchant_does_not_merge_a_neighbouring_brand(lam, repo):
    # Was `test_skew_single_word_merchant_does_not_merge`, which asserted that a
    # one-word merchant never reconciles at all — that WAS the bug. The protection it
    # was reaching for still stands, but it now rests on the two cleaned names being
    # equal rather than on the word appearing in the description: "COLES" IS a whole
    # word of "COLES EXPRESS 1157", so the old description search would have merged
    # these two different brands and deleted a real pending.
    _skew_pending(repo, lam,
                  description="POS AUTHORISATION         COLES EXPRESS 1157       FOOTSCRAY    AU")

    repo.insert_or_reconcile([_skew_posted(lam, description="COLES 0602 MELBOURNE",
                                          merchant_name="COLES 0602               ")])

    assert len(repo._table.store) == 2


# --- WHIT-653: skewed date AND a foreign fee folded into the settled amount ---------

_CLAUDE_PEND_DESC = "Pending - ANTHROPIC* CLAUDE SUB      SAN FRANCISOUS"
_CLAUDE_POST_DESC = "ANTHROPIC* CLAUDE SUB SAN FRANCIS USA"
_CLAUDE_MERCHANT = "ANTHROPIC* CLAUDE SUB"


def _fee_pending(repo, lam, txn_id="PEND", amount=Decimal("-170.01"),
                 authorized_date="2026-09-27", category="subs", notes=None,
                 description=_CLAUDE_PEND_DESC, merchant_name=_CLAUDE_MERCHANT):
    pending = _norm(lam, txn_id=txn_id, amount=amount, authorized_date=authorized_date,
                    date=authorized_date, pending=True, category=category,
                    description=description, merchant_name=merchant_name)
    if notes is not None:
        pending["notes"] = notes
    repo.insert_transactions([pending])
    return pending


def _fee_posted(lam, txn_id="POST", amount=Decimal("-175.11"), authorized_date="2026-09-26",
                description=_CLAUDE_POST_DESC, merchant_name=_CLAUDE_MERCHANT):
    return _norm(lam, txn_id=txn_id, amount=amount, authorized_date=authorized_date,
                 date=authorized_date, pending=False, category="GENERAL_SERVICES",
                 description=description, merchant_name=merchant_name)


def test_westpac_overseas_charge_with_fee_a_day_earlier_reconciles(lam, repo):
    # WHIT-653 fail-on-revert anchor: the live Claude pair. Pending -170.01 on 09-27
    # settles as -175.11 (+$5.10 foreign fee) dated 09-26 — both rows stayed in the app.
    _fee_pending(repo, lam, notes="claude max")
    posted = _fee_posted(lam)

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#PEND") not in store           # stale pending removed — no double count
    assert len(store) == 1
    row = store[(acc, "TXN#POST")]
    assert row["amount"] == Decimal("-175.11")
    assert row["category"] == "subs"
    assert row["notes"] == "claude max"
    assert row["date"] == "2026-09-27"              # swipe date inherited like the skew tier
    assert row["authorized_date"] == "2026-09-27"


@pytest.mark.parametrize("posted_amount, rows_left", [
    (Decimal("-105.00"), 1),   # exactly 5% over merges
    (Decimal("-105.01"), 2),   # one cent over leaves both
])
def test_skew_fee_merges_up_to_exactly_five_percent(lam, repo, posted_amount, rows_left):
    _fee_pending(repo, lam, amount=Decimal("-100.00"))

    repo.insert_or_reconcile([_fee_posted(lam, amount=posted_amount)])

    store = repo._table.store
    assert len(store) == rows_left
    assert (_acc(_fee_posted(lam)), "TXN#POST") in store


def test_skew_fee_single_word_merchant_does_not_merge(lam, repo):
    _fee_pending(repo, lam, amount=Decimal("-100.00"), description="Pending - NETFLIX",
                 merchant_name="NETFLIX")

    repo.insert_or_reconcile([_fee_posted(lam, amount=Decimal("-103.00"),
                                          description="NETFLIX", merchant_name="NETFLIX")])

    assert len(repo._table.store) == 2


def test_resend_after_a_skewed_fee_merge_keeps_the_day_and_category(lam, repo):
    # BankSync re-sends the settled row (UTC date again) for days. The merged row must
    # keep the pending's day and the user's category, and stay a single row.
    _fee_pending(repo, lam, notes="claude max")
    repo.insert_or_reconcile([_fee_posted(lam)])

    repo.insert_or_reconcile([_fee_posted(lam)])

    store = repo._table.store
    assert len(store) == 1
    row = next(iter(store.values()))
    assert row["date"] == "2026-09-27"
    assert row["authorized_date"] == "2026-09-27"
    assert row["category"] == "subs"
    assert row["notes"] == "claude max"
    assert row["amount"] == Decimal("-175.11")


def test_same_day_tip_twin_beats_a_skewed_fee_twin(lam, repo):
    _fee_pending(repo, lam, txn_id="SAMEDAY", amount=Decimal("-50.00"), authorized_date="2026-09-26",
                 category="same")
    _fee_pending(repo, lam, txn_id="NEXTDAY", amount=Decimal("-50.00"), authorized_date="2026-09-27",
                 category="next")

    repo.insert_or_reconcile([_fee_posted(lam, amount=Decimal("-51.00"))])

    store = repo._table.store
    acc = _acc(_fee_posted(lam))
    assert (acc, "TXN#SAMEDAY") not in store
    assert (acc, "TXN#NEXTDAY") in store
    assert store[(acc, "TXN#POST")]["category"] == "same"


def test_exact_skew_twin_beats_fee_candidate_across_the_batch(lam, repo):
    # The -51.00 posting comes first (lower id) and is a fee-sized candidate; the exact
    # skewed tier must still claim the pending for the -50.00 posting.
    _fee_pending(repo, lam, amount=Decimal("-50.00"))
    fee_first = _fee_posted(lam, txn_id="A51", amount=Decimal("-51.00"))
    exact_later = _fee_posted(lam, txn_id="B50", amount=Decimal("-50.00"))

    repo.insert_or_reconcile([fee_first, exact_later])

    store = repo._table.store
    acc = _acc(fee_first)
    assert (acc, "TXN#PEND") not in store
    assert len(store) == 2
    assert store[(acc, "TXN#B50")]["category"] == "subs"
    assert store[(acc, "TXN#B50")]["date"] == "2026-09-27"
    assert store[(acc, "TXN#A51")]["category"] == "GENERAL_SERVICES"
    assert store[(acc, "TXN#A51")]["date"] == "2026-09-26"


def test_exact_twin_beats_skew_candidate_across_the_batch(lam, repo):
    # One pending is posting X's exact twin AND posting Y's skew candidate. Y comes
    # first in the batch, but the exact pass must claim the pending for X regardless.
    _skew_pending(repo, lam, txn_id="PEND", authorized_date="2026-07-22")
    skew_first = _skew_posted(lam, txn_id="Y", authorized_date="2026-07-21")
    exact_later = _skew_posted(lam, txn_id="X", authorized_date="2026-07-22")

    repo.insert_or_reconcile([skew_first, exact_later])

    store = repo._table.store
    acc = _acc(skew_first)
    assert (acc, "TXN#PEND") not in store
    assert store[(acc, "TXN#X")]["category"] == "coffee"   # exact twin won the pending
    assert store[(acc, "TXN#Y")]["category"] == "FOOD_AND_DRINK"
    assert len(store) == 2


def test_skew_posting_wins_a_pending_contested_by_a_blank_auth_posting(lam, repo):
    # Both postings want the SAME pending: one is a skew match (exactly one day, tight),
    # the other a blank-auth match (anywhere in a 7-day window, loose). The tighter tier
    # must win, and the loser must insert plainly rather than steal it — put the loose one
    # first in the batch so a wrong tier order shows up.
    _skew_pending(repo, lam, txn_id="PEND", authorized_date="2026-07-22")
    loose = _skew_posted(lam, txn_id="LOOSE", authorized_date="", date="2026-07-24")
    tight = _skew_posted(lam, txn_id="TIGHT", authorized_date="2026-07-21")

    repo.insert_or_reconcile([loose, tight])

    store = repo._table.store
    acc = _acc(tight)
    assert (acc, "TXN#PEND") not in store                      # claimed exactly once
    assert store[(acc, "TXN#TIGHT")]["category"] == "coffee"   # tighter tier won it
    assert store[(acc, "TXN#LOOSE")]["category"] == "FOOD_AND_DRINK"
    assert len(store) == 2


def test_is_skewed_next_day_edges(lam):
    f = lam.reconcile._is_skewed_next_day
    # the real pair: pending (Melbourne) one day after the settled (UTC) day
    assert f("2026-07-22", "2026-07-21") is True
    assert f("2026-07-21", "2026-07-21") is False   # same day -> the exact tier's job
    assert f("2026-07-20", "2026-07-21") is False   # the clocks can't skew backwards
    assert f("2026-07-23", "2026-07-21") is False   # two days is not a clock split
    assert f("2026-08-01", "2026-07-31") is True    # month boundary
    assert f("2027-01-01", "2026-12-31") is True    # year boundary
    assert f("2028-03-01", "2028-02-29") is True    # leap day
    # a full timestamp still yields its date, and junk is never a skew
    assert f("2026-07-22T00:00:00+10:00", "2026-07-21") is True
    assert f("", "2026-07-21") is False
    assert f(None, "2026-07-21") is False
    assert f("2026-07-22", None) is False
    assert f("not-a-date", "2026-07-21") is False


# --- WHIT-331 QA gaps (adversarial) -----------------------------------------

_ISAN_PEND_DESC = "POS AUTHORISATION         ISAN THAI STREET FOOD     MELBOURNE   AU"


# [A13] / [A14] sign: the tier keys on EXACT amount equality, so it is sign-agnostic.


def test_skew_merge_reconciles_a_refund_pair(lam, repo):
    # A credit (positive amount) is dated off the same two clocks, so its pending twin
    # skews the same way and must still collapse to one row on the Melbourne day.
    _skew_pending(repo, lam, amount=Decimal("11.00"))

    repo.insert_or_reconcile([_skew_posted(lam, amount=Decimal("11.00"))])

    store = repo._table.store
    acc = _acc(_skew_posted(lam))
    assert (acc, "TXN#PEND") not in store
    assert len(store) == 1
    assert store[(acc, "TXN#POST")]["date"] == "2026-07-22"


def test_skew_tier_never_takes_a_refund_pending_for_a_purchase(lam, repo):
    # A +$11 refund and a -$11 purchase, same merchant, same skewed day. The refund
    # sorts FIRST by transaction_id; only exact amount equality (not magnitude) keeps
    # the purchase's posting off it.
    _skew_pending(repo, lam, txn_id="AAA_REFUND", amount=Decimal("11.00"))
    _skew_pending(repo, lam, txn_id="ZZZ_SPEND", amount=Decimal("-11.00"))

    repo.insert_or_reconcile([_skew_posted(lam, amount=Decimal("-11.00"))])

    store = repo._table.store
    acc = _acc(_skew_posted(lam))
    assert (acc, "TXN#ZZZ_SPEND") not in store      # the purchase's twin was consumed
    assert (acc, "TXN#AAA_REFUND") in store         # the refund is untouched


# [A15] a pending re-send arriving in the SAME payload as its skewed settlement.


def test_pending_resend_and_its_skewed_posting_in_one_payload_leave_one_row(lam, repo):
    # BankSync re-sends an open pending under the same id until it settles. A catch-up
    # payload can carry that re-send AND the settlement together, with the POSTED row
    # first — the delete of the stale pending runs after the inserts, so the re-sent
    # pending must not survive as a duplicate.
    _skew_pending(repo, lam, txn_id="PEND", category="coffee")
    resend = _norm(lam, txn_id="PEND", amount=Decimal("-11.00"), authorized_date="2026-07-22",
                   date="2026-07-22", pending=True, category="FOOD_AND_DRINK",
                   description=_SKEW_PEND_DESC, merchant_name="")

    repo.insert_or_reconcile([_skew_posted(lam), resend])   # posted FIRST

    store = repo._table.store
    acc = _acc(_skew_posted(lam))
    assert set(store) == {(acc, "TXN#POST")}        # exactly one row, the settled one
    assert store[(acc, "TXN#POST")]["date"] == "2026-07-22"
    assert store[(acc, "TXN#POST")]["category"] == "coffee"


# [A17] ragged inputs to the skew gate — names longer than the description, empty and
# whitespace-only names — must return False rather than raise.


def test_skew_gate_index_boundaries(lam):
    # The fused matcher's index-boundary guard, carried over to the gate that replaced
    # it: ragged inputs must return False, never raise.
    g = lam.reconcile.merchant_matches_pending
    # merchant LONGER than the whole description
    assert g("KKV INTERNATIONAL PTY LTD AUSTRALIA", "KKV INTERNATIONAL",
             "kkv international") is False
    # description exactly one word short of the merchant
    assert g("KKV INTERNATIONAL PTY", "KKV INTERNATIONAL", "kkv international") is False
    # empty / whitespace-only inputs on either side
    assert g("KKV INTERNATIONAL PTY", "", "") is False
    assert g("   ", "KKV INTERNATIONAL PTY", _SKEW_PEND_DESC) is False
    assert g("", "", "") is False
    # a truncated column is NOT a prefix match any more — the whole point of WHIT-336
    assert g("KKV INTERNATIONAL PTY LTD", "", _SKEW_PEND_DESC) is False


# --- Single-word merchants across the Melbourne/UTC split ---------------------
# clean_merchant strips trailing store numbers and processor prefixes, so plenty of
# real shops reduce to ONE word (COLES, MUJI, EASYPARK). Those were skipped by the
# skewed-date tier entirely, so an early-morning purchase at one of them duplicated
# until the age-out sweep. Strings below are the verbatim live shapes from
# tests/lambda/test_merchant.py — fixed-width columns, real store numbers.

_COLES_PEND_DESC = "POS AUTHORISATION         COLES 0602               MELBOURNE    AU"
_COLES_POST_DESC = "COLES 0602 MELBOURNE"
_COLES_POST_MERCHANT = "COLES 0602               "


def _coles_pending(repo, lam, txn_id="PEND", amount=Decimal("-63.40"),
                   authorized_date="2026-07-22", category="groceries",
                   description=_COLES_PEND_DESC):
    return _seed_pending(repo, lam, txn_id=txn_id, amount=amount,
                         authorized_date=authorized_date, date=authorized_date,
                         pending=True, category=category,
                         description=description, merchant_name="")


def _coles_posted(lam, txn_id="POST", amount=Decimal("-63.40"), authorized_date="2026-07-21",
                  date="2026-07-24", merchant_name=_COLES_POST_MERCHANT):
    return _norm(lam, txn_id=txn_id, amount=amount, authorized_date=authorized_date,
                 date=date, pending=False, category="FOOD_AND_DRINK",
                 description=_COLES_POST_DESC, merchant_name=merchant_name)


def test_one_word_merchant_skewed_pair_reconciles_and_keeps_the_melbourne_day(lam, repo):
    # The whole point of the card, on the real ANZ row shape: both sides clean to
    # "COLES", so the pair collapses to one row on the day it was actually swiped.
    _coles_pending(repo, lam)

    repo.insert_or_reconcile([_coles_posted(lam)])

    store = repo._table.store
    acc = _acc(_coles_posted(lam))
    assert (acc, "TXN#PEND") not in store
    assert len(store) == 1
    assert store[(acc, "TXN#POST")]["date"] == "2026-07-22"
    assert store[(acc, "TXN#POST")]["authorized_date"] == "2026-07-22"
    assert store[(acc, "TXN#POST")]["category"] == "groceries"


@pytest.mark.parametrize("label, damage", [
    # a row written before clean_merchant existed carries no merchant_name at all
    ("missing", lambda row: row.pop("merchant_name")),
    # clean_merchant can return "", and sanitise_transaction only strips None, so ""
    # persists. The gate reads `.get(...) or ""`, so both shapes arrive identically —
    # parametrized rather than duplicated to say so out loud.
    ("empty", lambda row: row.update(merchant_name="")),
])
def test_unusable_stored_merchant_name_is_recovered_from_the_anz_column(lam, repo,
                                                                        label, damage):
    # Since WHIT-336 an ANZ pending does not depend on the stored name — the name is read
    # straight out of the row's own fixed-width column — so this reconciles rather than
    # leaving a duplicate behind.
    pending = _coles_pending(repo, lam)
    damage(repo._table.store[(_acc(pending), "TXN#PEND")])

    repo.insert_or_reconcile([_coles_posted(lam)])

    assert len(repo._table.store) == 1, f"{label}: pending twin left behind"


def test_missing_merchant_name_on_a_non_anz_row_still_never_merges(lam, repo):
    # The other half of the control above: with no column to read and no stored name,
    # there is nothing to compare, so a single-word merchant must fail toward leaving
    # the pending alone rather than merging on the description alone.
    pending = _coles_pending(repo, lam, description="COLES 0602 MELBOURNE")
    del repo._table.store[(_acc(pending), "TXN#PEND")]["merchant_name"]

    repo.insert_or_reconcile([_coles_posted(lam)])

    assert len(repo._table.store) == 2


def test_one_word_merchant_still_does_not_tip_reconcile(lam, repo):
    # The tip tier keeps its own >=2-word rule: same day, tip-sized gap, one word.
    _coles_pending(repo, lam, authorized_date="2026-07-21", amount=Decimal("-63.40"))

    repo.insert_or_reconcile([_coles_posted(lam, authorized_date="2026-07-21",
                                            amount=Decimal("-70.00"))])

    assert len(repo._table.store) == 2


def test_same_cleaned_merchant_edges(lam):
    f = lam.merchant._same_cleaned_merchant
    # Both sides arrive already cleaned (banksync.normalise writes merchant_name through
    # clean_merchant on pending and posted alike), so this only has to absorb padding
    # and casing — not raw store numbers, which never reach it.
    assert f("COLES ", " COLES") is True            # fixed-width padding is irrelevant
    assert f("coles", "COLES") is True              # casing is irrelevant
    assert f("COLES 0602", "COLES") is False        # an UNcleaned name must not match
    assert f("COLES", "COLES EXPRESS") is False     # a different brand
    assert f("COLES EXPRESS", "COLES") is False     # and the reverse
    assert f("", "COLES") is False                  # underivable name never matches
    assert f("COLES", "") is False


def test_merchant_matches_pending_branches(lam):
    g = lam.reconcile.merchant_matches_pending
    # ANZ rows take the COLUMN branch (both of these), where the stored name is never
    # consulted — the name is read straight out of the fixed-width column
    assert g("KKV INTERNATIONAL PTY", "", _SKEW_PEND_DESC) is True
    assert g("COLES", "", _COLES_PEND_DESC.lower()) is True
    # a neighbouring brand in that column is not the same merchant
    assert g("COLES", "COLES", _pend_col("COLES EXPRESS 1157", "FOOTSCRAY")) is False
    # non-ANZ description -> the fallback. 1 word: the cleaned names must agree AND the
    # name must appear in the description; a description search alone is not enough
    assert g("COLES", "COLES", "COLES 0602 MELBOURNE") is True
    assert g("COLES", "COLES EXPRESS", "coles express 1157 footscray au") is False
    # non-ANZ, >=2 words: the description alone carries it (no stored name needed)
    assert g("HARERUYA PANTRY", "", "SQ *HARERUYA PANTRY       Carlton") is True


def test_gate_and_bool_agree_on_the_anz_shape_boundaries(lam):
    # WHIT-338 — the label and the bool now BOTH hinge on is_anz_pending vs
    # pending_merchant_column. Pin the two boundaries where an is_anz/column split would
    # silently flip a label from "column" to "name" (or admit a merge on nothing).
    g = lam.merchant._merchant_gate
    m = lam.reconcile.merchant_matches_pending
    # ANZ-shaped but the merchant column is BLANK (padding >= column width): the gate must
    # REFUSE, never fall through to a name/description containment search over the suburb.
    anz_blank = "POS AUTHORISATION" + " " * 30 + "AU"
    assert g("COLES", "COLES", anz_blank) is None
    assert m("COLES", "COLES", anz_blank) is False
    # a SINGLE space after the prefix is NOT column padding -> not ANZ -> the name branch.
    one_space = "POS AUTHORISATION COLES 0602 MELBOURNE"
    assert g("COLES", "COLES", one_space) == "name"
    assert m("COLES", "COLES", one_space) is True


def test_gate_name_branch_reconciles_end_to_end(lam, repo):
    # WHIT-338 — the name branch end to end: a single-word merchant on a NON-ANZ pending.
    # "LEAPTEL 1234" cleans to the one word "LEAPTEL", the row is not ANZ-shaped, so the
    # name-equality branch carries it.
    _seed_pending(repo, lam, txn_id="PEND", amount=Decimal("-30.00"),
                  authorized_date="2026-07-22", date="2026-07-22", pending=True,
                  category="internet", description="LEAPTEL 1234",
                  merchant_name="LEAPTEL 1234")
    posted = _norm(lam, txn_id="POST", amount=Decimal("-30.00"), authorized_date="2026-07-21",
                   date="2026-07-24", pending=False, category="GENERAL_SERVICES",
                   description="LEAPTEL 1234", merchant_name="LEAPTEL 1234")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#PEND") not in store          # twin reconciled — no double count
    assert len(store) == 1


def test_anz_column_overrides_a_stored_merchant_name_that_disagrees(lam, repo):
    # The row IS an ISAN THAI pending but carries a stored name of "COLES". Since
    # WHIT-336 the column is authoritative and the stored name is not consulted, so the
    # wrong name cannot buy a merge. Pinned in this direction because the failure that
    # matters is a WRONG merge, and a stored name is the field most likely to be wrong
    # (a legacy row, or ANZ starting to populate merchantName on pendings).
    pending = _coles_pending(repo, lam, description=_ISAN_PEND_DESC)
    repo._table.store[(_acc(pending), "TXN#PEND")]["merchant_name"] = "COLES"

    repo.insert_or_reconcile([_coles_posted(lam)])

    assert len(repo._table.store) == 2


# --- Single-word merchants: adversarial gaps (QA) ----------------------------
# The section above exercises COLES only. These cover the other named shops, the two
# whose real live shapes still miss, the wrong-pending ordering hazard the widened gate
# makes routine, the tie-break, refunds, the re-send guard, and the two log lines.


def _pend_col(merchant_col: str, suburb: str = "MELBOURNE") -> str:
    """A verbatim-shaped ANZ pending description: "POS AUTHORISATION" + padding, the
    25-character merchant column, then the suburb column and the country. Built rather
    than hand-spaced so a column width is never accidentally off by one."""
    return "POS AUTHORISATION" + " " * 9 + merchant_col.ljust(25) + suburb.ljust(13) + "AU"


def _posted_col(merchant_col: str) -> str:
    """A posted row's `merchantName`: the same merchant column, space-padded."""
    return merchant_col.ljust(25) + " "


@pytest.mark.parametrize("label, pending_col, posted_col", [
    ("woolworths", "WOOLWORTHS 1234", "WOOLWORTHS 1234"),
    ("mcdonalds", "McDonalds 951152", "McDonalds 951152"),
    ("officeworks", "OFFICEWORKS 0355", "OFFICEWORKS 0355"),
    ("easypark", "EASYPARK AU", "EASYPARK AU"),
    ("paystay", "PAYSTAY 1093482", "PAYSTAY 1093482"),
    ("leaptel", "LEAPTEL", "LEAPTEL"),
    ("amazon", "AMAZON RETA* AMAZON AU", "AMAZON RETA* AMAZON AU"),
    ("tesla", "TESLA", "TESLA"),
    ("parkable", "PARKABLE", "PARKABLE"),
    ("muji", "MUJI 1102", "MUJI 1102"),
])
def test_one_word_skew_merges_for_every_named_single_word_shop(lam, repo, label,
                                                               pending_col, posted_col):
    # COLES is the only shop the section above proves; without this the fix could be
    # silently COLES-shaped and deliver nothing for the rest.
    _seed_pending(repo, lam, txn_id="PEND", amount=Decimal("-8.25"),
                  authorized_date="2026-07-22", date="2026-07-22", pending=True,
                  category="groceries", merchant_name="",
                  description=_pend_col(pending_col))
    posted = _norm(lam, txn_id="POST", amount=Decimal("-8.25"), authorized_date="2026-07-21",
                   date="2026-07-24", pending=False, category="FOOD_AND_DRINK",
                   description=f"{posted_col} MELBOURNE", merchant_name=_posted_col(posted_col))

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#PEND") not in store, f"{label}: pending twin left behind"
    assert len(store) == 1, f"{label}: duplicated"
    assert store[(acc, "TXN#POST")]["date"] == "2026-07-22"
    assert store[(acc, "TXN#POST")]["category"] == "groceries"


def test_full_column_merchant_reconciles_and_near_names_still_miss(lam):
    # WHIT-336. WOOLWORTHS/330 MILLERS RD exactly fills the 25-char column, so it fused
    # onto the suburb and never reconciled. The positional slice recovers it. The
    # negatives below are what stops that from becoming a substring search — every pair
    # is two names that BOTH exist in the live table, and each is a DIFFERENT store, so
    # merging one would delete a real transaction.
    g = lam.reconcile.merchant_matches_pending
    # the fix: a full column no longer defeats the match
    assert g("WOOLWORTHS/330 MILLERS RD", "WOOLWORTHS/330 MILLERS RDMELBOURNE",
             _pend_col("WOOLWORTHS/330 MILLERS RD")) is True
    # real different-store pairs — a containment test merges all three, this must not
    assert g("CHEMIST WAREHOUSE", "", _pend_col("CHEMIST WAREHOUSE DARLING")) is False
    assert g("McDonalds", "", _pend_col("MCDONALDS SYD DOMEST")) is False
    assert g("WOOLWORTHS", "", _pend_col("WOOLWORTHS/330 MILLERS RD")) is False
    # a name truncated on ONE side only stays a miss (fail-safe: a leftover duplicate)
    assert g("MUJI RETAIL (AUSTRAL", "MUJI RETAIL AUSTRALIA",
             _pend_col("MUJI RETAIL AUSTRALIA")) is False
    assert g("KKV INTERNATIONAL PTY LTD", "", _pend_col("SQ *KKV INTERNATIONAL PTY")) is False
    # positive controls, so a reverted gate reds here too
    assert g("MUJI", "MUJI", _pend_col("MUJI 1102")) is True
    assert g("WOOLWORTHS", "WOOLWORTHS", _pend_col("WOOLWORTHS 1234")) is True
    assert g("KKV INTERNATIONAL PTY", "", _pend_col("SQ *KKV INTERNATIONAL PTY")) is True


def test_multi_word_non_anz_pending_with_no_stored_name_still_reconciles(lam, repo):
    # On the live table (queried 2026-07-25) 75 rows carry an empty merchant_name and
    # NONE of them is an ANZ shape, so the non-ANZ fallback must keep matching on the
    # description alone. Tightening it to name equality silently stops 108 live pairs
    # reconciling — this is the fail-on-revert anchor for that. Shape and name are
    # verbatim from that table.
    pending = _seed_pending(
        repo, lam, txn_id="PEND", amount=Decimal("-42.00"), authorized_date="2026-07-22",
        date="2026-07-22", pending=True, category="shopping", merchant_name="",
        description="SQ *HARERUYA PANTRY       Carlton",
    )
    repo._table.store[(_acc(pending), "TXN#PEND")]["merchant_name"] = ""
    posted = _norm(lam, txn_id="POST", amount=Decimal("-42.00"), authorized_date="2026-07-21",
                   date="2026-07-24", pending=False, category="FOOD_AND_DRINK",
                   description="SQ *HARERUYA PANTRY       Carlton",
                   merchant_name="SQ *HARERUYA PANTRY       ")

    repo.insert_or_reconcile([posted])

    assert len(repo._table.store) == 1


def test_one_word_tie_break_takes_the_lowest_id_and_carries_only_its_fields(lam, repo):
    first = _norm(lam, txn_id="AAA", amount=Decimal("-63.40"), authorized_date="2026-07-22",
                  date="2026-07-22", pending=True, category="groceries",
                  description=_COLES_PEND_DESC, merchant_name="")
    first["notes"] = "milk run"
    first["tags"] = ["weekly"]
    second = _norm(lam, txn_id="ZZZ", amount=Decimal("-63.40"), authorized_date="2026-07-22",
                   date="2026-07-22", pending=True, category="lunch",
                   description=_COLES_PEND_DESC, merchant_name="")
    second["notes"] = "birthday cake"
    repo.insert_transactions([first, second])

    repo.insert_or_reconcile([_coles_posted(lam)])

    store = repo._table.store
    acc = _acc(_coles_posted(lam))
    assert (acc, "TXN#AAA") not in store            # lowest id, deterministically
    assert store[(acc, "TXN#ZZZ")]["notes"] == "birthday cake"
    row = store[(acc, "TXN#POST")]
    assert row["category"] == "groceries"           # only the consumed row's fields ride
    assert row["notes"] == "milk run"
    assert row["tags"] == ["weekly"]


# ======================================================================================
# Folded from per-ticket reconcile satellites (WHIT-452 Slice 1). Bodies moved verbatim;
# the duplicated local _bank_row/_norm/_acc copies were dropped in favour of this file's
# canonical helpers above (identical defaults).
# ======================================================================================


# --- WHIT-275: with_carried_category tag/note conflict resolution --------------------
# (was test_reconcile_whit275_gaps.py) Carry guard is `if value:` — a truthy SOURCE
# (pending) value overwrites the posted's own; a falsy/absent source never clobbers.


def test_carried_absent_source_tags_keep_the_posted_existing_tags(lam, repo):  # [A15]
    # The mirror: when the source has NO tags, the posted's own survive (falsy/absent
    # source never clobbers a real value).
    posted = {"transaction_id": "B", "category": "FOOD", "tags": ["keep"]}
    source = {"category": "coffee"}  # no tags/notes

    carried = lam.reconcile.with_carried_category(posted, source)

    assert carried["tags"] == ["keep"]
    assert carried["category"] == "coffee"


# --- WHIT-296: budget_excluded survives the LIVE reconcile (insert_or_reconcile) ------
# (was test_reconcile_whit296_live.py) budget_excluded is not a bank field (normalise
# strips it), so — like the note/tag reconcile tests — it's injected onto the stored row.
# Fail-on-revert: drop "budget_excluded" from the carry tuple in with_carried_category.


def test_reconcile_carries_budget_excluded_onto_posted(lam, repo):
    # WHIT-296 — [A-R1] the user marked the PENDING leg as a transfer; on settlement the
    # override must ride onto the new posted row (whose bank feed knows nothing of it),
    # and the stale pending must be deleted.
    pending = _norm(lam, txn_id="A", amount=Decimal("-5.50"), pending=True, category="coffee")
    repo.insert_transactions([pending])
    acc = _acc(pending)
    repo._table.store[(acc, "TXN#A")]["budget_excluded"] = True

    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([posted])

    row = repo._table.store[(acc, "TXN#B")]
    assert row["budget_excluded"] is True            # override carried onto the posted
    assert (acc, "TXN#A") not in repo._table.store   # stale pending removed
    assert len(repo._table.store) == 1               # no duplicate


def test_blank_auth_tie_break_consumes_lowest_transaction_id(lam, repo):
    # WHIT-333 e2e (was test_reconcile_whit333_e2e.py): two indistinguishable blank-auth
    # pendings (same amount, >=2-word merchant, in-window date). Exactly one may die and it
    # must be the lowest id (A1) — the deterministic pick the shared _pop_lowest_id makes.
    _seed_pending(repo, lam, txn_id="A2", amount=Decimal("-5.50"),
                  authorized_date="", pending=True, category="treats")
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A1") not in store              # lowest id consumed via _select_twin
    assert (acc, "TXN#A2") in store                  # the other survives untouched
    assert store[(acc, "TXN#A2")]["category"] == "treats"
    assert store[(acc, "TXN#B")]["category"] == "coffee"   # A1's category carried across
    assert len(store) == 2                                  # exactly one pending consumed


# --- WHIT-513: partial update — re-sends only touch bank-owned fields --------


def test_pending_resync_updates_bank_fields(lam, repo):
    # Bank-owned fields (description, merchant_name, amount, etc.) MUST be updated
    # even though user fields are preserved.
    seeded = _seed_pending(repo, lam, txn_id="A", amount=Decimal("-260.00"),
                           pending=True, category="health",
                           description="SQ *OLD MERCHANT", merchant_name="SQ *OLD MERCHANT")
    acc = _acc(seeded)

    resent = _norm(lam, txn_id="A", amount=Decimal("-265.00"),
                   pending=True, category="FOOD_AND_DRINK",
                   description="SQ *NEW MERCHANT", merchant_name="SQ *NEW MERCHANT")
    repo.insert_or_reconcile([resent])

    row = repo._table.store[(acc, "TXN#A")]
    assert row["amount"] == Decimal("-265.00")
    assert row["category"] == "health"  # user field untouched


def test_posted_resync_preserves_category_via_partial_update(lam, repo):
    # A re-import of an already-stored posted row must keep the user's category.
    # Regression guard: all four user-owned fields must survive a posted re-sync.
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   pending=False, category="Groceries")
    repo.insert_transactions([posted])
    acc = _acc(posted)
    repo._table.store[(acc, "TXN#B")]["category"] = "coffee"
    repo._table.store[(acc, "TXN#B")]["notes"] = "weekly shop"
    repo._table.store[(acc, "TXN#B")]["tags"] = ["food"]
    repo._table.store[(acc, "TXN#B")]["budget_excluded"] = True

    reimport = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                     pending=False, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([reimport])

    row = repo._table.store[(acc, "TXN#B")]
    assert row["category"] == "coffee"
    assert row["notes"] == "weekly shop"
    assert row["tags"] == ["food"]
    assert row["budget_excluded"] is True


def test_settlement_re_reads_twin_with_consistent_read(lam, repo):
    # The first-time settlement path re-reads the twin with ConsistentRead=True to
    # close the race window between pool scan and carry.
    pending = _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                            authorized_date="2026-06-29", pending=True, category="coffee")

    table = repo._table
    consistent_reads = []
    orig_get = table.get_item

    def tracking_get(Key, ConsistentRead=False):
        consistent_reads.append(ConsistentRead)
        return orig_get(Key, ConsistentRead=ConsistentRead)

    table.get_item = tracking_get

    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([posted])

    # The first get_item is the resync-check (eventually consistent), the second is
    # _refresh_carried_fields (must be ConsistentRead=True).
    assert True in consistent_reads


def test_posted_resync_falls_back_to_insert_when_row_vanishes(lam, repo):
    # A posted re-sync whose stored row vanishes between get_transaction and
    # _update_bank_fields must fall back to insert (not crash).
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   pending=False, category="Groceries")
    repo.insert_transactions([posted])
    acc = _acc(posted)

    table = repo._table
    orig_update = table.update_item

    def sabotaging_update(*a, **kw):
        table.store.pop((acc, "TXN#B"), None)
        return orig_update(*a, **kw)

    table.update_item = sabotaging_update

    resync = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   pending=False, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([resync])

    assert (acc, "TXN#B") in repo._table.store
    assert repo._table.store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"


def test_batch_mixes_pending_resend_posted_resync_and_settlement(lam, repo):
    # A batch containing all three WHIT-513 paths must handle each correctly.
    pending_resend = _seed_pending(repo, lam, txn_id="PR", amount=Decimal("-10.00"),
                                   pending=True, category="transport")
    acc = _acc(pending_resend)
    repo._table.store[(acc, "TXN#PR")]["notes"] = "uber to work"

    posted_resync = _norm(lam, txn_id="RS", amount=Decimal("-20.00"),
                          pending=False, category="Groceries")
    repo.insert_transactions([posted_resync])
    repo._table.store[(acc, "TXN#RS")]["category"] = "weekly shop"
    repo._table.store[(acc, "TXN#RS")]["budget_excluded"] = True

    _seed_pending(repo, lam, txn_id="SP", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")

    batch = [
        _norm(lam, txn_id="PR", amount=Decimal("-10.00"),
              pending=True, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="RS", amount=Decimal("-20.00"),
              pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="NEW", amount=Decimal("-5.50"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]
    repo.insert_or_reconcile(batch)

    store = repo._table.store
    assert store[(acc, "TXN#PR")]["category"] == "transport"
    assert store[(acc, "TXN#PR")]["notes"] == "uber to work"
    assert store[(acc, "TXN#RS")]["category"] == "weekly shop"
    assert store[(acc, "TXN#RS")]["budget_excluded"] is True
    assert store[(acc, "TXN#NEW")]["category"] == "coffee"
    assert (acc, "TXN#SP") not in store


# --- WHIT-536 GAP: the stamp through the FULL reconcile path (not the helper in isolation) ---

def _rule_stamped(txn, rule_id):
    txn["filed_by_rule"] = rule_id
    return txn


# [G1] [A13] End-to-end: a RULE-filed pending settles onto its posted twin -> the stored posted
# row keeps BOTH the carried category and the rule stamp. FAIL-ON-REVERT: drop the carry block
# in with_carried_category and the stamp is gone from the settled row.
def test_whit536_rule_filed_pending_settles_and_posted_keeps_the_stamp(lam, repo):
    pending = _norm(lam, txn_id="A", amount=Decimal("-5.50"), pending=True, category="groceries")
    _rule_stamped(pending, "rule-7")
    repo.insert_transactions([pending])
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    row = repo._table.store[(_acc(posted), "TXN#B")]
    assert row["category"] == "groceries"
    assert row["filed_by_rule"] == "rule-7"
    assert (_acc(posted), "TXN#A") not in repo._table.store   # stale pending removed


# [G3] [A14] End-to-end: a HAND-filed pending (category, NO stamp) settles onto a posted twin
# that arrived rule-stamped (rule_ingest stamps unfiled incoming). The hand-filed category wins
# the carry, so the posted's own stamp must be STRIPPED — no unexplained "a rule filed this" on a
# row the user filed. FAIL-ON-REVERT: drop the else/pop branch and "rule-1" survives.
def test_whit536_hand_filed_pending_settles_and_strips_incoming_stamp(lam, repo):
    pending = _norm(lam, txn_id="A", amount=Decimal("-5.50"), pending=True, category="groceries")
    repo.insert_transactions([pending])                       # hand-filed: category, no stamp
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False, category="FOOD_AND_DRINK")
    _rule_stamped(posted, "rule-1")                           # rule_ingest stamped the incoming posted

    repo.insert_or_reconcile([posted])

    row = repo._table.store[(_acc(posted), "TXN#B")]
    assert row["category"] == "groceries"
    assert "filed_by_rule" not in row


# --- WHIT-545: a stored unfiled raw category must not clobber a rule-fill; recompute the flag ---

def _unfiled_check(taxonomy_ids):
    """Stand-in for the reconcile's taxonomy check (rule_engine.is_unfiled_category for the
    non-income case the reconcile carry sees): a category is unfiled when it is not one of the
    user's real categories."""
    def is_unfiled(category):
        return category not in taxonomy_ids
    return is_unfiled


def test_whit545_settlement_unfiled_twin_does_not_clobber_the_rule_fill(lam, repo):
    # End-to-end through insert_or_reconcile: a pending holds the bank's raw enum, the incoming
    # posted was rule-filled. The stored posted keeps the rule category + stamp, its flag
    # matches, and the stale pending is gone. FAIL-ON-REVERT: drop the gate -> raw enum wins.
    pending = _norm(lam, txn_id="A", amount=Decimal("-5.50"), pending=True, category="FOOD_AND_DRINK")
    repo.insert_transactions([pending])
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"), pending=False, category="groceries")
    posted["filed_by_rule"] = "rule-1"

    repo.insert_or_reconcile([posted], is_unfiled=_unfiled_check({"groceries"}))

    row = repo._table.store[(_acc(posted), "TXN#B")]
    assert row["category"] == "groceries"
    assert row["filed_by_rule"] == "rule-1"
    assert row["counts_to_budget"] is True
    assert (_acc(posted), "TXN#A") not in repo._table.store


# ============================================================================
# WHIT-545 QA GAP TESTS (adversarial half — not duplicating the implementer's four)
# ============================================================================


class _QANoTokensDevice:
    def list_tokens(self):
        return []


# [A7] End-to-end through process_transaction: the handler must thread the taxonomy check
# returned by rule_ingest.apply into insert_or_reconcile. A pending twin holds the raw enum; the
# incoming posted is rule-filled by the user's KKV rule. FAIL-ON-REVERT: change handler.py's
# insert_or_reconcile call to is_unfiled=None and the raw enum clobbers the rule-fill.
def test_whit545_handler_threads_is_unfiled_end_to_end(lam, repo, monkeypatch):
    h = lam.handler
    monkeypatch.setattr(h, "RuleRepository",
                        lambda: FakeRuleStore([KKV_RULE]))
    monkeypatch.setattr(h, "CategoryRepository", lambda: FakeCategoryRepo(["groceries"]))
    # Neutralise the budget-alert side path (no device tokens -> capture returns None early).
    monkeypatch.setattr(h, "DeviceRepository", lambda: _QANoTokensDevice())
    monkeypatch.setattr(h, "BudgetRepository", lambda: None)
    monkeypatch.setattr(h, "PayCycleRepository", lambda: None)
    monkeypatch.setattr(h, "NotifyRepository", lambda: None)

    _seed_pending(repo, lam, txn_id="P", amount=Decimal("-5.50"), authorized_date="2026-06-29",
                  pending=True, category="FOOD_AND_DRINK")
    payload = {"data": [_bank_row("POST", Decimal("-5.50"), authorized_date="2026-06-29",
                                  pending=False, category="FOOD_AND_DRINK")]}

    h.process_transaction(payload, repo)

    row = repo._table.store[(_acc(_norm(lam, txn_id="POST", amount=Decimal("-5.50"))), "TXN#POST")]
    assert row["category"] == "groceries"                        # rule-fill survives settlement
    assert (_acc(_norm(lam, txn_id="P", amount=Decimal("-5.50"))), "TXN#P") not in repo._table.store
