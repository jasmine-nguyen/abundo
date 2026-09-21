"""Tests for the stale-pending age-out sweep (WHIT-79, lambda/age_out.py).

`age_out_stale_pendings(repo, today, dry_run)` deletes any pending whose bank `date`
is strictly older than PENDING_AGE_OUT_DAYS (10) before `today` — a ghost that never
got a matching posted (reversed pre-auth / unbalanced count). Window-only: a pending
still in the store is unreconciled, so age alone decides. Dry-run writes nothing.
Backed by the FakeTable `repo` fixture; `today` is injected for a deterministic cutoff.
"""

from datetime import date

# BankSync account ids that resolve via ACCOUNT_ID_MAP to two distinct internal ids.
_ACCOUNT_A = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"  # -> anz-rewards-black-visa
_ACCOUNT_B = "3zVQJ8Btz_IRmqp78VrQnQ"                        # -> up-spending
_ACCOUNT_C = "T6d8ppsYssBDFCwl1qEb0w"                        # -> up-homeloan

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
    repo.insert_transactions([lam.banksync.BankSyncClient.normalise(r) for r in raw_rows])


def _rows(repo):
    """All stored ACCOUNT#/TXN# rows as {transaction_id: item}."""
    return {v["transaction_id"]: v for k, v in repo._table.store.items()
            if k[0].startswith("ACCOUNT#")}


def _sweep(lam, repo, dry_run=False):
    return lam.age_out.age_out_stale_pendings(repo, today=_TODAY, dry_run=dry_run)


# --- core: reap the stale, keep the young -----------------------------------


def test_reaps_pending_older_than_window(lam, repo):
    # 21 days old (well past the 10-day window) with no posted twin -> a ghost -> reaped.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))

    summary = _sweep(lam, repo)

    assert summary["stale"] == 1 and summary["reaped"] == 1
    assert "ghost" not in _rows(repo)


def test_keeps_pending_inside_window(lam, repo):
    # 1 day old -> a normal, still-settling pending -> untouched.
    _store(lam, repo, _raw_row("fresh", "2026-06-30"))

    summary = _sweep(lam, repo)

    assert summary["stale"] == 0 and summary["reaped"] == 0
    assert "fresh" in _rows(repo)


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


def test_unbalanced_count_and_reversed_preauth_survivors_are_reaped(lam, repo):
    # The card's headline cases, at their end state: two old pendings that no posted ever
    # matched (an unbalanced 2-pending-1-posted count, and a reversed pre-auth) — both
    # are lone ghosts past the window, so both reap.
    _store(lam, repo,
           _raw_row("unbalanced_survivor", "2026-06-05"),
           _raw_row("reversed_preauth", "2026-06-08"))

    summary = _sweep(lam, repo)

    assert summary["reaped"] == 2
    rows = _rows(repo)
    assert "unbalanced_survivor" not in rows and "reversed_preauth" not in rows


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


def test_reaps_stale_pending_beyond_first_page(lam, repo):
    # The stale pending sits on a later query page. If get_pending_transactions_for_account
    # didn't paginate, the sweep would miss it and the ghost would linger (WHIT-82 class).
    _store(lam, repo,
           _raw_row("fresh1", "2026-06-30"),
           _raw_row("fresh2", "2026-06-29"),
           _raw_row("ghost", "2026-06-05"))
    repo._table.page_size = 2

    summary = _sweep(lam, repo)

    assert summary["reaped"] == 1
    assert "ghost" not in _rows(repo)
    assert "fresh1" in _rows(repo) and "fresh2" in _rows(repo)


# --- accepted trade-off: a slow-but-legit pending -----------------------------


def test_slow_pending_past_window_is_reaped_not_duplicated(lam, repo):
    # Documented WHIT-79 trade-off: a pending that settles at day 11+ is reaped at day 10.
    # The later posted then lands fresh (uncategorised) with no duplicate pending beside
    # it — the reap must remove the pending so a subsequent posted is not a twin.
    _store(lam, repo, _raw_row("slowpender", "2026-06-15"))

    _sweep(lam, repo)

    assert "slowpender" not in _rows(repo)  # gone -> a later posted can't duplicate it


# --- lambda_handler wiring: dry-run by default ------------------------------


def test_lambda_handler_defaults_to_dry_run(lam, repo, monkeypatch):
    # An empty/accidental invoke must NOT mutate.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))
    monkeypatch.setattr(lam.age_out, "TransactionRepository", lambda: repo)

    import json
    resp = lam.age_out.lambda_handler({}, None)
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

    real_delete = repo._delete_pending_if_present

    def flaky_delete(pk, sk):
        # anz (account A) is swept before up-spending (account B) alphabetically, so this
        # models the first account's delete failing while a later account must still run.
        if "anz-rewards-black-visa" in pk:
            raise lam.age_out.DatabaseError("Database delete pending failed: throttled")
        return real_delete(pk, sk)

    monkeypatch.setattr(repo, "_delete_pending_if_present", flaky_delete)

    import logging
    with caplog.at_level(logging.ERROR, logger="age_out"):
        summary = _sweep(lam, repo)

    rows = _rows(repo)
    assert summary["failed"] == 1 and summary["reaped"] == 1  # A failed, B still reaped
    assert "ghost_a" in rows       # the failed one survives -> retried next daily run
    assert "ghost_b" not in rows   # the other account was NOT stranded by A's failure
    # A PARTIAL failure must NOT escalate to the all-failed ERROR (guards `reaped == 0`).
    assert "ALL deletes failed" not in caplog.text


# --- observability: the LIVE-summary line (the only dry-run-revert signal) ----


def test_live_and_dry_run_emit_distinct_summary_log_lines(lam, repo, caplog):
    # The distinct "LIVE summary" line is the design's ONLY signal that a scheduled run
    # actually ran live (vs a silent revert to dry-run reaping nothing forever). Lock that
    # a live run emits it and a dry-run emits the DRY-RUN variant instead — so a refactor
    # can't collapse the two branches unnoticed.
    import logging

    _store(lam, repo, _raw_row("ghost", "2026-06-10"))
    with caplog.at_level(logging.INFO, logger="age_out"):
        _sweep(lam, repo, dry_run=False)
    assert "LIVE summary" in caplog.text
    assert "DRY-RUN summary" not in caplog.text

    caplog.clear()
    _store(lam, repo, _raw_row("ghost2", "2026-06-09"))
    with caplog.at_level(logging.INFO, logger="age_out"):
        _sweep(lam, repo, dry_run=True)
    assert "DRY-RUN summary" in caplog.text
    assert "LIVE summary" not in caplog.text


def test_live_run_with_all_deletes_failing_logs_an_error(lam, repo, monkeypatch, caplog):
    # A live run that reaps 0 of N stale ghosts because EVERY delete failed is a systemic
    # failure — it must escalate to ERROR (which the metric-filter alarm keys on), not hide
    # behind a 200 with only WARNs. A partial failure (some reaped) must NOT trip the ERROR.
    import logging
    _store(lam, repo,
           _raw_row("g1", "2026-06-10", account=_ACCOUNT_A),
           _raw_row("g2", "2026-06-10", account=_ACCOUNT_B))

    def always_fail(pk, sk):
        raise lam.age_out.DatabaseError("Database delete pending failed: throttled")

    monkeypatch.setattr(repo, "_delete_pending_if_present", always_fail)

    with caplog.at_level(logging.ERROR, logger="age_out"):
        summary = _sweep(lam, repo)

    assert summary["reaped"] == 0 and summary["failed"] == 2
    assert "ALL deletes failed" in caplog.text


# --- idempotency / re-run safety (WHIT-79 gap coverage) ---------------------


def test_second_live_sweep_reaps_nothing_and_does_not_raise(lam, repo):
    # Running the daily sweep twice in a row: the first reaps the ghost, the second
    # finds an empty store and is a clean no-op (reaped=0, stale=0) — not a re-delete
    # error. Guards the tolerant delete + the query-fresh-each-run contract.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))

    first = _sweep(lam, repo)
    second = _sweep(lam, repo)

    assert first["reaped"] == 1
    assert second["stale"] == 0 and second["reaped"] == 0
    assert "ghost" not in _rows(repo)


def test_dry_run_then_live_reaps_the_same_ghost(lam, repo):
    # A dry-run must not mutate, so a later LIVE run still sees and reaps the ghost.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))

    dry = _sweep(lam, repo, dry_run=True)
    live = _sweep(lam, repo, dry_run=False)

    assert dry["stale"] == 1 and dry["reaped"] == 0
    assert live["reaped"] == 1
    assert "ghost" not in _rows(repo)


# --- age-signal edges the boundary test doesn't hit -------------------------


def test_future_dated_pending_is_never_reaped(lam, repo):
    # A pending dated AFTER today (clock skew / a post-dated auth) is lexicographically
    # >= cutoff, so the string compare keeps it — a future date is the opposite of stale.
    _store(lam, repo, _raw_row("future", "2026-07-15"))

    summary = _sweep(lam, repo)

    assert summary["stale"] == 0 and summary["reaped"] == 0
    assert "future" in _rows(repo)


def test_none_date_pending_is_skipped_not_reaped(lam, repo):
    # `date` absent/None (not just "") -> `not pending_date` short-circuits BEFORE the
    # `>= cutoff` string compare, so no TypeError and no reap of a row with no age signal.
    _store(lam, repo, _raw_row("nulldate", "2026-06-10"))
    for v in repo._table.store.values():
        if v.get("transaction_id") == "nulldate":
            v["date"] = None

    summary = _sweep(lam, repo)

    assert summary["stale"] == 0 and summary["reaped"] == 0
    assert "nulldate" in _rows(repo)


# --- multi-account correctness ----------------------------------------------


def test_sweep_visits_the_home_loan_account_too(lam, repo):
    # The sweep must visit EVERY internal id in ACCOUNT_ID_MAP, not just the spending
    # accounts — a stale ghost on the home-loan account is reaped and `accounts` counts
    # them all. Guards against an account being skipped.
    _store(lam, repo, _raw_row("ghost_homeloan", "2026-06-10", account=_ACCOUNT_C))

    summary = _sweep(lam, repo)

    assert summary["accounts"] == len(set(lam.age_out.ACCOUNT_ID_MAP.values()))
    assert summary["reaped"] == 1
    assert "ghost_homeloan" not in _rows(repo)


def test_no_cross_account_bleed(lam, repo):
    # A stale ghost on account A and a fresh pending on account B: only A's is reaped,
    # B's survives. Locks that the per-account query keys on its own partition.
    _store(lam, repo,
           _raw_row("ghost_a", "2026-06-10", account=_ACCOUNT_A),
           _raw_row("fresh_b", "2026-06-30", account=_ACCOUNT_B))

    summary = _sweep(lam, repo)

    rows = _rows(repo)
    assert summary["reaped"] == 1
    assert "ghost_a" not in rows
    assert "fresh_b" in rows


# --- observability contract --------------------------------------------------


def test_summary_surfaces_cutoff_and_account_count(lam, repo):
    # The summary carries the exact cutoff (2026-07-01 - 10d) and account count that the
    # LIVE log line reports — the only signal a silent dry-run reversion is detectable by.
    summary = _sweep(lam, repo)

    assert summary["cutoff"] == "2026-06-21"
    assert summary["cutoff"] == lam.age_out._cutoff_date(_TODAY)
    assert summary["accounts"] == len(set(lam.age_out.ACCOUNT_ID_MAP.values()))
    assert summary["dry_run"] is False


# --- handler live-trigger guard: ONLY boolean False goes live ---------------


def test_handler_stringy_false_stays_dry_run(lam, repo, monkeypatch):
    # The live trigger is `event["dry_run"] is False` (identity), NOT truthiness — a
    # JSON string "false" or a 0 must NOT mutate. A loosened `== False` / `not ...` check
    # would wrongly go live off a mistyped schedule input; this locks the safe default.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))
    monkeypatch.setattr(lam.age_out, "TransactionRepository", lambda: repo)

    import json
    for bad in ({"dry_run": "false"}, {"dry_run": 0}, {"dry_run": None}):
        body = json.loads(lam.age_out.lambda_handler(bad, None)["body"])
        assert body["dry_run"] is True, bad
        assert body["reaped"] == 0, bad
    assert "ghost" in _rows(repo)  # untouched by every non-False input


def test_handler_non_dict_event_stays_dry_run(lam, repo, monkeypatch):
    # A malformed (non-dict) invoke — None or a list — must not crash and must not
    # mutate: isinstance(event, dict) fails closed to dry-run.
    _store(lam, repo, _raw_row("ghost", "2026-06-10"))
    monkeypatch.setattr(lam.age_out, "TransactionRepository", lambda: repo)

    import json
    for bad in (None, [], "dry_run=false"):
        body = json.loads(lam.age_out.lambda_handler(bad, None)["body"])
        assert body["dry_run"] is True, bad
        assert body["reaped"] == 0, bad
    assert "ghost" in _rows(repo)


# --- WHIT-511: rescue a filed pending's category onto its settled twin before the reap ------
#
# The bug: a settled charge that misses all six reconcile tiers lands unfiled while its
# already-categorised pending twin waits; the sweep then reaps the pending and the filing is
# lost. Option C (strict): before reaping a FILED pending, carry its user fields onto a
# confident unfiled settled twin, then reap — so the filing survives and nothing double-counts.
# No confident twin -> reap exactly as today.


class _FakeCategoryRepo:
    """Local read-only taxonomy stub. A shared FakeCategoryRepo lives in
    tests/shared/_feed_fakes.py but isn't on the lambda test path, and WHIT-520 is still
    consolidating the per-suite copies on its own branch — so the sibling suites
    (test_rule_ingest) keep a local one and this does too, to avoid colliding with it."""

    def __init__(self, category_ids, *, error=False):
        self._categories = [{"id": cid} for cid in category_ids]
        self._error = error

    def list_categories(self):
        if self._error:
            raise RuntimeError("taxonomy read boom")
        return [dict(category) for category in self._categories]


def _norm(lam, txn_id, date_str, *, pending, amount=-5.50, account=_ACCOUNT_A,
          description="SQ *KKV INTERNATIONAL PTY", category=None):
    """A normalised row (as it sits in the store), with an optional category to mark it filed."""
    raw = _raw_row(txn_id, date_str, pending=pending, amount=amount, account=account)
    raw["description"] = description
    raw["merchantName"] = description
    raw["category"] = category
    return lam.banksync.BankSyncClient.normalise(raw)


def _sweep_tax(lam, repo, category_ids, *, dry_run=False, error=False):
    return lam.age_out.age_out_stale_pendings(
        repo, _FakeCategoryRepo(category_ids, error=error), today=_TODAY, dry_run=dry_run)


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


def test_no_rescue_when_amount_differs(lam, repo):
    # Strict: a different amount is not the same charge. Reaped as today, no carry.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, amount=-5.50, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, amount=-9.99, category=None)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows and summary["rescued"] == 0
    assert rows["settled_twin"].get("category") is None   # untouched


def test_no_rescue_when_merchant_differs(lam, repo):
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False,
                 description="TOTALLY DIFFERENT SHOP", category=None)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    assert "filed_pending" not in _rows(repo) and summary["rescued"] == 0
    assert _rows(repo)["settled_twin"].get("category") is None


def test_no_rescue_when_dates_more_than_window_apart(lam, repo):
    # 2026-06-10 vs 2026-06-20 is 10 days > the 3-day carry window. No carry.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-20", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    assert "filed_pending" not in _rows(repo) and summary["rescued"] == 0
    assert _rows(repo)["settled_twin"].get("category") is None


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


def test_user_override_with_both_an_unfiled_and_a_rule_twin_is_ambiguous(lam, repo):
    # Broadening the pool means a user-set pending can now match BOTH an unfiled twin AND a
    # rule-filed twin. Two candidates -> ambiguous -> carries nothing (a wrong carry is worse than
    # a missed one, WHIT-511). Both twins are left untouched.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="dining")
    unfiled_twin = _norm(lam, "unfiled_twin", "2026-06-11", pending=False, category=None)
    rule_twin = _norm(lam, "rule_twin", "2026-06-12", pending=False, category="groceries")
    rule_twin["filed_by_rule"] = "rule-9"
    repo.insert_transactions([filed, unfiled_twin, rule_twin])

    summary = _sweep_tax(lam, repo, ["dining", "groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows and summary["rescued"] == 0
    assert rows["unfiled_twin"].get("category") is None          # untouched
    assert rows["rule_twin"]["category"] == "groceries"          # untouched
    assert rows["rule_twin"]["filed_by_rule"] == "rule-9"


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


def test_no_category_repo_reaps_as_before(lam, repo):
    # The optional category_repo keeps every existing caller unchanged: with none passed, a
    # filed pending is reaped with no rescue (the pre-WHIT-511 behaviour).
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    summary = lam.age_out.age_out_stale_pendings(repo, today=_TODAY, dry_run=False)

    assert "filed_pending" not in _rows(repo)
    assert summary["rescued"] == 0
    assert _rows(repo)["settled_twin"].get("category") is None


def test_wrong_carry_onto_coincidental_same_chain_charge(lam, repo):
    # [A20] (P1) A filed pending's REAL twin already reconciled away, leaving only a
    # COINCIDENTAL settled charge at the same chain, same amount, within 3 days — a
    # DIFFERENT purchase. Strict still carries onto it: exact-amount + chain-merchant + ±3d
    # is NOT purchase-identity, so the filing lands on the wrong charge. ACCEPTED false-positive.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, amount=-5.50, category="groceries")
    coincidental = _norm(lam, "other_purchase", "2026-06-11", pending=False, amount=-5.50, category=None)
    coincidental["pending_transaction_id"] = "a-totally-different-pending"
    repo.insert_transactions([filed, coincidental])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows
    assert summary["rescued"] == 1
    assert rows["other_purchase"]["category"] == "groceries"


def test_tip_adjusted_settlement_is_not_rescued(lam, repo):
    # [A21] (P1) A tipped settlement: pending -50.00 settles -55.00. The rescue uses EXACT
    # amount (deliberately strict — narrower than the reconciler's tip tier), so the twin is
    # rejected and the filing is lost when the pending is reaped. Pinned as an accepted miss.
    filed = _norm(lam, "tipped_pending", "2026-06-10", pending=True, amount=-50.00, category="groceries")
    tipped_twin = _norm(lam, "tipped_twin", "2026-06-11", pending=False, amount=-55.00, category=None)
    repo.insert_transactions([filed, tipped_twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "tipped_pending" not in rows
    assert summary["rescued"] == 0
    assert rows["tipped_twin"].get("category") is None


def test_one_day_clock_skew_twin_is_rescued(lam, repo):
    # [A22] (P0) The common swipe->settle skew: pending dated one day off its twin (within ±3)
    # IS rescued. Guards the window isn't so tight it drops the normal case.
    filed = _norm(lam, "skew_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "skew_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    assert "skew_pending" not in _rows(repo) and summary["rescued"] == 1
    assert _rows(repo)["skew_twin"]["category"] == "groceries"


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


def test_income_pending_is_treated_as_filed_and_rescues(lam, repo):
    # [A24] (P2) is_unfiled_category treats "income" as filed, so a bank-tagged "income"
    # pending reads as filed and carries "income" onto the twin even when the user set
    # nothing. Pinned as a known, deliberate consequence of the OR-arm.
    filed = _norm(lam, "income_pending", "2026-06-10", pending=True, category="income")
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "income_pending" not in rows and summary["rescued"] == 1
    assert rows["settled_twin"]["category"] == "income"


def test_recompute_forces_counts_to_budget_false_on_homeloan(lam, repo):
    # [A25] (P0) "groceries" WOULD count on a spending account, but the twin is on the
    # home-loan account, where counts_to_budget is always False. The recompute keys on the
    # account, not just the category — even against a stale True. Fail-on-revert: drop the
    # recompute line and the stale True survives.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries", account=_ACCOUNT_C)
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None, account=_ACCOUNT_C)
    repo.insert_transactions([filed, twin])
    for v in repo._table.store.values():
        if v.get("transaction_id") == "settled_twin":
            v["counts_to_budget"] = True

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert summary["rescued"] == 1
    assert rows["settled_twin"]["category"] == "groceries"
    assert rows["settled_twin"]["counts_to_budget"] is False


def test_two_filed_pendings_each_get_their_own_twin(lam, repo):
    # [A26] (P1) Two filed pendings at DIFFERENT merchants, one twin each. The trim after the
    # first carry must not starve the second — both are rescued onto the right twin.
    p1 = _norm(lam, "p_coles", "2026-06-10", pending=True, amount=-5.50,
               description="SQ *KKV INTERNATIONAL PTY", category="groceries")
    t1 = _norm(lam, "t_coles", "2026-06-11", pending=False, amount=-5.50,
               description="SQ *KKV INTERNATIONAL PTY", category=None)
    p2 = _norm(lam, "p_woolies", "2026-06-10", pending=True, amount=-7.00,
               description="WOOLWORTHS SUPERMARKET AU", category="petrol")
    t2 = _norm(lam, "t_woolies", "2026-06-11", pending=False, amount=-7.00,
               description="WOOLWORTHS SUPERMARKET AU", category=None)
    repo.insert_transactions([p1, t1, p2, t2])

    summary = _sweep_tax(lam, repo, ["groceries", "petrol"])

    rows = _rows(repo)
    assert summary["rescued"] == 2 and summary["reaped"] == 2
    assert rows["t_coles"]["category"] == "groceries"
    assert rows["t_woolies"]["category"] == "petrol"


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


def test_two_filed_pendings_two_identical_twins_is_ambiguous_for_both(lam, repo):
    # [A28] (P1) Two filed pendings AND two identical twins. Each pending sees TWO matching
    # twins -> ambiguous -> no carry -> no trim -> the second is ambiguous too. BOTH filings
    # lost. Pinned as the accepted cost of "a wrong carry is worse than a missed one".
    p1 = _norm(lam, "p1", "2026-06-09", pending=True, category="groceries")
    p2 = _norm(lam, "p2", "2026-06-10", pending=True, category="groceries")
    t1 = _norm(lam, "t1", "2026-06-11", pending=False, category=None)
    t2 = _norm(lam, "t2", "2026-06-12", pending=False, category=None)
    repo.insert_transactions([p1, p2, t1, t2])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert summary["rescued"] == 0 and summary["reaped"] == 2
    assert rows["t1"].get("category") is None and rows["t2"].get("category") is None


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


def test_within_days_boundaries(lam):
    # [A30] (P0) Symmetric, INCLUSIVE at exactly _CARRY_DATE_SKEW_DAYS. Fail-on-revert: change
    # `<= days` to `< days` and the exactly-3 case flips.
    w = lam.age_out._within_days
    assert w("2026-06-10", "2026-06-13", 3) is True
    assert w("2026-06-13", "2026-06-10", 3) is True
    assert w("2026-06-10", "2026-06-14", 3) is False
    assert w("2026-06-10", "2026-06-10", 3) is True
    assert w(None, "2026-06-10", 3) is False
    assert w("2026-06-10", "", 3) is False
    assert w("not-a-date", "2026-06-10", 3) is False


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


def test_second_sweep_after_rescue_does_not_recarry(lam, repo, monkeypatch):
    # [A32] (P0) Sweep 1 carries but the delete FAILS, so the pending lingers. Sweep 2 sees
    # the twin now FILED (excluded) -> reaps the pending with no second carry.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    real_delete = repo._delete_pending_if_present

    def fail_delete(pk, sk):
        raise lam.age_out.DatabaseError("Database delete pending failed: throttled")

    monkeypatch.setattr(repo, "_delete_pending_if_present", fail_delete)
    first = _sweep_tax(lam, repo, ["groceries"])
    assert first["rescued"] == 1 and first["failed"] == 1 and first["reaped"] == 0
    assert "filed_pending" in _rows(repo)
    assert _rows(repo)["settled_twin"]["category"] == "groceries"

    monkeypatch.setattr(repo, "_delete_pending_if_present", real_delete)
    second = _sweep_tax(lam, repo, ["groceries"])
    rows = _rows(repo)
    assert second["rescued"] == 0 and second["reaped"] == 1
    assert "filed_pending" not in rows
    assert rows["settled_twin"]["category"] == "groceries"


def test_get_posted_paginates_beyond_first_page(lam, repo):
    # [A33] (P0) A posted row beyond the first query page must still be returned (WHIT-82).
    # Fail-on-revert: drop the LastEvaluatedKey loop and the later-page posted disappears.
    internal_a = lam.banksync.resolve_account_id(_ACCOUNT_A)
    p1 = _norm(lam, "posted1", "2026-06-01", pending=False)
    p2 = _norm(lam, "posted2", "2026-06-02", pending=False)
    pend = _norm(lam, "pending1", "2026-06-03", pending=True)
    target = _norm(lam, "posted_target", "2026-06-04", pending=False)
    repo.insert_transactions([p1, p2, pend, target])
    repo._table.page_size = 2

    got = {r["transaction_id"] for r in repo.get_posted_transactions_for_account(internal_a)}

    assert got == {"posted1", "posted2", "posted_target"}
    assert "pending1" not in got


def test_get_posted_returns_only_posted_rows(lam, repo):
    # [A34] (P0) Only status==posted comes back — never a pending. Fail-on-revert: swap the
    # filter to PENDING_STATUS and this returns the wrong row.
    internal_a = lam.banksync.resolve_account_id(_ACCOUNT_A)
    repo.insert_transactions([
        _norm(lam, "the_posted", "2026-06-01", pending=False),
        _norm(lam, "a_pending", "2026-06-02", pending=True),
    ])

    got = {r["transaction_id"] for r in repo.get_posted_transactions_for_account(internal_a)}

    assert got == {"the_posted"}


def test_get_posted_is_per_account(lam, repo):
    # [A35] (P1) The query keys on the account partition — a posted in another account is not
    # returned. This is what makes the rescue's candidate pool per-account.
    internal_a = lam.banksync.resolve_account_id(_ACCOUNT_A)
    repo.insert_transactions([
        _norm(lam, "posted_a", "2026-06-01", pending=False, account=_ACCOUNT_A),
        _norm(lam, "posted_b", "2026-06-01", pending=False, account=_ACCOUNT_B),
    ])

    got = {r["transaction_id"] for r in repo.get_posted_transactions_for_account(internal_a)}

    assert got == {"posted_a"}


def test_posted_read_failure_reaps_as_today_without_aborting(lam, repo, monkeypatch, caplog):
    # A posted-scan fault on one account must NOT abort the unattended sweep — the rescue is
    # skipped (reap as today) and the sweep completes. Fail-on-revert: drop the try/except
    # around the posted read and the DatabaseError propagates out, stranding every later ghost.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    twin = _norm(lam, "settled_twin", "2026-06-11", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    def boom(_account_id):
        raise lam.age_out.DatabaseError("Database read failed: throttled")

    monkeypatch.setattr(repo, "get_posted_transactions_for_account", boom)

    import logging
    with caplog.at_level(logging.WARNING, logger="age_out"):
        summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows              # reaped as today (rescue skipped)
    assert summary["rescued"] == 0 and summary["reaped"] == 1
    assert rows["settled_twin"].get("category") is None
    assert "could not read posted rows" in caplog.text


# [G8] [A17] A rule-filed stale pending (category + stamp) is rescued onto its settled twin
# before the reap. The rescue reuses _with_carried_category, so the stamp must ride onto the twin
# — history still explains the carried category. FAIL-ON-REVERT: drop the carry block in
# _with_carried_category and the rescued twin keeps the category but loses the stamp.
def test_age_out_rescue_carries_the_rule_stamp_onto_the_twin(lam, repo):
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="groceries")
    filed["filed_by_rule"] = "rule-7"
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category=None)
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert summary["rescued"] == 1 and "filed_pending" not in rows
    assert rows["settled_twin"]["category"] == "groceries"
    assert rows["settled_twin"]["filed_by_rule"] == "rule-7"


# ============================================================================
# WHIT-553 GAP TESTS (adversarial, added by QA) — override matrix corners the
# implementer's own tests don't reach. Each carries the scenario id it pins.
# ============================================================================


def test_income_pending_overrides_a_rule_filed_twin(lam, repo):
    # WHIT-553 [G-INCOME] (P1) CONTRACT PIN, not a wish: is_unfiled_category treats "income"
    # as FILED (rule_engine.is_unfiled_category: category != "income" ...), so a bank-tagged
    # "income" pending with NO filed_by_rule stamp reads as user-set and is allowed to OVERRIDE
    # a rule-filed twin — same power as a hand-set category. Pinned so the consequence is a
    # conscious contract. FAIL-ON-REVERT: narrow the candidate pool back to unfiled-only and the
    # rule twin is excluded -> rescued 0.
    filed = _norm(lam, "income_pending", "2026-06-10", pending=True, category="income")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category="groceries")
    twin["filed_by_rule"] = "rule-4"
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["groceries"])  # "income" is filed regardless of taxonomy

    rows = _rows(repo)
    assert "income_pending" not in rows and summary["rescued"] == 1
    assert rows["settled_twin"]["category"] == "income"          # income beat the rule's guess
    assert rows["settled_twin"].get("filed_by_rule") is None     # hand/bank carry clears the stamp


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


def test_notes_only_pending_prefers_the_unfiled_twin_over_a_rule_twin(lam, repo):
    # WHIT-553 [G-NOTES-B] (P1) Same notes-only pending, but now BOTH an unfiled twin and a
    # rule twin match. The narrowing means eligible = the unfiled twin ONLY, so it is not
    # ambiguous — the note carries onto the unfiled twin and the rule twin is left alone.
    # FAIL-ON-REVERT: drop the narrowing and BOTH match -> ambiguous -> rescued 0 (flips).
    filed = _norm(lam, "noted_pending", "2026-06-10", pending=True, category=None)
    filed["notes"] = "work lunch"
    unfiled_twin = _norm(lam, "unfiled_twin", "2026-06-11", pending=False, category=None)
    rule_twin = _norm(lam, "rule_twin", "2026-06-12", pending=False, category="groceries")
    rule_twin["filed_by_rule"] = "rule-6"
    repo.insert_transactions([filed, unfiled_twin, rule_twin])

    summary = _sweep_tax(lam, repo, ["groceries"])

    rows = _rows(repo)
    assert "noted_pending" not in rows and summary["rescued"] == 1
    assert rows["unfiled_twin"]["notes"] == "work lunch"           # landed on the unfiled twin
    assert rows["rule_twin"]["category"] == "groceries"            # rule twin untouched
    assert rows["rule_twin"]["filed_by_rule"] == "rule-6"
    assert rows["rule_twin"].get("notes") is None


def test_claim_once_two_user_pendings_one_rule_twin(lam, repo):
    # WHIT-553 [G-CLAIM] (P0) Two USER-set pendings both match the SAME single rule-filed twin.
    # The broadened pool includes the rule twin, and the claim-once trim must work across it:
    # the first pending overrides it (category carried, stamp cleared) and trims it away, so the
    # second finds an empty pool and is reaped with no carry — the rule twin is never overridden
    # twice. FAIL-ON-REVERT: drop the trim line and both carry -> rescued 2.
    first = _norm(lam, "first_pending", "2026-06-09", pending=True, category="dining")
    second = _norm(lam, "second_pending", "2026-06-10", pending=True, category="petrol")
    twin = _norm(lam, "shared_twin", "2026-06-11", pending=False, category="groceries")
    twin["filed_by_rule"] = "rule-7"
    repo.insert_transactions([first, second, twin])

    summary = _sweep_tax(lam, repo, ["dining", "petrol", "groceries"])

    rows = _rows(repo)
    assert summary["rescued"] == 1 and summary["reaped"] == 2
    assert "first_pending" not in rows and "second_pending" not in rows
    assert rows["shared_twin"]["category"] == "dining"            # first claimed it
    assert rows["shared_twin"].get("filed_by_rule") is None       # stamp cleared by the override


def test_dry_run_override_writes_nothing_but_logs_would_carry(lam, repo, caplog):
    # WHIT-553 [G-DRYRUN] (P1) The override case under dry-run: NOTHING is written (pending kept,
    # rule twin keeps its category + stamp) but the "WOULD carry" line is logged. FAIL-ON-REVERT:
    # narrow the candidate pool back to unfiled-only and no twin is found -> no "WOULD carry" line.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="dining")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category="groceries")
    twin["filed_by_rule"] = "rule-8"
    repo.insert_transactions([filed, twin])

    import logging
    with caplog.at_level(logging.INFO, logger="age_out"):
        summary = _sweep_tax(lam, repo, ["dining", "groceries"], dry_run=True)

    rows = _rows(repo)
    assert "filed_pending" in rows                                # nothing deleted
    assert rows["settled_twin"]["category"] == "groceries"        # nothing written
    assert rows["settled_twin"]["filed_by_rule"] == "rule-8"      # stamp intact
    assert summary["reaped"] == 0 and summary["rescued"] == 0
    assert "WOULD carry" in caplog.text


def test_pre_whit536_unstamped_rule_twin_is_protected(lam, repo):
    # WHIT-553 [G-PRE536] (P1) DOCUMENTED CONSERVATIVE LIMITATION: a twin a rule filed BEFORE
    # provenance existed (WHIT-536) has a real category but NO filed_by_rule stamp — so it is
    # indistinguishable from a user filing and is excluded from the candidate pool. The user's
    # override on the pending is therefore lost, exactly as for a real user-filed twin. Pinned so
    # the limitation is a conscious contract, not a silent regression.
    filed = _norm(lam, "filed_pending", "2026-06-10", pending=True, category="dining")
    twin = _norm(lam, "settled_twin", "2026-06-12", pending=False, category="groceries")  # pre-536: no stamp
    repo.insert_transactions([filed, twin])

    summary = _sweep_tax(lam, repo, ["dining", "groceries"])

    rows = _rows(repo)
    assert "filed_pending" not in rows and summary["rescued"] == 0  # override lost (accepted)
    assert rows["settled_twin"]["category"] == "groceries"          # untouched
    assert rows["settled_twin"].get("filed_by_rule") is None


# --- WHIT-545: the rescue carry now gates a stored raw category ------------------------------

def test_whit545_note_rescue_does_not_carry_the_pendings_raw_enum_onto_the_twin(lam, repo):
    # A pending with a raw (unfiled) category BUT a user note is rescued for the note's sake.
    # WHIT-545 wires is_unfiled into the rescue carry, so the pending's raw enum ("FOOD_AND_DRINK")
    # must NOT be copied onto the twin — the twin keeps its own category — while the note DOES
    # carry. FAIL-ON-REVERT: drop the is_unfiled gate in _with_carried_category and the twin's
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
