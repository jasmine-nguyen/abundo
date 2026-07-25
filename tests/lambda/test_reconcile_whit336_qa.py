"""WHIT-336 QA gaps (adversarial) — the skewed-date tier's merchant gate after the
prefix-tolerant matcher was replaced by a POSITIONAL slice of ANZ's fixed-width
merchant column plus CLEANED-NAME EQUALITY (lambda/repository.py
`merchant.pending_merchant_column` / `repository._merchant_matches_pending`).

Written on top of the implementer's WHIT-336 section in test_reconcile.py. That
section already pins: the exhaustive live-name cross, padding drift on a full column,
empty/missing stored merchant_name on both shapes, and the three named different-store
negatives. Nothing here repeats those.

What this file covers instead:
  * multiplicity + batch ordering on the branch the change newly OPENS (a merchant
    that FILLS the 25-char column used to be unmatchable, so its tie-breaks, its
    two-postings-one-pending contest and its re-send guard were unreachable),
  * that the widened gate did not shift which TIER claims a pending — and the one
    place it DID: the tip and blank-auth tiers never got the column fix, so on a
    full-column shop the loosest tier is now the only one that can see the name,
  * shared/budget_alerts.py, which previews alerts by driving this very gate,
  * refunds / sign flips / zero through the new equality gate,
  * degenerate ANZ descriptors — blank merchant column, sub-column-length text,
    tab / newline / non-breaking-space padding, an accented name,
  * the live names the OLD gate missed and the new one merges, and the live
    containment pairs the implementer's negatives did NOT name.

Every merchant string is verbatim from the live DynamoDB scan (773 described rows)
or from the repo's own existing fixtures. No invented merchants.
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
    return lam.banksync.BankSyncClient.normalise(_bank_row(**kw))


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


# ===========================================================================
# A. Multiplicity and batch ordering on the newly-opened "column" branch
# ===========================================================================


def test_two_full_column_pendings_only_one_is_consumed_and_it_is_the_lowest_id(lam, repo):
    # [A1] Two $88.10 Woolworths runs, both dated one day after the settling posting.
    # Before WHIT-336 a full-column merchant never reached this tier at all, so the
    # tie-break was unreachable for it. Exactly ONE pending may die, and which one must
    # be deterministic (lowest transaction_id) — the survivor keeps its OWN category.
    _woolies_pending(repo, lam, txn_id="P2", category="treats")
    _woolies_pending(repo, lam, txn_id="P1", category="groceries")

    repo.insert_or_reconcile([_woolies_posted(lam)])

    store = repo._table.store
    acc = _acc(_woolies_posted(lam))
    assert (acc, "TXN#P1") not in store          # lowest id consumed
    assert (acc, "TXN#P2") in store              # the other survives untouched
    assert store[(acc, "TXN#P2")]["category"] == "treats"
    assert store[(acc, "TXN#POST")]["category"] == "groceries"
    assert len(store) == 2


def test_two_full_column_postings_cannot_both_take_one_pending(lam, repo):
    # [A2] One open pending, two settlements of the same amount in one payload. The
    # pool is popped, so the second posting must find nothing and insert plainly —
    # three rows total would mean the pending was deleted twice (or double-carried).
    _woolies_pending(repo, lam, txn_id="PEND", category="groceries")

    repo.insert_or_reconcile([_woolies_posted(lam, txn_id="B"),
                              _woolies_posted(lam, txn_id="A")])

    store = repo._table.store
    acc = _acc(_woolies_posted(lam))
    assert (acc, "TXN#PEND") not in store
    assert len(store) == 2
    carried = [store[(acc, "TXN#A")]["category"], store[(acc, "TXN#B")]["category"]]
    assert sorted(carried) == ["GENERAL_MERCHANDISE", "groceries"]  # exactly one carry


@pytest.mark.parametrize("order", [("A", "B"), ("B", "A")])
def test_full_column_batch_order_does_not_change_the_pairing(lam, repo, order):
    # [A3] Two pendings, two settlements, all the same shop+amount. Whatever order the
    # payload arrives in, each posting takes one pending and no row is lost or doubled.
    _woolies_pending(repo, lam, txn_id="P1", category="groceries")
    _woolies_pending(repo, lam, txn_id="P2", category="treats")
    batch = {"A": _woolies_posted(lam, txn_id="A"), "B": _woolies_posted(lam, txn_id="B")}

    repo.insert_or_reconcile([batch[order[0]], batch[order[1]]])

    store = repo._table.store
    acc = _acc(batch["A"])
    assert (acc, "TXN#P1") not in store
    assert (acc, "TXN#P2") not in store
    assert len(store) == 2
    assert sorted([store[(acc, "TXN#A")]["category"],
                   store[(acc, "TXN#B")]["category"]]) == ["groceries", "treats"]


def test_full_column_posted_resend_does_not_consume_a_fresh_pending(lam, repo):
    # [A4] A settled Woolworths row already stored under its own id is RE-SENT while a
    # genuinely different pending sits one day later at the same amount. The re-send is
    # held out of the twin search, so it must not eat that pending. The widened gate
    # makes this reachable for full-column merchants for the first time.
    already = _woolies_posted(lam, txn_id="POST")
    repo.insert_transactions([already])
    _woolies_pending(repo, lam, txn_id="PEND", authorized_date="2026-07-22",
                     category="groceries")

    repo.insert_or_reconcile([_woolies_posted(lam, txn_id="POST")])

    store = repo._table.store
    acc = _acc(already)
    assert (acc, "TXN#PEND") in store               # the fresh pending is untouched
    assert store[(acc, "TXN#PEND")]["category"] == "groceries"
    assert len(store) == 2

    # Positive control in the same fixture, so this test is not passing merely because
    # the gate is blind: a FIRST-TIME settlement of that same pending does take it.
    repo.insert_or_reconcile([_woolies_posted(lam, txn_id="POST2")])
    assert (acc, "TXN#PEND") not in repo._table.store
    assert repo._table.store[(acc, "TXN#POST2")]["category"] == "groceries"


# ===========================================================================
# B. Tier interaction — the change must not move which tier claims a pending
# ===========================================================================


def test_exact_same_day_twin_still_beats_a_full_column_skew_candidate(lam, repo):
    # [A5] WHIT-117 ordering, re-checked on the branch WHIT-336 opened. Pending E is the
    # EXACT same-day twin; pending S is a skew-eligible full-column sibling at the same
    # amount. The exact tier must claim E first, leaving S alive.
    _woolies_pending(repo, lam, txn_id="E", authorized_date="2026-07-21", category="exact")
    _woolies_pending(repo, lam, txn_id="S", authorized_date="2026-07-22", category="skew")

    repo.insert_or_reconcile([_woolies_posted(lam)])

    store = repo._table.store
    acc = _acc(_woolies_posted(lam))
    assert (acc, "TXN#E") not in store
    assert (acc, "TXN#S") in store
    assert store[(acc, "TXN#POST")]["category"] == "exact"


def test_tip_tier_also_sees_a_fused_full_column_merchant(lam, repo):
    # [A6] All three heuristic tiers share `_merchant_matches_pending`, so the tip tier
    # reads the fixed-width column too. Before that, a merchant filling the 25-char
    # column ("...MILLERS RDALTONA NORTH") was invisible here while the LOOSER skew tier
    # could see it — which inverted the tightest-first ordering (see A6c).
    _woolies_pending(repo, lam, txn_id="T", amount=Decimal("-80.00"),
                     authorized_date="2026-07-21", category="tipped")

    repo.insert_or_reconcile([_woolies_posted(lam)])          # -88.10, inside TIP_HEADROOM

    store = repo._table.store
    assert len(store) == 1                                    # tip-reconciled
    assert store[(_acc(_woolies_posted(lam)), "TXN#POST")]["category"] == "tipped"


def test_tip_tier_still_works_for_a_merchant_that_does_not_fill_the_column(lam, repo):
    # [A6b] The control for [A6]: identical scenario, "CHEMIST WAREHOUSE" (17 chars, so
    # the column pads and nothing fuses) — the tip tier matches as it always has.
    _seed(repo, lam, txn_id="T", amount=Decimal("-80.00"), authorized_date="2026-07-21",
          pending=True, category="tipped", description=_pend("CHEMIST WAREHOUSE"))
    posted = _norm(lam, txn_id="POST", amount=Decimal("-88.10"), authorized_date="2026-07-21",
                   date="2026-07-24", pending=False, category="GENERAL_MERCHANDISE",
                   description="CHEMIST WAREHOUSE        ALTONA NORTH",
                   merchant_name=_posted_name("CHEMIST WAREHOUSE"))

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    assert len(store) == 1
    assert store[(_acc(posted), "TXN#POST")]["category"] == "tipped"


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


def test_blank_auth_tier_also_sees_a_fused_full_column_merchant(lam, repo):
    # [A7] `_find_blank_auth_twin` shares the same gate, so a settlement ANZ sent with NO
    # authorized_date now pairs with a full-column pending instead of duplicating.
    _woolies_pending(repo, lam, txn_id="PEND", authorized_date="2026-07-22",
                     category="groceries")
    blank = _norm(lam, txn_id="BLANK", amount=Decimal("-88.10"), authorized_date="",
                  date="2026-07-24", pending=False, category="GENERAL_MERCHANDISE",
                  description=_WOOLIES_POST_DESC, merchant_name=_WOOLIES_POST_NAME)

    repo.insert_or_reconcile([blank])

    store = repo._table.store
    assert len(store) == 1
    assert store[(_acc(blank), "TXN#BLANK")]["category"] == "groceries"


def test_a_skewed_posting_beats_a_blank_auth_posting_for_one_full_column_pending(lam, repo):
    # [A7b] Two settlements contest one full-column pending: one with a swipe date a day
    # earlier (skew tier, which now sees the column) and one with no swipe date at all
    # (blank-auth tier, which still does not). The skew posting must take it, and the
    # blank-auth row must insert plainly rather than double-delete.
    _woolies_pending(repo, lam, txn_id="PEND", category="groceries")
    blank = _norm(lam, txn_id="BLANK", amount=Decimal("-88.10"), authorized_date="",
                  date="2026-07-24", pending=False, category="GENERAL_MERCHANDISE",
                  description=_WOOLIES_POST_DESC, merchant_name=_WOOLIES_POST_NAME)

    repo.insert_or_reconcile([blank, _woolies_posted(lam, txn_id="SKEW")])

    store = repo._table.store
    acc = _acc(blank)
    assert (acc, "TXN#PEND") not in store
    assert store[(acc, "TXN#SKEW")]["category"] == "groceries"
    assert store[(acc, "TXN#BLANK")]["category"] == "GENERAL_MERCHANDISE"
    assert len(store) == 2


def test_single_word_full_column_merchant_now_merges_on_the_column_gate(lam, repo, caplog):
    # [A8] QUEENVICTORIAMARKETSKIDAT (live, 25 chars, no spaces) fills the column, so
    # clean_merchant fused it into the suburb and the stored pending name was corrupt
    # ("...SKIDATMELBOURNE"). The name-equality branch could never match it. It now
    # merges, and the log must name the COLUMN gate — not "name" — because that is the
    # only production signal that the positional slice is still aligned.
    caplog.set_level("INFO", logger="repository")
    col = "QUEENVICTORIAMARKETSKIDAT"
    _seed(repo, lam, txn_id="PEND", amount=Decimal("-9.00"), authorized_date="2026-07-22",
          pending=True, category="parking", description=_pend(col, "MELBOURNE"))
    posted = _norm(lam, txn_id="POST", amount=Decimal("-9.00"), authorized_date="2026-07-21",
                   date="2026-07-24", pending=False, category="TRANSPORTATION",
                   description="QUEENVICTORIAMARKETSKIDAT MELBOURNE",
                   merchant_name=_posted_name(col))

    repo.insert_or_reconcile([posted])

    store = repo._table.store
    acc = _acc(posted)
    assert (acc, "TXN#PEND") not in store
    assert store[(acc, "TXN#POST")]["category"] == "parking"
    merged = [r.getMessage() for r in caplog.records if "twin merged" in r.getMessage()]
    assert len(merged) == 1
    assert "gate=column" in merged[0]


# ===========================================================================
# C. shared/budget_alerts.py previews alerts by driving this exact gate
# ===========================================================================


class _FakeWindowRepo:
    def __init__(self, rows):
        self._rows = rows

    def get_transactions_by_date_range(self, account_id, start, end, limit=100, cursor=None):
        return ([r for r in self._rows if r["account_id"] == account_id], None)


class _FakeRepo:
    def __init__(self, value):
        self._v = value

    def list_budgets(self):
        return self._v

    def list_tokens(self):
        return list(self._v)

    def list_categories(self):
        return self._v

    def get_paycycle(self):
        return dict(self._v)


class _FakeNotifyRepo:
    def __init__(self):
        self.store = {}

    def fired_markers(self, last, length):
        return set(self.store.get((last, length), set()))

    def mark_fired(self, last, length, marker):
        self.store.setdefault((last, length), set()).add(marker)


def _run_alerts(lam, monkeypatch, *, budgets, before, normalised, webhook_repo):
    """Drive capture_pre_write + fire_if_crossed with the REAL webhook repository, so
    the Δ simulation runs the production `_reconcile_matches` (and therefore the
    WHIT-336 gate) rather than a stand-in."""
    import spend
    monkeypatch.setattr(spend, "_melbourne_today", lambda: __import__("datetime").date(2026, 7, 24))
    ba = lam.budget_alerts
    sent = []
    monkeypatch.setattr(ba, "send_push",
                        lambda t, b, toks, data=None: (sent.append((t, b)),
                                                       {"sent": len(list(toks)), "ok": 1,
                                                        "pruned": []})[1])
    notify = _FakeNotifyRepo()
    ctx = ba.capture_pre_write(
        normalised,
        device_repo=_FakeRepo(["ExpoPushToken[a]"]),
        budget_repo=_FakeRepo(budgets),
        paycycle_repo=_FakeRepo({"last_pay_date": "2026-07-15", "length": 14}),
        window_repo=_FakeWindowRepo(before),
        webhook_repo=webhook_repo,
    )
    ba.fire_if_crossed(ctx, normalised, webhook_repo=webhook_repo,
                       category_repo=_FakeRepo([{"id": "groceries", "name": "Groceries",
                                                 "bucket": "Needs"}]),
                       notify_repo=notify)
    return sent, notify


def test_budget_alert_preview_does_not_double_count_a_full_column_settlement(lam, repo, monkeypatch):
    # [A9] budget_alerts previews the alert by replaying the write over a pre-write
    # snapshot through the repo's own `_reconcile_matches`. Pending -88.10 groceries
    # (target 100) settles as the skewed posting. Correct Δ: the twin is removed and the
    # posting added → combined stays 88.10, which is past 80% — already crossed BEFORE
    # the write, so nothing newly crosses and no push fires. If the gate stops matching,
    # the twin survives, combined reads 176.20 and a FALSE 100% push goes out.
    _woolies_pending(repo, lam, txn_id="PEND", category="groceries")
    before = list(repo._table.store.values())
    posted = _woolies_posted(lam, txn_id="POST")
    posted = dict(posted)
    posted["category"] = "groceries"

    sent, notify = _run_alerts(lam, monkeypatch, budgets={"groceries": {"target": Decimal("100")}},
                               before=before, normalised=[posted], webhook_repo=repo)

    assert sent == []
    assert notify.fired_markers("2026-07-15", 14) == set()


def test_budget_alert_preview_still_fires_when_the_gate_correctly_refuses(lam, repo, monkeypatch):
    # [A9b] The positive control for [A9], through the same wiring. Pending -88.10 at
    # CHEMIST WAREHOUSE DARLING; the settlement is -88.10 at CHEMIST WAREHOUSE — a
    # DIFFERENT live store, so the gate must refuse. Both rows then count: 176.20 of a
    # 200 target = 88%, newly crossing 80%, so exactly ONE push (the 80 copy) goes out.
    # If the gate ever loosens back to containment the twin is consumed, the total drops
    # to 88.10 (44%) and this test reds.
    _seed(repo, lam, txn_id="PEND", amount=Decimal("-88.10"), authorized_date="2026-07-22",
          pending=True, category="groceries", description=_pend("CHEMIST WAREHOUSE DARLING"))
    before = list(repo._table.store.values())
    posted = dict(_norm(lam, txn_id="POST", amount=Decimal("-88.10"),
                        authorized_date="2026-07-21", date="2026-07-24", pending=False,
                        category="GENERAL_MERCHANDISE",
                        description="CHEMIST WAREHOUSE        ALTONA NORTH",
                        merchant_name=_posted_name("CHEMIST WAREHOUSE")))
    posted["category"] = "groceries"

    sent, notify = _run_alerts(lam, monkeypatch, budgets={"groceries": {"target": Decimal("200")}},
                               before=before, normalised=[posted], webhook_repo=repo)

    assert [t for t, _ in sent] == ["Heads up \U0001f440"]     # the 80% copy, exactly once
    assert notify.fired_markers("2026-07-15", 14) == {"groceries#80"}


# ===========================================================================
# D. Sign, refunds and zero through the equality gate
# ===========================================================================


def test_full_column_refund_pair_reconciles(lam, repo):
    # [A10] Refunds are POSITIVE. The skew tier has no sign gate — it needs an EXACT
    # amount — so a refund pending and its settled refund still pair on the column.
    _woolies_pending(repo, lam, txn_id="PEND", amount=Decimal("12.50"), category="refunds")

    repo.insert_or_reconcile([_woolies_posted(lam, amount=Decimal("12.50"))])

    store = repo._table.store
    acc = _acc(_woolies_posted(lam))
    assert (acc, "TXN#PEND") not in store
    assert store[(acc, "TXN#POST")]["category"] == "refunds"
    assert len(store) == 1


def test_full_column_purchase_never_consumes_a_same_size_refund_pending(lam, repo):
    # [A11] The sign flip. A -88.10 purchase must never eat a +88.10 refund pending at
    # the same shop one day later — amount equality is signed, and this is the case a
    # magnitude comparison would get catastrophically wrong (a real refund deleted).
    _woolies_pending(repo, lam, txn_id="PEND", amount=Decimal("88.10"), category="refunds")

    repo.insert_or_reconcile([_woolies_posted(lam, amount=Decimal("-88.10"))])

    store = repo._table.store
    acc = _acc(_woolies_posted(lam))
    assert (acc, "TXN#PEND") in store
    assert store[(acc, "TXN#PEND")]["category"] == "refunds"
    assert len(store) == 2


def test_full_column_zero_amount_pair_still_pairs_on_the_column(lam, repo):
    # [A12] A $0 authorisation (a card check) is a real ANZ shape. It has no sign, so
    # only the merchant gate stands between it and the pending — pin that the column
    # gate, not an amount heuristic, is what decides.
    _woolies_pending(repo, lam, txn_id="PEND", amount=Decimal("0"), category="checks")
    _seed(repo, lam, txn_id="OTHER", amount=Decimal("0"), authorized_date="2026-07-22",
          pending=True, category="not-this-shop",
          description=_pend("CHEMIST WAREHOUSE DARLING"))

    repo.insert_or_reconcile([_woolies_posted(lam, amount=Decimal("0"))])

    store = repo._table.store
    acc = _acc(_woolies_posted(lam))
    assert (acc, "TXN#PEND") not in store
    assert (acc, "TXN#OTHER") in store                  # the other shop is untouched
    assert store[(acc, "TXN#POST")]["category"] == "checks"


# ===========================================================================
# E. Degenerate ANZ descriptors
# ===========================================================================


def test_column_slice_survives_tab_newline_and_nbsp_padding(lam):
    # [A13] The prefix regex matches `\s{2,}`, which in Python 3 covers tabs, newlines
    # AND U+00A0. A bank-side whitespace substitution must still land the cut on the
    # merchant, not shift it into the suburb.
    g = lam.merchant.pending_merchant_column
    body = "COLES 0602".ljust(25) + "MELBOURNE".ljust(13) + "AU"
    for pad in ("\t\t", " \t \t ", "\n\n", "\xa0" * 9, " \xa0" * 5):
        assert g("POS AUTHORISATION" + pad + body).strip() == "COLES 0602", repr(pad)


def test_descriptions_shorter_than_the_column_never_raise(lam):
    # [A14] Ragged/truncated descriptors: exactly the prefix, prefix + padding only,
    # a one-character column, a column shorter than 25. None may raise; a real (short)
    # column must still come back.
    g = lam.merchant.pending_merchant_column
    assert g("POS AUTHORISATION") is None                 # no padding -> not the shape
    assert g("POS AUTHORISATION  ") is None               # padding only -> blank column
    assert g("POS AUTHORISATION  C") == "C"               # a 1-char column is still a column
    assert g("POS AUTHORISATION   COLES 0602") == "COLES 0602"   # runs off the end, no pad
    assert g("pos authorisation   coles 0602") == "coles 0602"   # case-insensitive prefix
    assert g("POS AUTHORISATION\n") is None


def test_accented_merchant_needs_exact_equality_not_a_stripped_stump(lam):
    # [A15] `_words` keeps only [a-z0-9], so "CAFÉ ROSÉ" reduces to ("caf", "ros"). The
    # deleted matcher needed an explicit guard to stop that stump PREFIX-matching an
    # unrelated shop; equality removes the need, and this pins that it really did.
    # (Fixtures carried over from the test WHIT-336 deleted.)
    g = lam.repository._merchant_matches_pending
    assert g("CAFÉ ROSÉ", "", _pend("CAFÉ ROSEWOOD BAR")) is False   # stump must not match
    assert g("CAFE ROSE", "", _pend("CAFE ROSEWOOD BAR")) is False   # nor the ascii form
    assert g("CAFÉ ROSÉ", "", _pend("CAFÉ ROSÉ")) is True            # the real twin still does


def test_a_blank_merchant_column_is_never_read_as_the_suburb(lam):
    # [A16] The greedy padding match runs straight through a BLANK merchant column, so
    # without a guard the 25-char slice starts at the SUBURB and hands a place name back
    # as if it were a merchant. The guard is `len(pad) >= _MERCHANT_COLUMN_WIDTH`.
    # The implementer's own edge test only covers an all-blank tail
    # (`"POS AUTHORISATION" + " " * 40`), which never reaches this.
    g = lam.merchant.pending_merchant_column
    assert g("POS AUTHORISATION" + " " * 9 + " " * 25 + "ALTONA NORTH " + "AU") is None
    assert g("POS AUTHORISATION" + " " * 9 + " " * 25 + "MELBOURNE    AU") is None
    # and the guard must not eat a REAL column behind wide padding drift
    assert g("POS AUTHORISATION" + " " * 24 + "COLES 0602".ljust(25)).strip() == "COLES 0602"


def test_a_blank_merchant_column_refuses_instead_of_falling_through(lam):
    # [A17] The [A16] guard alone was not enough. A None column meant "not an ANZ row",
    # which routed the pending to the multi-word containment gate — and THAT gate reads
    # the whole description, suburb included, so a merchant named after a place matched
    # anyway. The gate now branches on the ANZ SHAPE, not on whether a column came back,
    # so an unreadable column refuses rather than falling through to something looser.
    g = lam.repository._merchant_matches_pending
    blank_column = "POS AUTHORISATION" + " " * 9 + " " * 25 + "ALTONA NORTH " + "AU"
    assert lam.merchant.pending_merchant_column(blank_column) is None
    assert g("ALTONA NORTH", "", blank_column) is False
    # a readable column on the same shape still matches, so this is the guard and not a
    # blanket refusal of everything ANZ-shaped. ("COLES", not "COLES 0602" — the gate
    # compares names that have already been through clean_merchant, which strips the
    # store number.)
    assert g("COLES", "", _pend("COLES 0602")) is True


def test_padding_drift_tolerance_now_stops_at_the_column_width(lam):
    # [A17b] The [A16] guard caps how much padding drift the relative slice absorbs at
    # 24 characters. Past that the row silently stops being treated as ANZ and drops to
    # containment — the safe direction, but pin the boundary so it is a decision.
    g = lam.merchant.pending_merchant_column
    body = "COLES 0602".ljust(25) + "MELBOURNE"
    assert g("POS AUTHORISATION" + " " * 24 + body).strip() == "COLES 0602"
    assert g("POS AUTHORISATION" + " " * 25 + body) is None


# ===========================================================================
# F. The non-ANZ fallback — the shape the fix does NOT cover
# ===========================================================================


def test_a_non_anz_shaped_pending_still_merges_two_different_chemist_warehouses(lam):
    # [A18] CHARACTERISATION of the residual hole, and the highest-severity finding.
    # WHIT-336's own docstring names CHEMIST WAREHOUSE vs CHEMIST WAREHOUSE DARLING as
    # two different stores whose merge "would delete a real transaction". That is only
    # enforced when the pending carries the "POS AUTHORISATION" + 2-space shape. Two of
    # the seven live pendings do NOT ("Movie Tkts", "WELLBEING SERVICES PTY ST ALBA"),
    # and Up rows never do. On those the unchanged containment fallback still merges.
    g = lam.repository._merchant_matches_pending
    assert g("CHEMIST WAREHOUSE", "", _pend("CHEMIST WAREHOUSE DARLING")) is False  # ANZ: safe
    assert g("CHEMIST WAREHOUSE", "",
             "CHEMIST WAREHOUSE DARLING ALTONA NORTH") is True                      # not ANZ
    assert g("BIG W", "", "BIG W/HAMPSHIRE RD        SUNSHINE") is True             # live pair


def test_single_space_padding_is_not_an_anz_column_and_falls_to_containment(lam):
    # [A19] The 2-space requirement is load-bearing SAFETY, not cosmetics: with one
    # space of padding the descriptor is not recognised as ANZ and drops to the loose
    # containment gate — the wrong merge is back. Pinned so a future "tolerate one
    # space" tweak reds here.
    g = lam.repository._merchant_matches_pending
    one_space = "POS AUTHORISATION CHEMIST WAREHOUSE DARLING ALTONA NORTH AU"
    assert lam.merchant.pending_merchant_column(one_space) is None
    assert g("CHEMIST WAREHOUSE", "", one_space) is True


# ===========================================================================
# G. Live names the OLD gate missed, and live containment pairs not yet named
# ===========================================================================


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


def test_a_26_character_merchant_is_an_accepted_miss_not_a_wrong_merge(lam, repo):
    # [A22] The posted merchantName column is 26 wide, the pending merchant column 25,
    # so a >=26-char merchant is cut differently on the two sides. "Fleet Partners Pty
    # Limited" is live and exactly 26. The documented outcome is a leftover duplicate
    # the age-out sweep reaps — pin it, so a "fix" that widens the slice to 26 (and with
    # it re-opens suburb bleed) has to argue with a test.
    col_25 = "Fleet Partners Pty Limited"[:25]
    _seed(repo, lam, txn_id="PEND", amount=Decimal("-410.00"), authorized_date="2026-07-22",
          pending=True, category="car", description=_pend(col_25))
    posted = _norm(lam, txn_id="POST", amount=Decimal("-410.00"), authorized_date="2026-07-21",
                   date="2026-07-24", pending=False, category="TRANSPORTATION",
                   description="Fleet Partners Pty Limited",
                   merchant_name="Fleet Partners Pty Limited")

    repo.insert_or_reconcile([posted])

    assert len(repo._table.store) == 2                      # duplicate, never a wrong merge
