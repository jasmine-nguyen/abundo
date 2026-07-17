"""WHIT-300 (QA gap coverage): the one-time dedupe sweep is posted-authoritative
for the budget_excluded override — it must NEVER carry it from a stale pending twin.

These are the ADVERSARIAL gaps the implementer's tests don't cover:
  dry-run safety, multiple pending twins, tip-adjusted (non-exact) twins, the
  changed-gate re-put still firing when category legitimately differs, notes/tags
  still carrying alongside the now-skipped override, and the both-True combined case.

Helpers mirror tests/lambda/test_dedupe_cleanup.py (local copies so this file is
self-contained). Backed by the shared FakeTable `repo` / `lam` fixtures (conftest.py).
"""

_MAPPED_ACCOUNT = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"


def _raw_row(txn_id, amount=-5.50, pending=False, category="FOOD_AND_DRINK",
             authorized_date="2026-06-29"):
    return {
        "id": txn_id,
        "date": "2026-06-29",
        "authorizedDate": authorized_date,
        "description": "SQ *KKV INTERNATIONAL PTY",
        "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": amount,
        "accountId": _MAPPED_ACCOUNT,
        "accountName": "ANZ Rewards Black Visa",
        "category": category,
        "pending": pending,
        "type": "PAYMENT",
        "pendingTransactionId": None,
    }


def _store(lam, repo, *raw_rows):
    txns = [lam.banksync.BankSyncClient.normalise(r) for r in raw_rows]
    repo.insert_transactions(txns)


def _rows(repo):
    return {v["transaction_id"]: v for k, v in repo._table.store.items()
            if k[0].startswith("ACCOUNT#")}


def _inject(repo, txn_id, **fields):
    """Set non-bank fields (budget_excluded/notes/tags) directly on a stored row —
    normalise strips them, so they can only arrive by direct injection."""
    for item in repo._table.store.values():
        if item.get("transaction_id") == txn_id:
            item.update(fields)


def _capture_reputs(repo, monkeypatch):
    reputs = []
    original = repo.insert_transactions
    monkeypatch.setattr(
        repo, "insert_transactions",
        lambda txns: reputs.append(txns) or original(txns),
    )
    return reputs


# --- [A1] dry-run must write nothing even with a re-included/excluded twin --------


def test_dry_run_never_previews_the_reinclude_scenario(lam, repo):
    # [A1] The excluded pending + re-included posted case, under dry-run: the sweep must
    # REPORT the pair but touch nothing — no delete, and crucially no phantom override
    # written to the posted. (Locks dry-run safety for the WHIT-300 path; dry-run bails
    # before any write, so this is a safety guard, not a fail-on-revert of the fix.)
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="groceries"))
    _inject(repo, "pend1", budget_excluded=True)

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=True)

    assert summary["pairs"] == 1 and summary["deduped"] == 0
    rows = _rows(repo)
    assert "pend1" in rows                                   # nothing deleted
    assert rows["post1"].get("budget_excluded") is None      # no phantom exclude written


# --- [A2] multiple pending twins, one excluded, one posted -----------------------


def test_multiple_pending_twins_one_excluded_does_not_re_exclude(lam, repo, monkeypatch):
    # [A2] Two exact pending twins share (auth_date, amount); the sweep claims exactly one.
    # The claimed one is excluded, but the posted was re-included → it must STAY included,
    # no re-put, the claimed twin deleted, the unclaimed twin left for a later pass.
    # Fail-on-revert: restore the fill-if-absent carry → the excluded twin's override
    # carries onto post1 (a re-put fires) and this goes red.
    # pend_excl is stored FIRST so it is the one claimed (bucket.pop(0), insertion order).
    _store(lam, repo,
           _raw_row("pend_excl", pending=True, category="groceries"),
           _raw_row("pend_plain", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="groceries"))
    _inject(repo, "pend_excl", budget_excluded=True)
    reputs = _capture_reputs(repo, monkeypatch)

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["pairs"] == 1 and summary["deduped"] == 1
    rows = _rows(repo)
    assert "pend_excl" not in rows                           # claimed twin deleted
    assert "pend_plain" in rows                              # unclaimed twin survives
    assert rows["post1"].get("budget_excluded") is None      # posted stays INCLUDED
    assert reputs == []                                     # nothing differs -> no re-put


# --- [A3] tip-adjusted (non-exact) excluded twin must NOT be merged --------------


def test_tip_adjusted_excluded_twin_is_not_merged(lam, repo):
    # [A3] Settled amount grew by a tip (-5.50 -> -6.00): the exact-only sweep must leave
    # both rows alone. The excluded pending survives untouched (its override preserved for
    # manual review) and the posted is neither deleted nor excluded. This is a SCOPE guard
    # (the exact-match gate is independent of WHIT-300), not a fail-on-revert of the fix.
    _store(lam, repo,
           _raw_row("pend1", pending=True, amount=-5.50, category="groceries"),
           _raw_row("post1", pending=False, amount=-6.00, category="FOOD_AND_DRINK"))
    _inject(repo, "pend1", budget_excluded=True)

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["pairs"] == 0 and summary["deduped"] == 0
    rows = _rows(repo)
    assert rows["pend1"].get("budget_excluded") is True      # override preserved on pending
    assert rows["post1"].get("budget_excluded") is None      # posted untouched / included
    assert rows["post1"]["category"] == "FOOD_AND_DRINK"


# --- [A4] the changed-gate re-put still fires when category legitimately differs --


def test_category_diff_still_reputs_while_skipping_the_stale_exclude(lam, repo, monkeypatch):
    # [A4] The fix must NOT suppress a needed re-put. The pending has a genuinely different
    # category to carry AND a stale budget_excluded=True. The sweep must still re-put (to
    # carry the category) but must NOT bring the override across — posted stays included.
    # Fail-on-revert: restore the fill-if-absent carry → post1 gains budget_excluded=True.
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="FOOD_AND_DRINK"))
    _inject(repo, "pend1", budget_excluded=True)
    reputs = _capture_reputs(repo, monkeypatch)

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["deduped"] == 1
    rows = _rows(repo)
    assert "pend1" not in rows
    assert rows["post1"]["category"] == "groceries"          # category still carried
    assert len(reputs) == 1                                  # re-put DID fire (not suppressed)
    assert rows["post1"].get("budget_excluded") is None      # but the override did NOT carry


# --- [A5] notes/tags still carry alongside the now-skipped override --------------


def test_notes_and_tags_carry_but_budget_excluded_does_not(lam, repo, monkeypatch):
    # [A5] A stale pending twin holds a note, a tag AND budget_excluded=True; the posted
    # (re-included) holds none of them. notes/tags must carry (WHIT-275), the override must
    # NOT (WHIT-300). Proves the fix narrows ONLY budget_excluded, not the whole carry.
    # Fail-on-revert: restore the fill-if-absent carry → post1 gains budget_excluded=True.
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="groceries"))
    _inject(repo, "pend1", notes="reimburse me", tags=["work"], budget_excluded=True)
    reputs = _capture_reputs(repo, monkeypatch)

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["deduped"] == 1
    rows = _rows(repo)
    assert "pend1" not in rows
    assert rows["post1"]["notes"] == "reimburse me"          # note carried
    assert rows["post1"]["tags"] == ["work"]                 # tags carried
    assert rows["post1"].get("budget_excluded") is None      # override did NOT carry
    assert len(reputs) == 1                                  # note/tag diff -> a re-put fires


# --- [A6] combined: posted already excluded True + pending excluded True ----------


def test_posted_excluded_and_pending_excluded_stays_excluded_unit(lam, repo):
    # [A6a] Unit: the user excluded the POSTED after settlement; the stale pending twin is
    # ALSO excluded. The posted's own True must survive (never un-excluded). Preserve guard
    # — reverting WHIT-300 also keeps it True (posted-truthy short-circuit), so this locks
    # behaviour rather than the fix's delta.
    posted = {"transaction_id": "B", "category": "coffee", "budget_excluded": True}
    source = {"category": "coffee", "budget_excluded": True}

    carried = repo._with_carried_category(posted, source, dedupe_sweep=True)

    assert carried["budget_excluded"] is True


def test_posted_excluded_and_pending_excluded_stays_excluded_sweep(lam, repo, monkeypatch):
    # [A6b] Sweep-level of the same: both excluded, same category → carried == posted →
    # no re-put, pending deleted, posted stays excluded. Guards that the sweep never
    # DROPS a genuine posted exclusion while dropping the stale-twin carry.
    _store(lam, repo,
           _raw_row("pend1", pending=True, category="groceries"),
           _raw_row("post1", pending=False, category="groceries"))
    _inject(repo, "pend1", budget_excluded=True)
    _inject(repo, "post1", budget_excluded=True)
    reputs = _capture_reputs(repo, monkeypatch)

    summary = lam.dedupe_cleanup.dedupe_pre_reconciliation(repo, dry_run=False)

    assert summary["deduped"] == 1
    rows = _rows(repo)
    assert "pend1" not in rows
    assert rows["post1"]["budget_excluded"] is True          # posted's own exclusion kept
    assert reputs == []                                     # carried == posted -> no re-put
