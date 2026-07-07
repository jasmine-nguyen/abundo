"""Adversarial gap coverage for the stale-pending age-out sweep (WHIT-79).

Complements the implementer's tests/lambda/test_age_out.py — does NOT re-lock the
happy path they already own (reap/keep/boundary/dry-run/pagination/handler-default).
Covers the edges they skipped: re-run idempotency, future-dated pendings, a None
`date`, the third (home-loan) account + zero cross-account bleed, the observability
contract (cutoff/accounts surfaced in the summary), and the handler's live-trigger
guard (`event["dry_run"] is False`) against stringy/non-dict inputs.

Reuses the same fixtures/helpers as test_age_out.py so a revert of age_out.py fails
these, and no helper re-implements the production math being asserted.
"""

from datetime import date

_ACCOUNT_A = "9h2FO6S58zunrwF3U3MhBoaEQNDDfqVlEC5bLSWNdN0"  # -> anz-rewards-black-visa
_ACCOUNT_B = "3zVQJ8Btz_IRmqp78VrQnQ"                        # -> up-spending
_ACCOUNT_C = "T6d8ppsYssBDFCwl1qEb0w"                        # -> up-homeloan

_TODAY = date(2026, 7, 1)  # cutoff = 2026-06-21


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
    repo.insert_transactions([lam.banksync.BankSyncClient.normalise(r) for r in raw_rows])


def _rows(repo):
    return {v["transaction_id"]: v for k, v in repo._table.store.items()
            if k[0].startswith("ACCOUNT#")}


def _sweep(lam, repo, dry_run=False):
    return lam.age_out.age_out_stale_pendings(repo, today=_TODAY, dry_run=dry_run)


# --- idempotency / re-run safety (card item 4) ------------------------------


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


# --- multi-account correctness (card item 7) --------------------------------


def test_sweeps_all_three_accounts_including_home_loan(lam, repo):
    # ACCOUNT_ID_MAP resolves to THREE distinct internal ids; the sweep must visit all
    # three (not just the two spending accounts) — a stale ghost on the home-loan
    # account is reaped and `accounts` counts 3. Guards against an account being skipped.
    _store(lam, repo, _raw_row("ghost_homeloan", "2026-06-10", account=_ACCOUNT_C))

    summary = _sweep(lam, repo)

    assert summary["accounts"] == 3
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


# --- observability contract (card item 6) -----------------------------------


def test_summary_surfaces_cutoff_and_account_count(lam, repo):
    # The summary carries the exact cutoff (2026-07-01 - 10d) and account count that the
    # LIVE log line reports — the only signal a silent dry-run reversion is detectable by.
    summary = _sweep(lam, repo)

    assert summary["cutoff"] == "2026-06-21"
    assert summary["cutoff"] == lam.age_out._cutoff_date(_TODAY)
    assert summary["accounts"] == 3
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
