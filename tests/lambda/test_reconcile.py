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
