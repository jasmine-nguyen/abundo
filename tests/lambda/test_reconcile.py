"""Tests for pending→posted reconciliation in the BankSync webhook
(`TransactionRepository.insert_or_reconcile`) and its wiring in `process_transaction`.

Real data drives the scenarios: on settlement BankSync issues a NEW id with
`pendingTransactionId: null` (e.g. pending b726e693 → posted 14e463, both
authorizedDate 2026-06-29, -5.50), so a blind insert would leave a duplicate and
lose the user's category. These tests build rows through `BankSyncClient.normalise`
so the stored shapes match production, and inject a FakeTable via `repo._table`.
"""

from decimal import Decimal

import pytest

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


def test_reconcile_does_not_carry_an_empty_note(lam, repo):
    # A cleared/absent note on the pending must NOT overwrite — the truthy carry
    # guard means the posted keeps its own (here: no note).
    pending = _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                            authorized_date="2026-06-29", pending=True, category="coffee")
    acc = _acc(pending)
    repo._table.store[(acc, "TXN#A")]["notes"] = ""  # cleared

    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="2026-06-29", pending=False, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([posted])

    assert "notes" not in repo._table.store[(acc, "TXN#B")]  # empty note not carried


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


# --- WHIT-329: a still-pending re-send under the same id keeps the user's fields ------


def test_pending_resync_preserves_user_category(lam, repo):
    # The "Inner View Psych" bug: a charge categorised while still pending loses its
    # category when the bank re-sends the same pending id (which it does for ~7 days).
    # Fail-on-revert: drop the read-then-carry and the category reverts to the raw one.
    seeded = _seed_pending(repo, lam, txn_id="A", amount=Decimal("-260.00"),
                           pending=True, category="health")
    resent = _norm(lam, txn_id="A", amount=Decimal("-260.00"),
                   pending=True, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([resent])

    store = repo._table.store
    row = store[(_acc(resent), "TXN#A")]
    assert row["category"] == "health"            # user category kept, not the bank's raw one
    assert row["status"] == seeded["status"]      # still pending
    assert len(store) == 1                        # same row, no duplicate


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


def test_pending_resync_does_not_carry_a_cleared_field(lam, repo):
    # Truthy carry guard: a cleared note on the stored pending must not resurrect.
    pending = _seed_pending(repo, lam, txn_id="A", amount=Decimal("-260.00"),
                            pending=True, category="health")
    acc = _acc(pending)
    repo._table.store[(acc, "TXN#A")]["notes"] = ""  # cleared

    resent = _norm(lam, txn_id="A", amount=Decimal("-260.00"),
                   pending=True, category="FOOD_AND_DRINK")
    repo.insert_or_reconcile([resent])

    assert "notes" not in repo._table.store[(acc, "TXN#A")]


def test_first_sight_of_pending_inserts_plainly(lam, repo):
    # No stored row yet -> nothing to carry, plain insert with the bank category.
    pending = _norm(lam, txn_id="A", amount=Decimal("-260.00"),
                    pending=True, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([pending])

    store = repo._table.store
    assert store[(_acc(pending), "TXN#A")]["category"] == "FOOD_AND_DRINK"
    assert len(store) == 1


def test_first_sight_of_pending_does_not_log_not_found(lam, repo, capsys):
    # The pending branch reads the stored row on every re-send, so a first-sight pending
    # (the common case) must not spam "Transaction not found". Fail-on-revert: restore the
    # debug print in get_transaction and this assertion fails.
    pending = _norm(lam, txn_id="A", amount=Decimal("-5.50"),
                    pending=True, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([pending])

    assert "Transaction not found" not in capsys.readouterr().out


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


def test_blank_auth_twin_reconciles_on_amount_and_merchant(lam, repo):
    # Both legs blank-auth (some ANZ settlements) with matching amount + merchant + a close
    # date now reconcile via the blank-auth tier — previously this pair was left as a
    # duplicate. The false-positive guards (different merchant / outside window / one-word
    # merchant) are covered by their own tests above.
    _seed_pending(repo, lam, txn_id="A", amount=Decimal("-5.50"),
                  authorized_date="", pending=True, category="coffee")
    posted = _norm(lam, txn_id="B", amount=Decimal("-5.50"),
                   authorized_date="", pending=False, category="FOOD_AND_DRINK")

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#A") not in store                   # pending twin consumed — no duplicate
    assert store[(acc, "TXN#B")]["category"] == "coffee"  # category carried across settlement
    assert len(store) == 1


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
    acc = _acc(_skew_posted(lam))
    assert {k[1] for k in store} == {"TXN#POST21", "TXN#POST22"}
    assert len(store) == 2                          # nothing lost, nothing duplicated


def test_pending_earlier_than_posted_does_not_merge(lam, repo):
    # The clocks can only put the Melbourne day AHEAD. A pending dated earlier than its
    # posting is not a skew, so it must not be swept in.
    _skew_pending(repo, lam, authorized_date="2026-07-20")

    repo.insert_or_reconcile([_skew_posted(lam, authorized_date="2026-07-21")])

    assert len(repo._table.store) == 2


def test_two_day_gap_does_not_merge(lam, repo):
    _skew_pending(repo, lam, authorized_date="2026-07-23")

    repo.insert_or_reconcile([_skew_posted(lam, authorized_date="2026-07-21")])

    assert len(repo._table.store) == 2


def test_skew_different_merchant_does_not_merge(lam, repo):
    _skew_pending(repo, lam, description="POS AUTHORISATION  COLES SUPERMARKET  MELBOURNE AU")

    repo.insert_or_reconcile([_skew_posted(lam)])

    assert len(repo._table.store) == 2


def test_skew_single_word_merchant_does_not_merge(lam, repo):
    # A lone common word is a whole word in many unrelated descriptions; this tier
    # deletes a pending, so it needs a merchant strong enough to trust.
    _skew_pending(repo, lam, description="POS AUTHORISATION  COLES  MELBOURNE AU")

    repo.insert_or_reconcile([_skew_posted(lam, description="COLES 0643 CHADSTONE",
                                          merchant_name="COLES")])

    assert len(repo._table.store) == 2


def test_skew_tip_sized_amount_gap_does_not_merge(lam, repo):
    # Skewed AND tipped is a compound rarity — this tier requires the exact amount.
    _skew_pending(repo, lam, amount=Decimal("-11.00"))

    repo.insert_or_reconcile([_skew_posted(lam, amount=Decimal("-12.00"))])

    assert len(repo._table.store) == 2


def test_skew_short_final_merchant_word_needs_an_exact_match(lam, repo):
    # "SA" prefixes far too many words to delete a pending on. A fused short final word
    # falls back to whole-word matching -> a leftover duplicate, never a wrong merge.
    _skew_pending(repo, lam, description="POS AUTHORISATION  DHP SASalvation  ST ALBANS AU")

    repo.insert_or_reconcile([_skew_posted(lam, description="DHP SA St Albans",
                                          merchant_name="DHP SA")])

    assert len(repo._table.store) == 2


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


def test_two_skew_postings_consume_one_pending_only_once(lam, repo):
    # Money-safety: a single pending can never be claimed twice.
    _skew_pending(repo, lam, txn_id="PEND", authorized_date="2026-07-22")
    first = _skew_posted(lam, txn_id="AAA", authorized_date="2026-07-21")
    second = _skew_posted(lam, txn_id="BBB", authorized_date="2026-07-21")

    repo.insert_or_reconcile([first, second])

    store = repo._table.store
    acc = _acc(first)
    assert (acc, "TXN#PEND") not in store
    assert len(store) == 2                          # both postings kept, one merge only
    merged = [k for k in ("TXN#AAA", "TXN#BBB") if store[(acc, k)]["category"] == "coffee"]
    assert merged == ["TXN#AAA"]                    # deterministic: lowest transaction_id


def test_skew_merge_carries_every_user_owned_field(lam, repo):
    # A pending the user categorised, noted, tagged and excluded must ride through.
    pending = _norm(lam, txn_id="PEND", amount=Decimal("-11.00"), authorized_date="2026-07-22",
                    date="2026-07-22", pending=True, category="coffee",
                    description=_SKEW_PEND_DESC, merchant_name="")
    pending["notes"] = "flat white x2"
    pending["tags"] = ["treat"]
    pending["budget_excluded"] = True
    repo.insert_transactions([pending])

    repo.insert_or_reconcile([_skew_posted(lam)])

    row = repo._table.store[(_acc(pending), "TXN#POST")]
    assert row["category"] == "coffee"
    assert row["notes"] == "flat white x2"
    assert row["tags"] == ["treat"]
    assert row["budget_excluded"] is True


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
    f = lam.repository._is_skewed_next_day
    # the real pair: pending (Melbourne) one day after the settled (UTC) day
    assert f("2026-07-22", "2026-07-21") is True
    assert f("2026-07-21", "2026-07-21") is False   # same day -> the exact tier's job
    assert f("2026-07-20", "2026-07-21") is False   # the clocks can't skew backwards
    assert f("2026-07-23", "2026-07-21") is False   # two days is not a clock split
    assert f("2026-08-01", "2026-07-31") is True    # month boundary
    assert f("2027-01-01", "2026-12-31") is True    # year boundary
    # a full timestamp still yields its date, and junk is never a skew
    assert f("2026-07-22T00:00:00+10:00", "2026-07-21") is True
    assert f("", "2026-07-21") is False
    assert f(None, "2026-07-21") is False
    assert f("2026-07-22", None) is False
    assert f("not-a-date", "2026-07-21") is False


def test_merchant_in_fused_description_edges(lam):
    g = lam.repository._merchant_in_fused_description
    # the real fusion: the 25-char column runs the suburb onto the merchant's last word
    assert g("KKV INTERNATIONAL PTY", _SKEW_PEND_DESC.lower()) is True
    # an ordinary (unfused) description still matches
    assert g("DHP SA PTY LTD", "pos authorisation dhp sa pty ltd st albans au") is True
    # only the LAST word may match as a prefix — a fused leading word is not enough
    assert g("KKV INTERNATIONAL PTY", "pos kkvinternational pty sunshine") is False
    # a short final word must match exactly, so it can't prefix an unrelated one
    assert g("DHP SA", "pos authorisation dhp sasalvation army au") is False
    assert g("DHP SA", "pos authorisation dhp sa st albans au") is True
    # a different merchant never matches
    assert g("COLES SUPERMARKET", _SKEW_PEND_DESC.lower()) is False
    assert g("", "anything at all") is False
    # An accented or punctuated trailing token is stripped to a STUMP ("ROSÉ" -> "ros")
    # that would clear the 3-character guard and then prefix-match an unrelated shop.
    # Only a token that survives stripping intact may match as a prefix.
    assert g("CAFE ROSE", "pos authorisation cafe rosewood bar au") is True  # real word, fusible
    assert g("CAFÉ ROSÉ", "pos authorisation café rosewood bar au") is False  # stump, must not
    assert g("CAFÉ ROSÉ", "pos authorisation café rosé bar au") is True      # exact still works


# --- WHIT-331 QA gaps (adversarial) -----------------------------------------
# Authored by QA on top of the implementer's WHIT-331 section above. These cover only
# what that section leaves open: calendar boundaries end-to-end, the merchant gate vs
# the lowest-id tie-break, sign/credit rows, the pending-re-send-in-the-same-payload
# ordering, the date carry on the LINK tier (not just the skew tier), the fused
# matcher's index boundaries, account scoping, and the merge log line.

_UP_ACCOUNT_ID = "3zVQJ8Btz_IRmqp78VrQnQ"   # -> "up-spending"
_ISAN_PEND_DESC = "POS AUTHORISATION         ISAN THAI STREET FOOD     MELBOURNE   AU"


def _skew_posted_on_up(lam, **kw):
    """The same skewed posting, but on the OTHER mapped account."""
    row = _bank_row(**{"txn_id": "UPPOST", "amount": Decimal("-11.00"),
                       "authorized_date": "2026-07-21", "date": "2026-07-24",
                       "pending": False, "category": "FOOD_AND_DRINK",
                       "description": _SKEW_POST_DESC,
                       "merchant_name": _SKEW_POST_MERCHANT, **kw})
    row["accountId"] = _UP_ACCOUNT_ID
    row["accountName"] = "Up Spending"
    return lam.banksync.BankSyncClient.normalise(row)


def _seed_pending_on_up(repo, lam, **kw):
    row = _bank_row(**{"txn_id": "UPPEND", "amount": Decimal("-11.00"),
                       "authorized_date": "2026-07-22", "date": "2026-07-22",
                       "pending": True, "category": "coffee",
                       "description": _SKEW_PEND_DESC, "merchant_name": "", **kw})
    row["accountId"] = _UP_ACCOUNT_ID
    row["accountName"] = "Up Spending"
    txn = lam.banksync.BankSyncClient.normalise(row)
    repo.insert_transactions([txn])
    return txn


# [A10] / [A11] calendar boundaries, end to end (the unit test above only checks the
# _is_skewed_next_day predicate, never the merge + date carry through the repository).


def test_skew_merge_across_a_month_boundary_keeps_the_melbourne_day(lam, repo):
    # Swiped 1 Aug just after midnight Melbourne -> settled row still reads 31 Jul (UTC).
    _skew_pending(repo, lam, authorized_date="2026-08-01")

    repo.insert_or_reconcile([_skew_posted(lam, authorized_date="2026-07-31",
                                           date="2026-08-03")])

    store = repo._table.store
    acc = _acc(_skew_posted(lam))
    assert (acc, "TXN#PEND") not in store
    assert len(store) == 1
    assert store[(acc, "TXN#POST")]["date"] == "2026-08-01"      # August, not July
    assert store[(acc, "TXN#POST")]["authorized_date"] == "2026-08-01"


def test_skew_merge_across_a_leap_day_keeps_the_melbourne_day(lam, repo):
    # 29 Feb 2028 (UTC) -> 1 Mar 2028 (Melbourne). A naive "+1 day" done on strings
    # rather than dates would produce 2028-02-30 and never match.
    _skew_pending(repo, lam, authorized_date="2028-03-01")

    repo.insert_or_reconcile([_skew_posted(lam, authorized_date="2028-02-29",
                                           date="2028-03-02")])

    store = repo._table.store
    acc = _acc(_skew_posted(lam))
    assert (acc, "TXN#PEND") not in store
    assert store[(acc, "TXN#POST")]["date"] == "2028-03-01"


# [A12] the merchant gate must beat the lowest-transaction_id tie-break.


def test_skew_tier_picks_the_matching_merchant_not_the_lowest_id(lam, repo):
    # Two pendings, both -$11 and both dated exactly one day after the posting, so ONLY
    # the merchant gate separates them — and the WRONG one sorts first by id, which is
    # what the deterministic min() tie-break would otherwise pick.
    _seed_pending(repo, lam, txn_id="AAA", amount=Decimal("-11.00"),
                  authorized_date="2026-07-22", date="2026-07-22", pending=True,
                  category="thai", description=_ISAN_PEND_DESC, merchant_name="")
    _skew_pending(repo, lam, txn_id="ZZZ", authorized_date="2026-07-22")

    repo.insert_or_reconcile([_skew_posted(lam)])

    store = repo._table.store
    acc = _acc(_skew_posted(lam))
    assert (acc, "TXN#ZZZ") not in store            # the KKV pending was the twin
    assert (acc, "TXN#AAA") in store                # the Thai pending is a real charge
    assert store[(acc, "TXN#POST")]["category"] == "coffee"   # not "thai"


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


# [A16] the date carry is gated on the skew SHAPE, not on the tier — so a LINKED twin
# that is one day ahead must move the settled row to the Melbourne day too.


def test_linked_twin_one_day_ahead_also_wins_the_melbourne_day(lam, repo):
    # pendingTransactionId is null in ANZ data today but the tier is live (forward-compat).
    # If the link resolves to a twin dated one day later, the same clock split applies.
    _skew_pending(repo, lam, txn_id="LINK", authorized_date="2026-07-22")
    posted = _norm(lam, txn_id="POST", amount=Decimal("-11.00"), authorized_date="2026-07-21",
                   date="2026-07-24", pending=False, category="FOOD_AND_DRINK",
                   description=_SKEW_POST_DESC, merchant_name=_SKEW_POST_MERCHANT,
                   pending_transaction_id="LINK")

    repo.insert_or_reconcile([posted])

    row = repo._table.store[(_acc(posted), "TXN#POST")]
    assert row["date"] == "2026-07-22"
    assert row["authorized_date"] == "2026-07-22"


# [A17] index boundaries of the fused matcher (the existing edge test covers semantics,
# not the ends of the word list, where the i + len(head) lookup could run off).


def test_merchant_in_fused_description_index_boundaries(lam):
    g = lam.repository._merchant_in_fused_description
    # merchant LONGER than the whole description -> no candidate window, never an IndexError
    assert g("KKV INTERNATIONAL PTY LTD AUSTRALIA", "kkv international") is False
    # description exactly one word short of the merchant
    assert g("KKV INTERNATIONAL PTY", "kkv international") is False
    # the fused word is the very LAST word of the description (the highest legal index)
    assert g("KKV INTERNATIONAL PTY", "pos kkv international ptysunshine") is True
    # and the very FIRST word run, with nothing before it
    assert g("KKV INTERNATIONAL PTY", "kkv international ptysunshine au") is True
    # empty / whitespace-only inputs on either side
    assert g("KKV INTERNATIONAL PTY", "") is False
    assert g("   ", _SKEW_PEND_DESC.lower()) is False


# [A18] the pending pool is per account: an identical skew-eligible pending on another
# card must not be consumed by this account's settlement.


def test_skew_merge_does_not_reach_across_accounts(lam, repo):
    # The other account's pending is IDENTICAL (same amount, same merchant, same skewed
    # day) and sorts FIRST by transaction_id, so an unscoped pool would consume it
    # instead of this card's own pending.
    _seed_pending_on_up(repo, lam, txn_id="AAA_UPPEND")     # a different account
    _skew_pending(repo, lam, txn_id="ZZZ_PEND")             # the ANZ card's own twin

    repo.insert_or_reconcile([_skew_posted(lam)])

    store = repo._table.store
    assert (_acc(_skew_posted(lam)), "TXN#ZZZ_PEND") not in store    # merged on ANZ
    assert ("ACCOUNT#up-spending", "TXN#AAA_UPPEND") in store        # untouched elsewhere
    assert store[(_acc(_skew_posted(lam)), "TXN#POST")]["category"] == "coffee"
    assert len(store) == 2


# [A19] the merge is otherwise invisible (it DELETES a row), so the INFO log is the only
# operational trace — lock it.


def test_skew_merge_logs_both_transaction_ids_at_info(lam, repo, caplog):
    _skew_pending(repo, lam, txn_id="PEND")
    caplog.set_level("INFO", logger="repository")

    repo.insert_or_reconcile([_skew_posted(lam, txn_id="POST")])

    merged = [r for r in caplog.records if "skewed-date twin merged" in r.getMessage()]
    assert len(merged) == 1
    message = merged[0].getMessage()
    assert "posted=POST (auth 2026-07-21)" in message
    assert "pending=PEND (auth 2026-07-22)" in message
