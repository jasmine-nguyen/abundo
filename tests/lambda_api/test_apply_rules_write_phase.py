"""Direct tests for the apply-rules write phase — RuleBook.sweep (WHIT-537, moved by WHIT-623).

The write loop + WHIT-540 reconcile sweep were extracted from apply_rules_to_uncategorized into
this shared helper, with the cap and time budget as CALL-SITE parameters (the sync route passes
300 / 15s; the async worker passes None / None). These drive the helper directly to prove:

  * the time-budget break still fires post-extraction, with a fake clock — the
    sync route relies on this to stay inside the 30s API Gateway window;
  * max_writes is a real ceiling on the reconcile sweep — 300 caps a 400-row orphan tail, leaving
    100 behind (exactly what the worker's max_writes=None overrides, the mirror of A-G3).

These call RuleBook.sweep (via the handler's import) against the real TransactionRepository over a
FakeTable, so what it writes is real.
"""

import pytest

from _feed_fakes import SPENDING, real_repos, _row


def _book(handler):
    """A rule book over the {"groceries"} taxonomy with no stored rules — every stamp is an orphan."""
    return handler.RuleBook({"groceries"}, [])


# --- time-budget break (sync route's 30s-window guard) -----------------------


def test_time_budget_break_stops_the_file_loop_after_the_first_write(handler):
    # [A-G5] With time_budget set and the clock already past it, the loop writes exactly ONE row
    # (the `attempted and` guard guarantees at least one) then breaks; the rest is `remaining`.
    rows = [_row(SPENDING, "2026-07-01", f"t{i}", description="COLES") for i in range(5)]
    table, repo, _ = real_repos({SPENDING: rows})
    plan = {"matched": [(dict(r, category=None), "groceries", "r1") for r in rows]}
    # The clock reads 100s the moment it is read (after the first write, attempted becomes truthy).
    filed, vanished, failed, already, remaining = _book(handler).sweep(
        repo, [], plan, run_reconcile=False,
        limit=handler.WriteLimit(None, 15.0, 0.0, clock=lambda: 100.0),
    )

    # FAIL-ON-REVERT: drop the `time_budget` branch in WriteLimit.reached() and all 5 rows file.
    assert len(filed) == 1 and len(table.update_calls) == 1
    assert remaining == 4          # matched(5) - attempted(1)


def test_the_first_write_is_never_starved_even_when_already_over_budget(handler):
    # [A-G6] `attempted and ...` means an already-blown clock still lets ONE write through, so a
    # slow read can never make a request that does nothing. (Guards the short-circuit specifically.)
    rows = [_row(SPENDING, "2026-07-01", "t0", description="COLES")]
    _, repo, _ = real_repos({SPENDING: rows})
    plan = {"matched": [(dict(rows[0], category=None), "groceries", "r1")]}
    filed, *_ = _book(handler).sweep(
        repo, [], plan, run_reconcile=False,
        limit=handler.WriteLimit(None, 1.0, 0.0, clock=lambda: 10_000.0),
    )
    assert len(filed) == 1


# --- max_writes caps the reconcile tail (mirror of the worker's uncapped A-G3) ---


def test_max_writes_caps_the_reconcile_tail_leaving_a_remainder(handler):
    # [A-G7] 400 orphan-stamped rows, max_writes=300 => only 300 cleared, 100 left stamped. This is
    # the tail the SYNC route leaves and the worker's max_writes=None clears in full.
    orphans = [_row(SPENDING, "2026-07-01", f"o{i:04d}", description="MYER",
                    category="oldcat", filed_by_rule="r_dead") for i in range(400)]
    table, repo, _ = real_repos({SPENDING: orphans})
    transactions = [dict(r) for r in orphans]   # the "scanned" rows the reconcile sweep walks
    plan = {"matched": []}

    _book(handler).sweep(   # r_dead is not in the book -> clear
        repo, transactions, plan, run_reconcile=True,
        limit=handler.WriteLimit(300, None, None, clock=lambda: 0.0),
    )

    assert len(table.update_calls) == 300
    left = [r for r in table.store.values() if r.get("filed_by_rule") == "r_dead"]
    assert len(left) == 100          # the cap left a tail — this is what "no cap" fixes


def test_no_cap_clears_the_whole_reconcile_tail(handler):
    # [A-G8] The same 400-row tail with max_writes=None (the worker's call) clears every one.
    orphans = [_row(SPENDING, "2026-07-01", f"o{i:04d}", description="MYER",
                    category="oldcat", filed_by_rule="r_dead") for i in range(400)]
    table, repo, _ = real_repos({SPENDING: orphans})
    transactions = [dict(r) for r in orphans]
    plan = {"matched": []}

    _book(handler).sweep(
        repo, transactions, plan, run_reconcile=True,
        limit=handler.WriteLimit.none(),
    )

    left = [r for r in table.store.values() if r.get("filed_by_rule") == "r_dead"]
    assert len(table.update_calls) == 400 and left == []
