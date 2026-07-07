"""Tests for pending→posted reconciliation in the BankSync webhook
(`TransactionRepository.insert_or_reconcile`) and its wiring in `process_transaction`.

Real data drives the scenarios: on settlement BankSync issues a NEW id with
`pendingTransactionId: null` (e.g. pending b726e693 → posted 14e463, both
authorizedDate 2026-06-29, -5.50), so a blind insert would leave a duplicate and
lose the user's category. These tests build rows through `BankSyncClient.normalise`
so the stored shapes match production, and inject a FakeTable via `repo._table`.
"""

from decimal import Decimal

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
    return lam.banksync.BankSyncClient.normalise(_bank_row(**kw))


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


def test_no_match_inserts_posted_normally(lam, repo):
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    assert store[(_acc(posted), "TXN#B")]["category"] == "FOOD_AND_DRINK"
    assert len(store) == 1


def test_same_id_resync_preserves_user_category(lam, repo):
    # A posted row already stored + user-categorised.
    _seed_pending(repo, lam, txn_id="B", amount=Decimal("-5.50"),
                  pending=False, category="Groceries")
    # The same posted id re-syncs with the bank's raw category.
    resync = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([resync])

    store = repo._table.store
    assert store[(_acc(resync), "TXN#B")]["category"] == "Groceries"  # not clobbered
    assert len(store) == 1                                             # not duplicated/deleted


# --- accepted edges (documented behaviour) ----------------------------------


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


def test_tip_at_headroom_boundary_reconciles(lam, repo):
    # Exactly auth * 1.25 is inside the headroom (inclusive).
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-4.00"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.00"),   # 4.00 * 1.25 = 5.00
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"


def test_tip_just_over_headroom_leaves_both(lam, repo):
    # A jump beyond +25% (5.50 -> 7.00) is too big to be a tip → miss → duplicate
    # persists (the regression guard that a large amount change still does NOT merge).
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-7.00"),   # 5.50 * 1.25 = 6.875 < 7.00
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store                                    # pending survives
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"      # no carry


def test_refund_not_swept_as_settlement(lam, repo):
    # A refund/credit is a POSITIVE amount. Even same day + same merchant + matching
    # magnitude, it must NOT be treated as the settlement of a pending spend (the
    # same-sign guard) — otherwise a refund would delete the pending and mis-carry.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("5.50"),          # positive = refund
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store                                    # pending untouched
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"
    assert len(store) == 2


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


def test_tip_candidate_without_merchant_match_inserts_plainly(lam, repo):
    # Same day + within-headroom amount but a genuinely different merchant whose words
    # are NOT in the pending description → no tip match → the posted just inserts.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")  # KKV desc
    posted = _norm(
        lam, txn_id="B", amount=Decimal("-6.00"), authorized_date="2026-06-29",
        pending=False, category="FOOD_AND_DRINK", merchant_name="WOOLWORTHS 1234",
        description="WOOLWORTHS 1234          MELBOURNE",
    )

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store                                    # KKV pending survives
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


def test_tip_tie_break_lowest_transaction_id(lam, repo):
    # Two identical tip-eligible pendings; the posted consumes exactly one,
    # deterministically the lowest transaction_id.
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    _seed_pending(repo, lam, txn_id="A2", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-6.00"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A1") not in store                              # lowest id consumed
    assert (acc, "TXN#A2") in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"


def test_empty_authorized_date_does_not_match(lam, repo):
    # Missing authorizedDate is not a match key → no false-positive reconcile.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"


# --- same-day identical purchases (Jasmine's daily coffee) -------------------


def test_two_same_day_identical_reconciles_exactly_one(lam, repo):
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    _seed_pending(repo, lam, txn_id="A2", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    # consume-on-match: exactly one pending consumed; deterministic (lowest id A1).
    assert (acc, "TXN#A1") not in store
    assert (acc, "TXN#A2") in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"


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


# --- handler wiring ---------------------------------------------------------


def test_process_transaction_uses_insert_or_reconcile(lam):
    calls = {}

    class FakeRepo:
        def save_failed_transactions(self, rows):
            calls["failed"] = rows

        def insert_or_reconcile(self, txns):
            calls["reconcile"] = txns

        def insert_transactions(self, txns):
            calls["insert"] = txns

    bad_row = {"id": "X", "accountId": "unknown-account"}  # missing fields -> unmapped
    payload = {"data": [_bank_row("A", Decimal("-5.50"), pending=False), bad_row]}

    lam.handler.process_transaction(payload, FakeRepo())

    assert "reconcile" in calls and "insert" not in calls   # swapped to the new path
    assert len(calls["reconcile"]) == 1                      # the one good row normalised
    assert calls["failed"] == [bad_row]                      # the bad row diverted


# --- consume-on-match across a batch (locks the pool.pop) --------------------


def test_two_posted_consume_two_identical_pendings_in_one_batch(lam, repo):
    _seed_pending(repo, lam, txn_id="A1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    _seed_pending(repo, lam, txn_id="A2", amount=Decimal("-5.50"),
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
    # Each posted popped a DISTINCT pending — both consumed, both posted carry the tag.
    assert (acc, "TXN#A1") not in store
    assert (acc, "TXN#A2") not in store
    assert store[(acc, "TXN#B")]["category"] == "coffee"
    assert store[(acc, "TXN#C")]["category"] == "coffee"
    assert len(store) == 2  # only the two posted rows remain


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


def test_empty_batch_is_a_noop(lam, repo):
    repo.insert_or_reconcile([])
    assert repo._table.store == {}
    assert repo._table.query_calls == 0


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


def test_partial_settlement_smaller_than_auth_does_not_merge(lam, repo):
    # FX / partial settlement: the posted amount is SMALLER than the auth (a tip only
    # makes spend larger). Same merchant + same day, but one-directional headroom must
    # refuse it — otherwise a partial settlement would delete the real pending.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-20.00"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-19.00"),   # magnitude 19 < 20
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store                                    # pending untouched
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"      # no carry
    assert len(store) == 2                                            # no merge


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
    # tier would try _is_tip_adjusted(item["amount"], ...) and raise. Must not crash,
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


def test_truncated_merchant_word_does_not_over_or_under_match(lam, repo):
    # The bank truncates the merchant column mid-word ("MUJI RETAIL (AUSTRAL"). The
    # auth carries the full word ("AUSTRALIA"). Word-level matching requires the LAST
    # word to match exactly, so "austral" != "australia" -> no merge (fail-SAFE: a
    # leftover duplicate, never a wrong merge). Also guards a substring regression.
    _seed_pending(
        repo, lam, txn_id="A", amount=Decimal("-30.00"), authorized_date="2026-06-29",
        pending=True, category="shopping", merchant_name="",
        description="POS AUTHORISATION         MUJI RETAIL AUSTRALIA     MELBOURNE    AU",
    )
    posted = _norm(
        lam, txn_id="B", amount=Decimal("-32.00"), authorized_date="2026-06-29",
        pending=False, category="FOOD_AND_DRINK", merchant_name="MUJI RETAIL (AUSTRAL",
        description="MUJI RETAIL (AUSTRAL      MELBOURNE",
    )

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") in store                                   # not swept
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"
    assert len(store) == 2


def test_tip_match_empty_pending_category_keeps_bank_category(lam, repo):
    # Tip path with an uncategorised pending: still de-dupes (pending deleted), but the
    # posted keeps its own bank category rather than carrying an empty one.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="")
    posted = _norm(lam, txn_id="B", amount=Decimal("-6.00"),   # tip within headroom, KKV
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store                              # de-duped
    assert store[(acc, "TXN#B")]["category"] == "FOOD_AND_DRINK"    # empty not carried
    assert len(store) == 1


def test_tip_tier_still_queries_pool_once_per_account(lam, repo):
    # The tip tier must reuse the per-account pending pool, not re-scan. Batch: a tip
    # settlement + an unrelated posted for the SAME account -> exactly one query.
    _seed_pending(repo, lam, txn_id="P", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    repo._table.query_calls = 0

    batch = [
        _norm(lam, txn_id="B", amount=Decimal("-6.00"),   # tip-settles P (tier 3)
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="D", amount=Decimal("-3.00"),   # no match, same account
              authorized_date="2026-07-02", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert (acc, "TXN#P") not in store                              # tip-settled + deleted
    assert store[(acc, "TXN#B")]["category"] == "coffee"
    assert repo._table.query_calls == 1                             # pool fetched once


def test_exact_and_tip_compete_for_one_pending_consumed_once(lam, repo):
    # One pending -5.50. Two posted rows target it in the same batch: an EXACT -5.50
    # (tier 2) and a tip -6.00 (tier 3). Whichever runs first pops the single pending;
    # the other must fall through to a plain insert. Money-safety invariant: the pending
    # is consumed EXACTLY once (never double-deleted, never claimed twice).
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    batch = [
        _norm(lam, txn_id="B", amount=Decimal("-5.50"),   # exact twin, processed first
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="C", amount=Decimal("-6.00"),   # tip twin, pool now empty
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert (acc, "TXN#A") not in store                              # consumed once
    assert store[(acc, "TXN#B")]["category"] == "coffee"           # exact twin carried it
    assert store[(acc, "TXN#C")]["category"] == "FOOD_AND_DRINK"   # no pending left -> plain
    assert len(store) == 2                                          # no duplicate/ghost


# --- WHIT-117: exact twin must not be starved by a tip sibling across rows ---
# The companion of test_exact_and_tip_compete_for_one_pending_consumed_once (which
# runs the BENIGN order, exact-first). Here the tip-eligible posting is FIRST. On the
# old single-pass code it popped the one pending via the tip tier, so the exact posting
# behind it inserted UNCATEGORISED. The two-pass resolves all exact twins before any tip,
# so the exact posting wins its category regardless of batch order.


def test_tip_first_does_not_starve_exact_twin(lam, repo):
    # One pending -5.50 "coffee". Batch order: tip -6.00 FIRST, exact -5.50 SECOND.
    # Fail-on-revert: on the single-pass code the -6.00 tip-pops the pending first, so
    # -5.50 (B) inserts uncategorised — this asserts B carries "coffee".
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    batch = [
        _norm(lam, txn_id="C", amount=Decimal("-6.00"),   # tip-eligible for A, processed FIRST
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="B", amount=Decimal("-5.50"),   # EXACT twin of A, processed SECOND
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert (acc, "TXN#A") not in store                              # consumed once
    assert store[(acc, "TXN#B")]["category"] == "coffee"           # exact twin won it
    assert store[(acc, "TXN#C")]["category"] == "FOOD_AND_DRINK"   # tip sibling -> plain insert
    assert len(store) == 2                                          # no duplicate/ghost


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
        return lam.banksync.BankSyncClient.normalise(row)

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


def test_two_pass_three_way_two_pendings_three_postings(lam, repo):
    # GAP: two pendings, three postings, cross-eligible. X1 -5.50 "coffee" is the exact
    # twin of E1 AND the tip twin of T1 (-6.00). X2 -10.00 "dinner" is the exact twin of
    # E2. Batch order puts the TIP posting first.
    #   two-pass (correct): E1 exact-claims X1, E2 exact-claims X2 in pass 1; T1's tip
    #     finds an empty pool in pass 2 -> plain insert. Both exacts keep their category.
    #   single-pass (revert): T1 tip-claims X1 first -> E1 inserts UNCATEGORISED.
    _seed_pending(repo, lam, txn_id="X1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    _seed_pending(repo, lam, txn_id="X2", amount=Decimal("-10.00"),
                  authorized_date="2026-06-29", pending=True, category="dinner")
    batch = [
        _norm(lam, txn_id="T1", amount=Decimal("-6.00"),   # tip-eligible for X1, FIRST
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="E1", amount=Decimal("-5.50"),   # EXACT twin of X1
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="E2", amount=Decimal("-10.00"),  # EXACT twin of X2
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert store[(acc, "TXN#E1")]["category"] == "coffee"          # exact twin won it
    assert store[(acc, "TXN#E2")]["category"] == "dinner"          # its exact twin too
    assert store[(acc, "TXN#T1")]["category"] == "FOOD_AND_DRINK"  # tip sibling -> plain
    assert (acc, "TXN#X1") not in store                            # each pending consumed
    assert (acc, "TXN#X2") not in store                            #   exactly once
    assert len(store) == 3                                         # no duplicate/ghost


def test_pending_exact_for_one_and_tip_for_two_goes_to_exact(lam, repo):
    # GAP: ONE pending X -5.50 "coffee" that is the exact twin of E and tip-eligible for
    # TWO postings (T1 -6.00, T2 -6.50, both same day+merchant, within +25%). Both tips
    # are ahead of the exact in the batch.
    #   two-pass: E exact-claims X in pass 1; both tips hit an empty pool -> plain.
    #   single-pass (revert): T1 tip-claims X, E inserts uncategorised.
    _seed_pending(repo, lam, txn_id="X", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    batch = [
        _norm(lam, txn_id="T1", amount=Decimal("-6.00"),
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="T2", amount=Decimal("-6.50"),  # 5.50*1.25 = 6.875, still in
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="E", amount=Decimal("-5.50"),   # EXACT twin, processed LAST
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert store[(acc, "TXN#E")]["category"] == "coffee"
    assert store[(acc, "TXN#T1")]["category"] == "FOOD_AND_DRINK"
    assert store[(acc, "TXN#T2")]["category"] == "FOOD_AND_DRINK"
    assert (acc, "TXN#X") not in store
    assert len(store) == 3


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


def test_lone_tip_still_matches_in_pass_two_within_batch(lam, repo):
    # GAP (pass 2 on a pool pass 1 already popped from): E exact-settles X1 in pass 1;
    # T is a lone tip of X2 with NO exact sibling anywhere. The tip must still reconcile
    # in pass 2 against the pool that pass 1 partially emptied.
    _seed_pending(repo, lam, txn_id="X1", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    _seed_pending(repo, lam, txn_id="X2", amount=Decimal("-8.00"),
                  authorized_date="2026-06-29", pending=True, category="lunch")
    batch = [
        _norm(lam, txn_id="E", amount=Decimal("-5.50"),   # exact twin of X1
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="T", amount=Decimal("-9.00"),   # tip of X2 (8*1.25=10), no exact
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert store[(acc, "TXN#E")]["category"] == "coffee"
    assert store[(acc, "TXN#T")]["category"] == "lunch"   # pass-2 tip fired on shared pool
    assert (acc, "TXN#X1") not in store
    assert (acc, "TXN#X2") not in store
    assert len(store) == 2


def test_resync_and_interleaved_pending_end_state(lam, repo):
    # GAP (precomputed matches replayed via next(), with pending/posted interleaved). A
    # posted resync produces a None match and a NEW pending row consumes NO match slot.
    # This is an END-STATE guard: resync keeps the user category, the exact settle carries,
    # the interleaved pending inserts. (It does NOT independently lock iterator alignment —
    # the defensive `next(..., (None, None))` default would mask a misadvance into this same
    # end-state.) Batch: [P exact-settles X] , [NP a brand-new pending] , [B same-id resync].
    _seed_pending(repo, lam, txn_id="X", amount=Decimal("-5.50"),
                  authorized_date="2026-06-29", pending=True, category="coffee")
    # B already stored as a POSTED, user-categorised row (the resync target).
    _seed_pending(repo, lam, txn_id="B", amount=Decimal("-9.99"),
                  authorized_date="2026-06-29", pending=False, category="Groceries")
    batch = [
        _norm(lam, txn_id="P", amount=Decimal("-5.50"),   # exact twin of X
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
        _norm(lam, txn_id="NP", amount=Decimal("-3.00"),  # interleaved NEW pending
              authorized_date="2026-06-29", pending=True, category="misc"),
        _norm(lam, txn_id="B", amount=Decimal("-9.99"),   # same-id resync, raw category
              authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert store[(acc, "TXN#P")]["category"] == "coffee"      # exact settle carried
    assert store[(acc, "TXN#B")]["category"] == "Groceries"   # resync kept user category
    assert store[(acc, "TXN#NP")]["category"] == "misc"       # interleaved pending inserted
    assert (acc, "TXN#X") not in store                        # settled pending removed
    assert len(store) == 3


def test_reconcile_matches_empty_and_all_pending_batch(lam, repo):
    # GAP (degenerate): _reconcile_matches over an empty posted list is []. An all-pending
    # batch builds an empty match iterator, so the loop must insert every pending without
    # calling next() (a StopIteration here would 500 the webhook).
    assert repo._reconcile_matches([], {}) == []

    batch = [
        _norm(lam, txn_id="Q1", amount=Decimal("-1.00"),
              authorized_date="2026-06-29", pending=True, category="a"),
        _norm(lam, txn_id="Q2", amount=Decimal("-2.00"),
              authorized_date="2026-06-29", pending=True, category="b"),
    ]

    repo.insert_or_reconcile(batch)

    store = repo._table.store
    acc = _acc(batch[0])
    assert store[(acc, "TXN#Q1")]["category"] == "a"
    assert store[(acc, "TXN#Q2")]["category"] == "b"
    assert len(store) == 2


# --- direct locks on the new pure helpers -----------------------------------


def test_is_tip_adjusted_edges(lam):
    f = lam.repository._is_tip_adjusted
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
    g = lam.repository._merchant_in_description
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
