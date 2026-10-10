"""Tests for the stale-pending age-out sweep (WHIT-79, lambda/age_out.py).

`age_out_stale_pendings(repo, category_repo, today, dry_run)` deletes any pending whose bank `date`
is strictly older than PENDING_AGE_OUT_DAYS (10) before `today` — a ghost that never
got a matching posted (reversed pre-auth / unbalanced count). Window-only: a pending
still in the store is unreconciled, so age alone decides. Dry-run writes nothing.
Backed by the FakeTable `repo` fixture; `today` is injected for a deterministic cutoff.
"""

from datetime import date

import pytest
from _feed_fakes import FakeCategoryRepo

# BankSync account ids that resolve via ACCOUNT_ID_MAP to two distinct internal ids.
_ACCOUNT_A = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"  # -> anz-rewards-black-visa
_ACCOUNT_B = "3zVQJ8Btz_IRmqp78VrQnQ"                        # -> up-spending

# Fixed "today" so the cutoff is deterministic: 2026-07-01 - 10 days -> cutoff 2026-06-21.
# A pending dated < 2026-06-21 is stale; == 2026-06-21 is the boundary (kept); later is young.
_TODAY = date(2026, 7, 1)


def _raw_row(txn_id, date_str, pending=True, amount=-5.50, account=_ACCOUNT_A):
    return {
        "id": txn_id,
        "date": date_str,
        "authorizedDate": date_str,
        "description": "SQ *KKV INTERNATIONAL PTY",
        "merchantName": "SQ *KKV INTERNATIONAL PTY",
        "amount": amount,
        "accountId": account,
        "accountName": "ANZ Rewards Black Visa",
        "category": None,
        "pending": pending,
        "type": "PAYMENT",
        "pendingTransactionId": None,
    }


def _store(lam, repo, *raw_rows):
    """Normalise + store each raw row directly (mimics a row already in DynamoDB)."""
    repo.insert_transactions([lam.banksync.normalise(r) for r in raw_rows])


def _rows(repo):
    """All stored ACCOUNT#/TXN# rows as {transaction_id: item}."""
    return {v["transaction_id"]: v for k, v in repo._table.store.items()
            if k[0].startswith("ACCOUNT#")}


def _sweep(lam, repo, dry_run=False):
    return _sweep_tax(lam, repo, [], dry_run=dry_run)


# --- core: reap the stale, keep the young -----------------------------------


def test_reaps_pending_older_than_window(lam, repo):
    # 21 days old (well past the 10-day window) with no posted twin -> a ghost -> reaped.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))

    summary = _sweep(lam, repo)

    assert summary["stale"] == 1 and summary["reaped"] == 1
    assert "ghost" not in _rows(repo)


def test_boundary_cutoff_date_is_kept_one_day_older_is_reaped(lam, repo):
    # date == cutoff (exactly 10 days) is NOT stale; one day older IS. Locks the
    # strictly-older (`< cutoff`) comparison against an off-by-one.
    _store(lam, repo,
           _raw_row("oncutoff", "2026-06-21"),   # == cutoff -> kept
           _raw_row("dayolder", "2026-06-20"))   # < cutoff  -> reaped

    summary = _sweep(lam, repo)

    rows = _rows(repo)
    assert "oncutoff" in rows       # boundary kept
    assert "dayolder" not in rows   # just past the boundary reaped
    assert summary["reaped"] == 1


# --- only pendings, only by age ---------------------------------------------


def test_posted_rows_are_never_reaped(lam, repo):
    # An OLD posted row is a real settled charge, not a ghost — the sweep queries only
    # pendings, so it must survive regardless of age.
    _store(lam, repo, _raw_row("settled", "2026-06-01", pending=False))

    summary = _sweep(lam, repo)

    assert summary["stale"] == 0
    assert "settled" in _rows(repo)


def test_missing_date_pending_is_skipped_never_raises(lam, repo):
    # No reliable age signal -> never reap (a delete on a guessed row is worse than a
    # lingering ghost). Force the stored `date` empty (normalise always sets one).
    _store(lam, repo, _raw_row("nodate", "2026-06-10"))
    for v in repo._table.store.values():
        if v.get("transaction_id") == "nodate":
            v["date"] = ""

    summary = _sweep(lam, repo)

    assert summary["stale"] == 0 and summary["reaped"] == 0
    assert "nodate" in _rows(repo)


# --- dry-run: the load-bearing safety ---------------------------------------


def test_dry_run_reports_but_reaps_nothing(lam, repo):
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))

    summary = _sweep(lam, repo, dry_run=True)

    assert summary["stale"] == 1 and summary["reaped"] == 0   # found, not deleted
    assert summary["dry_run"] is True
    assert "ghost" in _rows(repo)                             # untouched


# --- multi-account + pagination ---------------------------------------------


def test_sweeps_every_account(lam, repo):
    # A stale ghost on two different accounts -> both reaped (loops ACCOUNT_ID_MAP values).
    _store(lam, repo,
           _raw_row("ghost_a", "2026-06-10", account=_ACCOUNT_A),
           _raw_row("ghost_b", "2026-06-10", account=_ACCOUNT_B))

    summary = _sweep(lam, repo)

    assert summary["reaped"] == 2
    rows = _rows(repo)
    assert "ghost_a" not in rows and "ghost_b" not in rows


# --- lambda_handler wiring: dry-run by default ------------------------------


@pytest.mark.parametrize("event", [
    {}, {"dry_run": "false"}, {"dry_run": 0}, {"dry_run": None}, None, [], "dry_run=false",
])
def test_lambda_handler_defaults_to_dry_run(lam, repo, monkeypatch, event):
    # The live trigger is `event["dry_run"] is False` (identity), NOT truthiness: an
    # empty, mistyped or malformed invoke must not crash and must NOT mutate.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))
    monkeypatch.setattr(lam.age_out, "TransactionRepository", lambda: repo)

    import json
    resp = lam.age_out.lambda_handler(event, None)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["dry_run"] is True and body["reaped"] == 0
    assert "ghost" in _rows(repo)  # untouched


def test_lambda_handler_reaps_when_dry_run_false(lam, repo, monkeypatch):
    # The daily schedule passes {"dry_run": false} -> the sweep runs live.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))
    monkeypatch.setattr(lam.age_out, "TransactionRepository", lambda: repo)

    import json
    resp = lam.age_out.lambda_handler({"dry_run": False}, None)
    body = json.loads(resp["body"])

    assert body["dry_run"] is False and body["reaped"] == 1
    assert "ghost" not in _rows(repo)


# --- resilience: one bad delete must not strand the rest --------------------


def test_delete_failure_on_one_account_does_not_strand_the_others(lam, repo, monkeypatch, caplog):
    # An unattended reaper must be resilient: a failed DeleteItem on one ghost is logged +
    # counted (failed), and the sweep carries on to the remaining ghosts and accounts.
    # Fail-on-revert: without the per-row try/except the DatabaseError aborts the whole
    # sweep and account B's ghost is never reaped.
    _store(lam, repo,
           _raw_row("ghost_a", "2026-06-10", account=_ACCOUNT_A),
           _raw_row("ghost_b", "2026-06-10", account=_ACCOUNT_B))

    real_delete = repo.delete_pending_if_present

    def flaky_delete(pk, sk):
        # anz (account A) is swept before up-spending (account B) alphabetically, so this
        # models the first account's delete failing while a later account must still run.
        if "anz-rewards-black-visa" in pk:
            raise lam.age_out.DatabaseError("Database delete pending failed: throttled")
        return real_delete(pk, sk)

    monkeypatch.setattr(repo, "delete_pending_if_present", flaky_delete)

    import logging
    with caplog.at_level(logging.ERROR, logger="age_out"):
        summary = _sweep(lam, repo)

    rows = _rows(repo)
    assert summary["failed"] == 1 and summary["reaped"] == 1  # A failed, B still reaped
    assert "ghost_a" in rows       # the failed one survives -> retried next daily run
    assert "ghost_b" not in rows   # the other account was NOT stranded by A's failure
    # A PARTIAL failure must NOT escalate to the all-failed ERROR (guards `reaped == 0`).
    assert "ALL deletes failed" not in caplog.text


# --- WHIT-511: rescue a filed pending's category onto its settled twin before the reap ------
#
# The bug: a settled charge that misses all six reconcile tiers lands unfiled while its
# already-categorised pending twin waits; the sweep then reaps the pending and the filing is
# lost. Option C (strict): before reaping a FILED pending, carry its user fields onto a
# confident unfiled settled twin, then reap — so the filing survives and nothing double-counts.
# No confident twin -> reap exactly as today.


def _norm(lam, txn_id, date_str, *, pending, amount=-5.50, account=_ACCOUNT_A,
          description="SQ *KKV INTERNATIONAL PTY", category=None):
    """A normalised row (as it sits in the store), with an optional category to mark it filed."""
    raw = _raw_row(txn_id, date_str, pending=pending, amount=amount, account=account)
    raw["description"] = description
    raw["merchantName"] = description
    raw["category"] = category
    return lam.banksync.normalise(raw)


def _sweep_tax(lam, repo, category_ids, *, dry_run=False, error=False):
    return lam.age_out.age_out_stale_pendings(
        repo, FakeCategoryRepo(category_ids, error=RuntimeError("taxonomy read boom") if error else None),
        today=_TODAY, dry_run=dry_run)


def test_rescue_carries_filing_onto_settled_twin_then_reaps(lam, repo, caplog):
    # A filed stale pending + its unfiled settled twin (same amount, shop, within 3 days).
    # The twin's raw category is a NON-budget one, so recompute must FLIP counts_to_budget
    # to the filed category's value. Fail-on-revert: without the rescue the pending is reaped
    # and the twin stays unfiled (category unchanged); without the recompute counts_to_budget
    # stays False.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category="TRANSFER_OUT")
    repo.insert_transactions([filed, twin])
    assert twin["counts_to_budget"] is False  # TRANSFER_OUT is non-budget

    import logging
    with caplog.at_level(logging.INFO, logger="age_out"):
        summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows            # reaped
    assert summary["rescued"] == 1 and summary["reaped"] == 1
    carried = rows["settled_twin"]
    assert carried["category"] == "groceries"     # filing carried onto the twin
    assert carried["counts_to_budget"] is True    # recomputed for the new category
    assert "rescue: carried category" in caplog.text


def test_rescue_carries_notes_and_tags_when_category_unfiled(lam, repo):
    # "Filed" is not only a category: a note/tag/exclusion the user set is carried too. A
    # pending with an unfiled category but a note IS worth rescuing. Fail-on-revert: drop the
    # notes/tags/budget_excluded arm of _pending_is_filed and this pending isn't rescued.
    filed = _norm(lam, "noted_pending", "2026-06-10", pending=True, category=None)
    filed["notes"] = "work lunch"
    filed["tags"] = ["reimbursable"]
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "noted_pending" not in rows and summary["rescued"] == 1
    assert rows["settled_twin"]["notes"] == "work lunch"
    assert rows["settled_twin"]["tags"] == ["reimbursable"]


@pytest.mark.parametrize("twin_date, twin_over", [
    ("2026-06-12", {"amount": -9.99}),                        # a different amount
    ("2026-06-12", {"description": "TOTALLY DIFFERENT SHOP"}),  # a different shop
    ("2026-06-20", {}),                                       # 10 days > the 3-day window
])
def test_no_confident_twin_reaps_without_a_carry(lam, repo, twin_date, twin_over):
    # Strict: not the same charge -> reaped as today, the twin is untouched.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", twin_date, pending=False, category=None, **twin_over)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows and summary["rescued"] == 0
    assert rows["settled_twin"].get("category") is None


def test_ambiguous_tie_carries_nothing(lam, repo, caplog):
    # Two unfiled settled twins both match -> strict refuses to guess. Reaped as today,
    # both twins untouched. Fail-on-revert: relax "exactly one" and it would carry onto one.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin1 = _norm(lam, "twin_1", "2026-06-11", pending=False, category=None)
    twin2 = _norm(lam, "twin_2", "2026-06-12", pending=False, category=None)
    repo.insert_transactions([filed, twin1, twin2])

    import logging
    with caplog.at_level(logging.INFO, logger="age_out"):
        summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows and summary["rescued"] == 0
    assert rows["twin_1"].get("category") is None and rows["twin_2"].get("category") is None
    assert "no confident twin" in caplog.text


def test_unfiled_ghost_is_reaped_without_rescue(lam, repo):
    # A genuinely unfiled pending (no category, no user fields) is reaped exactly as before —
    # no regression. Fail-on-revert guard for the existing behaviour under the new code path.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))  # category None, no notes
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    assert "ghost" not in _rows(repo) and summary["rescued"] == 0
    assert _rows(repo)["settled_twin"].get("category") is None  # not carried onto


def test_user_filed_twin_is_never_overwritten(lam, repo):
    # WHIT-553: a settled twin the USER (or bank) filed — a real category with NO filed_by_rule
    # stamp — is never overwritten by the rescue. Only a rule-filed twin can be overridden; a
    # user's own filing on the twin is left alone (user-over-user is refused). The twin here has
    # category "petrol" and no stamp, so it is excluded from the candidate pool and nothing carries.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category="petrol")  # user/bank-filed, no stamp
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries", "petrol"])

    rows = _rows(repo)
    assert "filed_pending" not in rows and summary["rescued"] == 0
    assert rows["settled_twin"]["category"] == "petrol"  # the twin's own filing stands


def test_user_override_beats_a_rule_filed_twin(lam, repo):
    # WHIT-553 (the fix): a user-set pending category (real category, NO filed_by_rule stamp)
    # carries onto a settled twin a rule auto-filed at ingest, and the twin's rule stamp is
    # cleared so the twin becomes user-owned. FAIL-ON-REVERT: without broadening the candidate
    # pool to include rule-stamped twins, the twin is excluded and rescued stays 0.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="dining")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category="groceries")
    twin["filed_by_rule"] = "rule-3"  # a rule auto-filed the settled copy at ingest
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["dining", "groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows and summary["rescued"] == 1
    assert rows["settled_twin"]["category"] == "dining"       # user's override won
    assert rows["settled_twin"].get("filed_by_rule") is None  # stamp cleared -> twin is user-owned now


def test_rule_set_pending_does_not_override_a_rule_filed_twin(lam, repo):
    # A rule-stamped pending must never override a rule-filed twin (rule-over-rule is refused):
    # the twin keeps its own rule category. FAIL-ON-REVERT: drop the per-pending narrowing and a
    # rule-set pending would carry onto the rule-filed twin.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="dining")
    filed["filed_by_rule"] = "rule-1"
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category="groceries")
    twin["filed_by_rule"] = "rule-2"
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["dining", "groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows and summary["rescued"] == 0
    assert rows["settled_twin"]["category"] == "groceries"       # the twin's rule filing stands
    assert rows["settled_twin"]["filed_by_rule"] == "rule-2"


def test_dry_run_writes_nothing_but_reports_would_rescue(lam, repo, caplog):
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    import logging
    with caplog.at_level(logging.INFO, logger="age_out"):
        summary = _sweep_tax(lam, repo, ["groceries"], dry_run=True)

    rows = _rows(repo)
    assert "filed_pending" in rows                      # nothing deleted
    assert rows["settled_twin"].get("category") is None     # nothing written
    assert summary["reaped"] == 0 and summary["rescued"] == 0
    assert "WOULD carry" in caplog.text


def test_carry_write_failure_keeps_the_pending(lam, repo, monkeypatch, caplog):
    # The filing must never be deleted before it is safely copied. If the carry write raises,
    # the pending is NOT reaped (retried next sweep) and it is counted failed.
    # Fail-on-revert: reap regardless of the write outcome and the filing is lost on a fault.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    def boom(_rows):
        raise lam.age_out.DatabaseError("Database write failed: throttled")

    monkeypatch.setattr(repo, "insert_transactions", boom)

    import logging
    with caplog.at_level(logging.WARNING, logger="age_out"):
        summary = _sweep_tax(lam, repo, ["groceries"])

    assert "filed_pending" in _rows(repo)               # kept for the retry
    assert summary["failed"] == 1 and summary["rescued"] == 0 and summary["reaped"] == 0
    assert "rescue carry FAILED" in caplog.text


def test_taxonomy_read_failure_reaps_as_today(lam, repo):
    # Fail-open: an unreadable taxonomy disables the rescue, so the sweep reaps exactly as
    # before rather than blocking the ghost cleanup on a category-store outage.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"], error=True)

    assert "filed_pending" not in _rows(repo)           # reaped as today
    assert summary["reaped"] == 1 and summary["rescued"] == 0
    assert _rows(repo)["settled_twin"].get("category") is None  # no rescue attempted


def test_budget_excluded_only_pending_is_rescued(lam, repo):
    # [A23] (P0) No category/notes/tags — ONLY budget_excluded=True. That IS a filing worth
    # saving, so it is rescued and the exclusion carries. Fail-on-revert: drop the
    # budget_excluded arm of _pending_is_filed and this pending is reaped, exclusion lost.
    filed = _norm(lam, "excluded_pending", "2026-06-10", pending=True, category=None)
    filed["budget_excluded"] = True
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "excluded_pending" not in rows and summary["rescued"] == 1
    assert rows["settled_twin"]["budget_excluded"] is True


def test_two_filed_pendings_one_shared_twin_first_wins(lam, repo):
    # [A27] (P0) Two filed pendings both match the SAME single twin. The trim gives it to the
    # FIRST processed pending; the second finds an empty pool and is reaped with no carry —
    # never carried onto twice. Fail-on-revert: drop the trim line and rescued==2.
    first = _norm(lam, "first_pending", "2026-06-09", pending=True, category="groceries")
    second = _norm(lam, "second_pending", "2026-06-10", pending=True, category="petrol")
    twin = _norm(lam, "shared_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([first, second, twin])

    summary = _sweep_tax(lam, repo, ["groceries", "petrol"])

    rows = _rows(repo)
    assert summary["rescued"] == 1 and summary["reaped"] == 2
    assert "first_pending" not in rows and "second_pending" not in rows
    assert rows["shared_twin"]["category"] == "groceries"


def test_no_cross_account_carry(lam, repo):
    # [A29] (P0) A filed pending in account A + a matching twin in account B. The candidate
    # pool is loaded PER ACCOUNT, so A's filing must never land on B's charge — A reaped with
    # no rescue, B untouched. Fail-on-revert: make get_posted cross-account and rescued==1.
    filed = _norm(lam, "filed_a", "2026-06-10", pending=True, category="groceries", account=_ACCOUNT_A)
    twin_b = _norm(lam, "twin_b", "2026-06-11", pending=False, category=None, account=_ACCOUNT_B)
    repo.insert_transactions([filed, twin_b])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "filed_a" not in rows
    assert summary["rescued"] == 0
    assert rows["twin_b"].get("category") is None


def test_rescue_at_exactly_three_days_but_not_four(lam, repo):
    # [A31] (P0) Integration boundary: twin +3 days IS rescued; a fresh run with twin +4 is NOT.
    filed3 = _norm(lam, "filed3", "2026-06-10", pending=True, category="groceries")
    twin3 = _norm(lam, "twin3", "2026-06-13", pending=False, category=None)
    repo.insert_transactions([filed3, twin3])
    s3 = _sweep_tax(lam, repo, ["groceries"])
    assert s3["rescued"] == 1 and _rows(repo)["twin3"]["category"] == "groceries"

    filed4 = _norm(lam, "filed4", "2026-06-10", pending=True, category="groceries")
    twin4 = _norm(lam, "twin4", "2026-06-14", pending=False, category=None)
    repo.insert_transactions([filed4, twin4])
    s4 = _sweep_tax(lam, repo, ["groceries"])
    assert s4["rescued"] == 0 and _rows(repo)["twin4"].get("category") is None


def test_posted_read_failure_reaps_as_today_without_aborting(lam, repo, monkeypatch, caplog):
    # A posted-scan fault on one account must NOT abort the unattended sweep — the rescue is
    # skipped (reap as today) and the sweep completes. Fail-on-revert: drop the try/except
    # around the posted read and the DatabaseError propagates out, stranding every later ghost.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    real_read = repo.get_account_transactions

    def boom(account_id, status):
        if status == "posted":
            raise lam.age_out.DatabaseError("Database read failed: throttled")
        return real_read(account_id, status)

    monkeypatch.setattr(repo, "get_account_transactions", boom)

    import logging
    with caplog.at_level(logging.WARNING, logger="age_out"):
        summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows              # reaped as today (rescue skipped)
    assert summary["rescued"] == 0 and summary["reaped"] == 1
    assert rows["settled_twin"].get("category") is None
    assert "could not read posted rows" in caplog.text


def test_notes_only_pending_never_overrides_a_rule_twin(lam, repo):
    # WHIT-553 [G-NOTES-A] (P0) A pending filed ONLY by a note (category unfiled) is NOT a
    # user-set CATEGORY, so it may carry onto an unfiled twin only — never override a rule twin.
    # Here the only candidate is a rule-filed twin, so eligible is empty -> no carry, rule twin
    # untouched (keeps category + stamp + no note). FAIL-ON-REVERT: drop the per-pending
    # narrowing (eligible = carry_candidates) and the note carries onto the rule twin -> rescued 1.
    filed = _norm(lam, "noted_pending", "2026-06-10", pending=True, category=None)
    filed["notes"] = "work lunch"
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category="groceries")
    twin["filed_by_rule"] = "rule-5"
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "noted_pending" not in rows and summary["rescued"] == 0  # reaped, filing lost (accepted)
    assert rows["settled_twin"]["category"] == "groceries"
    assert rows["settled_twin"]["filed_by_rule"] == "rule-5"
    assert rows["settled_twin"].get("notes") is None               # note did NOT land on the rule twin


# --- WHIT-545: the rescue carry now gates a stored raw category ------------------------------

def test_whit545_note_rescue_does_not_carry_the_pendings_raw_enum_onto_the_twin(lam, repo):
    # A pending with a raw (unfiled) category BUT a user note is rescued for the note's sake.
    # WHIT-545 wires is_unfiled into the rescue carry, so the pending's raw enum ("FOOD_AND_DRINK")
    # must NOT be copied onto the twin — the twin keeps its own category — while the note DOES
    # carry. FAIL-ON-REVERT: drop the is_unfiled gate in with_carried_category and the twin's
    # category is clobbered to "FOOD_AND_DRINK" (and its budget flag flips with it).
    filed = _norm(lam, "noted_pending", "2026-06-10", pending=True, category="FOOD_AND_DRINK")
    filed["notes"] = "work lunch"
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category="TRANSFER_OUT")
    repo.insert_transactions([filed, twin])
    assert twin["counts_to_budget"] is False   # TRANSFER_OUT is a non-budget enum

    summary = _sweep_tax(lam, repo, ["groceries"])   # neither raw enum is a real taxonomy id

    rows = _rows(repo)
    assert "noted_pending" not in rows and summary["rescued"] == 1
    carried = rows["settled_twin"]
    assert carried["notes"] == "work lunch"          # the note (the reason for the rescue) carries
    assert carried["category"] == "TRANSFER_OUT"     # raw enum NOT clobbered onto the twin
    assert carried["counts_to_budget"] is False       # flag recomputed for the category that stays


# --- WHIT-666 QA: an earlier carried edit survives a later sweep ---------------------------


def test_a_later_sweep_never_overwrites_the_note_an_earlier_sweep_carried(lam, repo):
    # [A1] (P0) The age-out re-reads the settled charges every day, so its in-run "claimed twin"
    # guard doesn't reach across days. Day 1 carries "work lunch"; on day 2 a second stale
    # pending at the same shop and amount must not overwrite it — it's reaped with no carry.
    first = _norm(lam, "first_pending", "2026-06-10", pending=True, category=None)
    first["notes"] = "work lunch"
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([first, twin])

    day_one = _sweep_tax(lam, repo, ["groceries"])

    assert day_one["rescued"] == 1
    assert _rows(repo)["settled_twin"]["notes"] == "work lunch"

    second = _norm(lam, "second_pending", "2026-06-12", pending=True, category=None)
    second["notes"] = "coffee with Jo"
    second["tags"] = ["reimbursable"]
    repo.insert_transactions([second])

    day_two = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert day_two["rescued"] == 0 and day_two["reaped"] == 1
    assert "second_pending" not in rows
    assert rows["settled_twin"]["notes"] == "work lunch"
    assert not rows["settled_twin"].get("tags")


def test_a_later_sweep_never_lands_a_category_on_a_charge_an_earlier_sweep_excluded(lam, repo):
    # [A2] (P1) Exclusion-only carry leaves the twin unfiled, so before WHIT-666 a later
    # user-filed pending could still land its category and note on it. Now it's claimed.
    first = _norm(lam, "first_pending", "2026-06-10", pending=True, category=None)
    first["budget_excluded"] = True
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([first, twin])

    assert _sweep_tax(lam, repo, ["groceries"])["rescued"] == 1

    second = _norm(lam, "second_pending", "2026-06-12", pending=True, category="groceries")
    second["notes"] = "not a transfer"
    repo.insert_transactions([second])

    day_two = _sweep_tax(lam, repo, ["groceries"])

    carried = _rows(repo)["settled_twin"]
    assert day_two["rescued"] == 0
    assert carried["budget_excluded"] is True
    assert carried.get("category") != "groceries"
    assert not carried.get("notes")
