"""WHIT-540 gaps — adversarial edges the implementer's test_rule_refile.py / reconcile-sweep suite
skip: multi-account ownership, a per-row DatabaseError mid re-file, the TIME-budget cutoff (not the
write cap), and the reconcile sweep sharing the file loop's budget without starving it or corrupting
`remaining`. Also documents an orphan-stamped charge a live rule still matches.

Drives the routes directly with the real TransactionRepository and RuleRepository over one
FakeTable, exactly like test_rule_refile.py. The OLD rule id is read from the real RuleRepository
that minted it; a NEW id comes from the response body.
"""

import json

from _feed_fakes import (
    ANZ, SPENDING, FakeCategoryRepo, apply_rules_event, fail_writes, real_repos, rule_delete_event, rule_put_event,
    _row, stored,
)
from _rule_ingest_fakes import apply_rules_to_uncategorized


_CATEGORIES = frozenset({"groceries", "petrol"})


def _rule(value, category_id="groceries", field="description", operator="contains"):
    return {"field": field, "operator": operator, "value": value, "category_id": category_id}


def _seed_rule(value, category_id="groceries", field="description", operator="contains"):
    """Real repos over one table holding one rule, plus the id the store minted (== the stamp)."""
    table, txn_repo, rule_repo = real_repos(rules=[_rule(value, category_id, field, operator)])
    return table, txn_repo, rule_repo, rule_repo.list_rules()[0]["id"]


def _update(handler, rule_repo, txn_repo, event, categories=_CATEGORIES):
    resp = handler.update_rule_route(event, rule_repo, FakeCategoryRepo(categories), txn_repo)
    return resp, json.loads(resp["body"])


def _delete(handler, rule_repo, txn_repo, event):
    resp = handler.delete_rule_route(event, rule_repo, txn_repo)
    return resp, json.loads(resp["body"])


def _apply(handler, repo, rule_repo, body, categories=_CATEGORIES):
    event = apply_rules_event(body)
    resp = apply_rules_to_uncategorized(
        handler,
        event, repo, FakeCategoryRepo(categories), rule_repo)
    return resp, json.loads(resp["body"])


# --- multi-account: one rule owns charges in more than one account --------------


def test_delete_undoes_charges_across_multiple_accounts(handler):
    # The same rule filed charges in the SPENDING and ANZ accounts. read_window
    # walks EVERY account, so a delete must undo BOTH. FAIL-ON-REVERT: scan only one account and
    # the other account's fill survives (a dangling stamp on a deleted rule).
    table, repo, rule_repo, rid = _seed_rule("coles", "groceries")
    table.seed(
        _row(SPENDING, "2026-07-02", "s1", description="COLES 1",
             category="groceries", filed_by_rule=rid),
        _row(ANZ, "2026-07-01", "a1", description="COLES 2",
             category="groceries", filed_by_rule=rid),
    )

    _, body = _delete(handler, rule_repo, repo, rule_delete_event(rid))

    assert body["remaining"] == 0
    s1 = stored(table, "s1", SPENDING)
    a1 = stored(table, "a1", ANZ)
    assert "category" not in s1 and "filed_by_rule" not in s1
    assert "category" not in a1 and "filed_by_rule" not in a1


# --- a per-row database failure mid re-file: skip and keep `remaining` honest ----


def test_delete_skips_a_row_that_errors_and_still_counts_it_reached(handler):
    # The middle charge's write raises a retryable DatabaseError. The loop must SKIP it (best
    # effort) and still clear the other two — one bad row can't abort the whole undo the user
    # already saw succeed. And `remaining` stays 0: `attempted` is bumped BEFORE the write, so the
    # errored row counts as REACHED (a later sweep retries it), not as an unreached tail.
    # FAIL-ON-REVERT: let the DatabaseError propagate (drop the try/except) and the route 500s;
    # bump `attempted` only after a successful write and `remaining` wrongly reports 1.
    table, repo, rule_repo, rid = _seed_rule("coles", "groceries")
    table.seed(
        _row(SPENDING, "2026-07-03", "ok1", description="COLES", category="groceries", filed_by_rule=rid),
        _row(SPENDING, "2026-07-02", "boom", description="COLES", category="groceries", filed_by_rule=rid),
        _row(SPENDING, "2026-07-01", "ok2", description="COLES", category="groceries", filed_by_rule=rid),
    )
    fail_writes(table, "boom")

    resp, body = _delete(handler, rule_repo, repo, rule_delete_event(rid))

    assert resp["statusCode"] == 200
    assert body["remaining"] == 0                      # all three reached (one just failed)
    assert "category" not in stored(table, "ok1")      # cleared
    assert "category" not in stored(table, "ok2")      # cleared despite the error before it
    assert stored(table, "boom")["category"] == "groceries"   # untouched — its write raised


def test_edit_skips_a_row_that_errors_and_re_files_the_rest(handler):
    # Same best-effort skip on the EDIT path (refile_rule_fill raises), proving the try/except
    # wraps both branches, not just delete.
    table, repo, rule_repo, rid = _seed_rule("coles", "groceries")
    table.seed(
        _row(SPENDING, "2026-07-02", "ok", description="COLES", category="groceries", filed_by_rule=rid),
        _row(SPENDING, "2026-07-01", "boom", description="COLES", category="groceries", filed_by_rule=rid),
    )
    fail_writes(table, "boom")

    resp, body = _update(handler, rule_repo, repo, rule_put_event(rid, "coles", "petrol"))

    assert resp["statusCode"] == 200 and body["remaining"] == 0
    assert stored(table, "ok")["category"] == "petrol"        # re-filed
    assert stored(table, "boom")["category"] == "groceries"   # write raised, left as-was


# --- the TIME budget cutoff (distinct from the write cap the impl suite already tests) -----


def test_delete_stops_on_the_time_budget_and_reports_the_tail(handler, monkeypatch):
    # A zero-second time budget with a HIGH write cap isolates the clock cutoff from the write cap.
    # The `attempted and ...` guard still guarantees ONE write, then the clock stops the loop, so
    # `remaining` reports the unreached tail. FAIL-ON-REVERT: drop the time-budget break and all
    # three are cleared, remaining 0.
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 999)
    monkeypatch.setattr(handler, "APPLY_RULES_TIME_BUDGET_SECONDS", 0)
    table, repo, rule_repo, rid = _seed_rule("coles", "groceries")
    rows = [_row(SPENDING, f"2026-07-0{n}", f"t{n}", description="COLES",
                 category="groceries", filed_by_rule=rid) for n in range(1, 4)]
    table.seed(*rows)

    _, body = _delete(handler, rule_repo, repo, rule_delete_event(rid))

    assert body["remaining"] == 2       # one write got in before the clock, two left
    cleared = sum(1 for n in range(1, 4) if "category" not in stored(table, f"t{n}"))
    assert cleared == 1


# --- reconcile sweep shares the file loop's budget: can't starve it, can't corrupt `remaining` ----


def test_matched_remaining_is_captured_before_the_sweep(handler, monkeypatch):
    # The sweep re-uses `attempted` for its budget. `remaining` (matched charges left unfiled) is
    # captured BEFORE the sweep so the sweep's own writes can't drive it negative.
    # 2 unfiled COLES charges are filed (attempted -> 2); 2 orphan-stamped charges are then swept
    # (attempted -> 4). matched has 2, all filed, so remaining must be 0 — never 2 - 4 = -2.
    # FAIL-ON-REVERT: compute remaining as len(matched) - attempted AFTER the sweep and it reports -2.
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 999)
    table, repo, rule_repo = real_repos(rules=[_rule("coles", "groceries")])
    live = rule_repo.list_rules()[0]["id"]
    table.seed(
        _row(SPENDING, "2026-07-04", "m1", description="COLES"),
        _row(SPENDING, "2026-07-03", "m2", description="COLES 2"),
        _row(SPENDING, "2026-07-02", "o1", description="OLD", category="petrol", filed_by_rule="dead"),
        _row(SPENDING, "2026-07-01", "o2", description="OLD 2", category="petrol", filed_by_rule="dead"),
    )

    _, body = _apply(handler, repo, rule_repo, {"dryRun": False})

    assert body["remaining"] == 0                              # NOT negative
    assert stored(table, "m1")["category"] == "groceries"      # matched charges filed
    assert stored(table, "m2")["category"] == "groceries"
    assert "category" not in stored(table, "o1")               # orphans swept
    assert "category" not in stored(table, "o2")
    assert live  # (the id the real store minted)


def test_file_loop_is_served_before_the_sweep_when_the_budget_is_tight(handler, monkeypatch):
    # Write cap of 2 with 2 matched + 2 orphans. The file loop runs FIRST and takes the whole
    # budget, so the orphans are left for a later sweep — the primary action (filing) is never
    # starved by the housekeeping sweep. FAIL-ON-REVERT: sweep before filing and the two COLES
    # charges stay unfiled while dead stamps get cleared instead.
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 2)
    table, repo, rule_repo = real_repos(rules=[_rule("coles", "groceries")])
    table.seed(
        _row(SPENDING, "2026-07-04", "m1", description="COLES"),
        _row(SPENDING, "2026-07-03", "m2", description="COLES 2"),
        _row(SPENDING, "2026-07-02", "o1", description="OLD", category="petrol", filed_by_rule="dead"),
        _row(SPENDING, "2026-07-01", "o2", description="OLD 2", category="petrol", filed_by_rule="dead"),
    )

    _, body = _apply(handler, repo, rule_repo, {"dryRun": False})

    assert body["remaining"] == 0                              # both matched filed within the cap
    assert stored(table, "m1")["category"] == "groceries"
    assert stored(table, "m2")["category"] == "groceries"
    assert stored(table, "o1")["category"] == "petrol"         # orphan untouched — no budget left
    assert stored(table, "o1")["filed_by_rule"] == "dead"      # dead stamp still dangling this run


# --- documents behaviour: an orphan-stamped charge a LIVE rule would match -------


def test_orphan_stamped_charge_that_a_live_rule_matches_is_unfiled_this_run(handler):
    # A charge filed (category groceries) and stamped by a now-dead rule, whose DESCRIPTION a live
    # rule ("coles") also matches. It is already filed, so it is NOT in the file loop's `matched`
    # set — the sweep clears it to unfiled. So after THIS run the charge is unfiled even though a
    # live rule matches it; it is only re-filed on the NEXT apply run. Documents the one-run lag
    # (see critique) rather than asserting an un-file is desirable.
    table, repo, rule_repo = real_repos(rules=[_rule("coles", "groceries")])
    live = rule_repo.list_rules()[0]["id"]
    table.seed(
        _row(SPENDING, "2026-07-01", "x", description="COLES", category="groceries", filed_by_rule="dead"),
    )

    _, body = _apply(handler, repo, rule_repo, {"dryRun": False})

    x = stored(table, "x")
    assert "category" not in x and "filed_by_rule" not in x    # cleared this run
    assert live in {r["id"] for r in rule_repo.list_rules()}   # the matching rule still exists
