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
