"""The skewed-date tier's merchant gate on ANZ's fixed-width merchant column: a POSITIONAL
slice plus CLEANED-NAME EQUALITY (`merchant.pending_merchant_column` /
`reconcile.merchant_matches_pending`). Every merchant string is verbatim from the live table.
"""

from decimal import Decimal

import pytest

_BANK_ACCOUNT_ID = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"  # -> anz-rewards-black-visa


def _bank_row(txn_id, amount, authorized_date="2026-07-22", pending=True,
              category="FOOD_AND_DRINK", pending_transaction_id=None, date=None,
              description="", merchant_name=""):
    return {
        "id": txn_id,
        "date": date or authorized_date,
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


def _seed(repo, lam, **kw):
    txn = _norm(lam, **kw)
    repo.insert_transactions([txn])
    return txn


def _acc(txn):
    return "ACCOUNT#" + txn["account_id"]


# --- verbatim live shapes ----------------------------------------------------
# A pending descriptor: "POS AUTHORISATION" + 9 spaces (a 26-wide column), then the
# 25-wide merchant column, the 13-wide suburb column, "AU".  A posted `merchantName`
# is the SAME merchant, space-padded to 26.

def _pend(merchant_col, suburb="ALTONA NORTH"):
    return "POS AUTHORISATION" + " " * 9 + merchant_col.ljust(25) + suburb.ljust(13) + "AU"


def _posted_name(merchant_col):
    return merchant_col.ljust(26)


# WOOLWORTHS/330 MILLERS RD is exactly 25 chars, so on a pending it fuses into the
# suburb ("...MILLERS RDALTONA NORTH") and the OLD gate could not match it at all.
_WOOLIES_COL = "WOOLWORTHS/330 MILLERS RD"
_WOOLIES_PEND = _pend(_WOOLIES_COL)
_WOOLIES_POST_DESC = "WOOLWORTHS/330 MILLERS RD ALTONA NORTH"
_WOOLIES_POST_NAME = "WOOLWORTHS/330 MILLERS RD "


def _woolies_pending(repo, lam, txn_id="PEND", amount=Decimal("-88.10"),
                     authorized_date="2026-07-22", category="groceries",
                     description=_WOOLIES_PEND, merchant_name=""):
    return _seed(repo, lam, txn_id=txn_id, amount=amount, authorized_date=authorized_date,
                 date=authorized_date, pending=True, category=category,
                 description=description, merchant_name=merchant_name)


def _woolies_posted(lam, txn_id="POST", amount=Decimal("-88.10"),
                    authorized_date="2026-07-21", date="2026-07-24",
                    merchant_name=_WOOLIES_POST_NAME):
    return _norm(lam, txn_id=txn_id, amount=amount, authorized_date=authorized_date,
                 date=date, pending=False, category="GENERAL_MERCHANDISE",
                 description=_WOOLIES_POST_DESC, merchant_name=merchant_name)


def test_the_tighter_tip_tier_claims_its_twin_before_the_skew_tier_can(lam, repo):
    # [A6c] The regression guard for the worst shape in this file. Same shop, same full
    # column. T is the TRUE twin: -80.00 swiped today, settling at -88.10 with a tip.
    # S is a genuinely SEPARATE -88.10 purchase the next day.
    #
    # While only the skew tier could read the column, the tip tier could not see T, so
    # the settlement fell through and deleted S — the wrong pending — leaving the real
    # twin behind as a duplicate and stamping the settled row with S's day and category.
    # Sharing one gate restores tightest-first: the tip tier takes T, S is untouched.
    _woolies_pending(repo, lam, txn_id="T", amount=Decimal("-80.00"),
                     authorized_date="2026-07-21", category="tipped")
    _woolies_pending(repo, lam, txn_id="S", amount=Decimal("-88.10"),
                     authorized_date="2026-07-22", category="separate-purchase")

    repo.insert_or_reconcile([_woolies_posted(lam)])

    store = repo._table.store
    acc = _acc(_woolies_posted(lam))
    assert (acc, "TXN#T") not in store                 # the TRUE twin was claimed
    assert (acc, "TXN#S") in store                     # the separate purchase survives
    assert store[(acc, "TXN#S")]["category"] == "separate-purchase"
    assert store[(acc, "TXN#POST")]["category"] == "tipped"
    assert store[(acc, "TXN#POST")]["date"] == "2026-07-21"   # its own swipe day


def test_accented_merchant_needs_exact_equality_not_a_stripped_stump(lam):
    # [A15] `_words` keeps only [a-z0-9], so "CAFÉ ROSÉ" reduces to ("caf", "ros"). The
    # deleted matcher needed an explicit guard to stop that stump PREFIX-matching an
    # unrelated shop; equality removes the need, and this pins that it really did.
    # (Fixtures carried over from the test WHIT-336 deleted.)
    g = lam.reconcile.merchant_matches_pending
    assert g("CAFÉ ROSÉ", "", _pend("CAFÉ ROSEWOOD BAR")) is False   # stump must not match
    assert g("CAFE ROSE", "", _pend("CAFE ROSEWOOD BAR")) is False   # nor the ascii form
    assert g("CAFÉ ROSÉ", "", _pend("CAFÉ ROSÉ")) is True            # the real twin still does


@pytest.mark.parametrize("column", [
    "QUEENVICTORIAMARKETSKIDAT",   # one word, fills the column -> name gate was blind
    "SQ *VIETNAMESE ROLLS & RO",   # trailing "RO" is 2 chars -> old prefix rule refused
    "Thanon Khao S/413 Pitt St",   # trailing "St"
    "Uliveto/3/35 Tumbalong Bv",   # trailing "Bv"
    "MR Hotpoter H/shop l101/4",   # trailing "4"
    "WOOLWORTHS/330 MILLERS RD",   # trailing "RD"
])
def test_live_full_column_names_the_old_gate_missed_now_reconcile(lam, repo, column):
    # [A20] Every string is a verbatim 25-char merchant column from the live table. Each
    # one fused into its suburb on the pending side, and each was rejected by the old
    # prefix rule (short or non-word trailing token). They must all pair now.
    _seed(repo, lam, txn_id="PEND", amount=Decimal("-31.00"), authorized_date="2026-07-22",
          pending=True, category="mine", description=_pend(column))
    posted = _norm(lam, txn_id="POST", amount=Decimal("-31.00"), authorized_date="2026-07-21",
                   date="2026-07-24", pending=False, category="GENERAL_MERCHANDISE",
                   description=column + " ALTONA NORTH", merchant_name=_posted_name(column))

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#PEND") not in store
    assert len(store) == 1
    assert store[(acc, "TXN#POST")]["category"] == "mine"


@pytest.mark.parametrize("short_name, long_column", [
    ("AMAZON", "AMAZON MARKETPLACE AU"),         # live pair, not named by the implementer
    ("BIG W", "BIG W/HAMPSHIRE RD"),             # live pair
    ("OFFICEWORKS", "OFFICEWORKS 0355 ALTON"),   # live pair
    ("PET INSURANCE", "PET INSURANCE PAYMENT"),  # live pair, the documented accepted miss
])
def test_the_remaining_live_containment_pairs_never_merge_on_an_anz_pending(lam, repo,
                                                                            short_name,
                                                                            long_column):
    # [A21] The implementer named CHEMIST WAREHOUSE / McDonalds / WOOLWORTHS. These are
    # the OTHER four containment pairs in the live table — every one of them a different
    # store or a different product. On the ANZ shape none may merge, end to end.
    _seed(repo, lam, txn_id="PEND", amount=Decimal("-25.00"), authorized_date="2026-07-22",
          pending=True, category="theirs", description=_pend(long_column))
    posted = _norm(lam, txn_id="POST", amount=Decimal("-25.00"), authorized_date="2026-07-21",
                   date="2026-07-24", pending=False, category="GENERAL_MERCHANDISE",
                   description=short_name + " ALTONA NORTH",
                   merchant_name=_posted_name(short_name))

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#PEND") in store                       # the real pending survives
    assert store[(acc, "TXN#PEND")]["category"] == "theirs"
    assert len(store) == 2


