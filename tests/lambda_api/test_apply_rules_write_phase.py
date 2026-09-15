"""Direct tests for handler._apply_rules_write_phase (WHIT-537 extraction).

The write loop + WHIT-540 reconcile sweep were extracted from apply_rules_to_uncategorized into
this shared helper, with the cap and time budget as CALL-SITE parameters (the sync route passes
300 / 15s; the async worker passes None / None). These drive the helper directly to prove:

  * the time-budget break still fires post-extraction, with a monkeypatched monotonic clock — the
    sync route relies on this to stay inside the 30s API Gateway window;
  * max_writes is a real ceiling on the reconcile sweep — 300 caps a 400-row orphan tail, leaving
    100 behind (exactly what the worker's max_writes=None overrides, the mirror of A-G3).

These call the extracted helper against the promoted WritableFeedRepo, so what it writes is real.
"""

import pytest

from _feed_fakes import SPENDING, _row, WritableFeedRepo


def _is_unfiled(category, taxonomy=frozenset({"groceries"})):
    return category != "income" and category not in taxonomy


# --- time-budget break (sync route's 30s-window guard) -----------------------


def test_time_budget_break_stops_the_file_loop_after_the_first_write(handler, monkeypatch):
    # [A-G5] With time_budget set and the clock already past it, the loop writes exactly ONE row
    # (the `attempted and` guard guarantees at least one) then breaks; the rest is `remaining`.
    rows = [_row(SPENDING, "2026-07-01", f"t{i}", description="COLES", category=None)
            for i in range(5)]
    repo = WritableFeedRepo({SPENDING: rows})
    plan = {"matched": [(dict(r, category=None), "groceries", "r1") for r in rows]}
    # Clock jumps to 100s the moment it is read (after the first write, attempted becomes truthy).
    monkeypatch.setattr(handler.time, "monotonic", lambda: 100.0)

    filed, vanished, failed, already, remaining = handler._apply_rules_write_phase(
        repo, plan, [], {"r1": "groceries"}, {}, _is_unfiled,
        inline_stamp=None, run_reconcile=False,
        max_writes=None, time_budget=15.0, started=0.0,
    )

    # FAIL-ON-REVERT: drop the `time_budget` branch in over_budget() and all 5 rows file.
    assert len(filed) == 1 and len(repo.writes) == 1
    assert remaining == 4          # matched(5) - attempted(1)


def test_the_first_write_is_never_starved_even_when_already_over_budget(handler, monkeypatch):
    # [A-G6] `attempted and ...` means an already-blown clock still lets ONE write through, so a
    # slow read can never make a request that does nothing. (Guards the short-circuit specifically.)
    rows = [_row(SPENDING, "2026-07-01", "t0", description="COLES", category=None)]
    repo = WritableFeedRepo({SPENDING: rows})
    plan = {"matched": [(dict(rows[0], category=None), "groceries", "r1")]}
    monkeypatch.setattr(handler.time, "monotonic", lambda: 10_000.0)

    filed, *_ = handler._apply_rules_write_phase(
        repo, plan, [], {"r1": "groceries"}, {}, _is_unfiled,
        inline_stamp=None, run_reconcile=False,
        max_writes=None, time_budget=1.0, started=0.0,
    )
    assert len(filed) == 1


# --- max_writes caps the reconcile tail (mirror of the worker's uncapped A-G3) ---


def test_max_writes_caps_the_reconcile_tail_leaving_a_remainder(handler):
    # [A-G7] 400 orphan-stamped rows, max_writes=300 => only 300 cleared, 100 left stamped. This is
    # the tail the SYNC route leaves and the worker's max_writes=None clears in full.
    orphans = [_row(SPENDING, "2026-07-01", f"o{i:04d}", description="MYER",
                    category="oldcat", filed_by_rule="r_dead") for i in range(400)]
    repo = WritableFeedRepo({SPENDING: orphans})
    transactions = [dict(r) for r in orphans]   # the "scanned" rows the reconcile sweep walks
    plan = {"matched": []}

    handler._apply_rules_write_phase(
        repo, plan, transactions, {}, {}, _is_unfiled,   # r_dead absent from rule_target_by_id -> clear
        inline_stamp=None, run_reconcile=True,
        max_writes=300, time_budget=None, started=None,
    )

    assert len(repo.writes) == 300
    left = [r for rows in repo._rows.values() for r in rows if r.get("filed_by_rule") == "r_dead"]
    assert len(left) == 100          # the cap left a tail — this is what "no cap" fixes


def test_no_cap_clears_the_whole_reconcile_tail(handler):
    # [A-G8] The same 400-row tail with max_writes=None (the worker's call) clears every one.
    orphans = [_row(SPENDING, "2026-07-01", f"o{i:04d}", description="MYER",
                    category="oldcat", filed_by_rule="r_dead") for i in range(400)]
    repo = WritableFeedRepo({SPENDING: orphans})
    transactions = [dict(r) for r in orphans]
    plan = {"matched": []}

    handler._apply_rules_write_phase(
        repo, plan, transactions, {}, {}, _is_unfiled,
        inline_stamp=None, run_reconcile=True,
        max_writes=None, time_budget=None, started=None,
    )

    left = [r for rows in repo._rows.values() for r in rows if r.get("filed_by_rule") == "r_dead"]
    assert len(repo.writes) == 400 and left == []
