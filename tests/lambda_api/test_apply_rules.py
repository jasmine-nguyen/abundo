"""Tests for POST /transactions/uncategorized/apply-rules (apply_rules_to_uncategorized).

BankSync applies rules at sync time to INCOMING charges only, so rules never reach charges
already stored (WHIT-502). This route closes that gap over full history. The safety-critical
property: it PREVIEWS unless the body explicitly says {"dryRun": false}, so a bulk write to real
data can never happen by accident.

Runs the REAL TransactionRepository and RuleRepository over one FakeTable (WHIT-625), so the
paged whole-history scan, the "only if unchanged" write and the rule store's snake_case rows are
production's own.
"""

import json

import pytest

from _feed_fakes import (
    ANZ, SPENDING, FakeCategoryRepo, charge_writes, date_queries, fail_writes, on_write,
    real_repos, _row, set_category, stored, vanish_on_write,
)


def _rule(value, category_id="groceries", field="description", operator="contains"):
    # The kwargs of one real RuleRepository.create_rule call.
    return {"field": field, "operator": operator, "value": value, "category_id": category_id}


def _rule_ids(rule_repo):
    # The ids the real store minted, by rule value.
    return {rule["value"]: rule["id"] for rule in rule_repo.list_rules()}


def _apply_event(body=None, method="POST"):
    event = {
        "rawPath": "/transactions/uncategorized/apply-rules",
        "requestContext": {"http": {"method": method}},
    }
    if body is not None:
        event["body"] = json.dumps(body)
    return event


def _call(handler, repo, rule_repo, body, categories=frozenset({"groceries", "coffee"})):
    resp = handler.apply_rules_to_uncategorized(
        _apply_event(body), repo, FakeCategoryRepo(categories), rule_repo)
    return resp, json.loads(resp["body"])


# --- the safety property: preview unless explicitly told otherwise ------------


def test_dry_run_is_the_default_and_writes_nothing(handler):
    table, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1", description="COLES 1")]},
        rules=[_rule("coles")])
    resp, body = _call(handler, repo, rule_repo, {})

    assert resp["statusCode"] == 200
    assert body["dryRun"] is True
    assert body["matched"] == 1
    assert body["filed"] == []
    assert table.update_calls == []   # FAIL-ON-REVERT: a default of False would write here
    assert body["remaining"] == 1


def test_explicit_dry_run_true_writes_nothing(handler):
    table, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1", description="COLES")]},
        rules=[_rule("coles")])
    _, body = _call(handler, repo, rule_repo, {"dryRun": True})
    assert body["filed"] == [] and table.update_calls == []


@pytest.mark.parametrize("bad", ["false", "no", 0, 1, None])
def test_a_non_boolean_dry_run_is_rejected_rather_than_guessed(handler, bad):
    table, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1")]}, rules=[_rule("coles")])
    resp = handler.apply_rules_to_uncategorized(
        _apply_event({"dryRun": bad}), repo, FakeCategoryRepo({"groceries"}), rule_repo)

    assert resp["statusCode"] == 400
    assert table.update_calls == []


def test_a_missing_body_is_rejected_not_treated_as_a_write(handler):
    table, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1")]}, rules=[_rule("coles")])
    resp = handler.apply_rules_to_uncategorized(
        _apply_event(), repo, FakeCategoryRepo({"groceries"}), rule_repo)

    assert resp["statusCode"] == 400
    assert table.update_calls == []


# --- the write path -----------------------------------------------------------


def test_the_write_files_matching_charges_by_their_own_keys(handler):
    table, repo, rule_repo = real_repos({
        SPENDING: [_row(SPENDING, "2026-07-02", "hit", description="COLES 1"),
                   _row(SPENDING, "2026-07-01", "miss", description="BP FUEL")],
    }, rules=[_rule("coles")])
    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert body["dryRun"] is False
    assert body["filed"] == [{"id": "hit", "category": "groceries"}]
    assert body["remaining"] == 0
    # Written by the row's OWN pk/sk from the scan — the real write is conditional on the row
    # existing, so a wrong key files nothing. It is also conditional on the category the SCAN saw
    # (none, WHIT-508): passing the rule's target instead would be refused on this unfiled row.
    assert charge_writes(table) == [(f"ACCOUNT#{SPENDING}", "TXN#hit")]
    assert stored(table, "hit")["category"] == "groceries"
    assert "category" not in stored(table, "miss")


def test_the_write_stamps_the_rule_that_filed_each_charge(handler):
    # WHIT-536: a rule-filed row remembers which rule filed it. FAIL-ON-REVERT: drop the
    # filed_by_rule=stamp arg in the handler and the stored row carries no stamp.
    table, repo, rule_repo = real_repos({
        SPENDING: [_row(SPENDING, "2026-07-02", "hit", description="COLES 1")],
    }, rules=[_rule("coles")])
    _call(handler, repo, rule_repo, {"dryRun": False})
    assert stored(table, "hit")["filed_by_rule"] == _rule_ids(rule_repo)["coles"]


def test_a_nested_disagreement_files_to_the_more_specific_rule_end_to_end(handler):
    # WHIT-518 end to end on the full sweep: a stored "COLES EXPRESS" charge that two disagreeing
    # nested rules match is filed to the SPECIFIC rule's category (petrol) and stamped with it, not
    # left conflicted. FAIL-ON-REVERT: without the decide tie-break the charge stays unfiled.
    table, repo, rule_repo = real_repos({
        SPENDING: [_row(SPENDING, "2026-07-02", "hit", description="COLES EXPRESS 1123")],
    }, rules=[_rule("coles", category_id="groceries"),
              _rule("coles express", category_id="petrol")])
    _, body = _call(handler, repo, rule_repo, {"dryRun": False},
                    categories=frozenset({"groceries", "petrol"}))

    assert body["filed"] == [{"id": "hit", "category": "petrol"}]
    assert body["conflicted"] == 0
    row = stored(table, "hit")
    assert row["category"] == "petrol"
    assert row["filed_by_rule"] == _rule_ids(rule_repo)["coles express"]


# --- the race the user can actually lose (WHIT-508) --------------------------
# The pass reads all of history, decides, then writes — up to 15s later. A tap in that gap used to
# be silently overwritten by the rule. These lock the rule backing off instead.

def test_a_charge_the_user_files_mid_run_keeps_their_category(handler):
    # FAIL-ON-REVERT: swap the conditional write back for the unconditional one and "t2" reads
    # "groceries" — the rule having overwritten the tap, which is the entire bug.
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1"),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2"),
    ]}, rules=[_rule("coles")])
    # The user taps "coffee" on t2 while the run is working through t1.
    on_write(table, "t1", lambda tbl: set_category(tbl, "t2", "coffee"))

    _, body = _call(handler, repo, rule_repo,
                    {"dryRun": False}, categories=("groceries", "coffee"))

    assert body["filed"] == [{"id": "t1", "category": "groceries"}]
    assert body["alreadyFiled"] == ["t2"]
    assert body["vanished"] == [] and body["failed"] == []
    assert stored(table, "t2")["category"] == "coffee"   # the tap stands
    # It was attempted, so there is nothing left to come back for.
    assert body["remaining"] == 0


def test_a_row_that_changed_into_something_still_unfiled_is_retryable(handler):
    # A row that changed underneath is NOT automatically "filed". A settlement can carry the bank's
    # own raw label back onto the row, which still reads as unfiled — so calling that alreadyFiled
    # would let the app announce the job done while the badge still counts the charge. It belongs
    # in `failed`, which the app treats as work left.
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1"),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2"),
    ]}, rules=[_rule("coles", "groceries")])
    # t2 was unfiled at scan time; mid-run it gains a raw bank label (a settlement carrying one
    # across), which still reads as unfiled.
    on_write(table, "t1", lambda tbl: set_category(tbl, "t2", "TRANSFER_OUT"))

    _, body = _call(handler, repo, rule_repo,
                    {"dryRun": False}, categories=("groceries", "coffee"))

    assert body["filed"] == [{"id": "t1", "category": "groceries"}]
    assert body["failed"] == ["t2"]        # still unfiled -> a re-run picks it up
    assert body["alreadyFiled"] == []


def test_a_stale_scan_does_not_overwrite_the_stored_category(handler):
    # The everyday version, not the exotic one: the scan reads an index that cannot be read
    # consistently, so "the scan says unfiled, storage already says filed" is the COMMON case.
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="COLES 1", category="coffee")]},
        rules=[_rule("coles")])
    # The index is behind: it still reports the row unfiled.
    table.stale_index(stored(table, "t1"), category=None)

    _, body = _call(handler, repo, rule_repo,
                    {"dryRun": False}, categories=("groceries", "coffee"))

    assert body["filed"] == []
    assert body["alreadyFiled"] == ["t1"]
    row = stored(table, "t1")
    assert row["category"] == "coffee"
    # [WHIT-536] a refused write lands no rule stamp on the row the user just claimed — the real
    # conditional write sets category and stamp together or not at all.
    assert "filed_by_rule" not in row


def test_running_twice_files_nothing_the_second_time(handler):
    _, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1"),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2"),
    ]}, rules=[_rule("coles")])
    _, first = _call(handler, repo, rule_repo, {"dryRun": False})
    assert len(first["filed"]) == 2

    _, second = _call(handler, repo, rule_repo, {"dryRun": False})
    assert second["matched"] == 0
    assert second["filed"] == []
    assert second["unfiled"] == 0


def test_a_row_that_vanished_mid_run_is_reported_separately_from_a_failure(handler):
    # The conditional write answers ("gone", None) — not an exception — when the row was deleted
    # between the scan and the write (a pending aged out, or its posted twin replaced it).
    # Nothing to retry, so it must NOT be reported as filed, as failed, OR as alreadyFiled:
    # only vanished rows may be dropped from the app's list.
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-03", "gone", description="COLES 1"),
        _row(SPENDING, "2026-07-02", "boom", description="COLES 2"),
        _row(SPENDING, "2026-07-01", "ok", description="COLES 3"),
    ]}, rules=[_rule("coles")])
    vanish_on_write(table, "gone")
    fail_writes(table, "boom")

    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert body["filed"] == [{"id": "ok", "category": "groceries"}]
    assert body["vanished"] == ["gone"]
    assert body["alreadyFiled"] == []   # a deleted row is NOT a row someone else filed
    assert body["failed"] == ["boom"]
    assert body["remaining"] == 0      # all three were attempted


def test_one_failure_does_not_stop_the_rest(handler):
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES")
            for d in range(1, 6)]
    table, repo, rule_repo = real_repos({SPENDING: rows}, rules=[_rule("coles")])
    fail_writes(table, "t3")

    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert len(body["filed"]) == 4 and body["failed"] == ["t3"]


def test_more_matches_than_the_write_cap_files_the_cap_and_reports_the_rest(handler, monkeypatch):
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 3)
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES")
            for d in range(1, 8)]
    _, repo, rule_repo = real_repos({SPENDING: rows}, rules=[_rule("coles")])

    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert body["matched"] == 7
    assert len(body["filed"]) == 3
    assert body["remaining"] == 4     # "tap again for the rest"


def test_the_time_budget_stops_the_write_MID_run_and_reports_the_remainder(handler, monkeypatch):
    # The real "tap again" case: some rows written, then the clock runs out. A fake clock trips
    # the budget partway so this proves the check runs PER ROW — hoisting it out of the loop (the
    # refactor that would let a long run blow the API Gateway window) makes this go red, which a
    # budget-of-0 test cannot catch.
    # The floor short-circuits the clock read on the FIRST row, so the reads are:
    # entry, row2, row3 — and row3's read is past the budget.
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES")
            for d in range(1, 5)]
    table, repo, rule_repo = real_repos({SPENDING: rows}, rules=[_rule("coles")])
    ticks = iter([0, 1, 9, 9, 9])
    monkeypatch.setattr(handler.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(handler, "APPLY_RULES_TIME_BUDGET_SECONDS", 5)

    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert len(body["filed"]) == 2      # wrote what it could...
    assert body["remaining"] == 2       # ...and reported the rest honestly
    assert len(table.update_calls) == 2


def test_an_already_spent_budget_still_makes_one_attempt(handler, monkeypatch):
    # Guarantees forward progress: `started` is stamped before the rule read and the history
    # scan, so a slow pair could spend the whole budget before the first row. Without the
    # at-least-one floor the user would tap forever and never file anything.
    monkeypatch.setattr(handler, "APPLY_RULES_TIME_BUDGET_SECONDS", 0)
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES")
            for d in range(1, 5)]
    _, repo, rule_repo = real_repos({SPENDING: rows}, rules=[_rule("coles")])

    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert len(body["filed"]) == 1      # never zero — progress is guaranteed
    assert body["remaining"] == 3


# --- scope, breakdown, and the cheap paths ------------------------------------


def test_no_rules_returns_zeros_without_scanning_history(handler):
    table, repo, rule_repo = real_repos({SPENDING: [_row(SPENDING, "2026-07-01", "t1")]})
    _, body = _call(handler, repo, rule_repo, {})

    assert body["matched"] == 0 and body["unfiled"] == 0 and body["rulesConsidered"] == 0
    assert date_queries(table) == []   # the whole-history scan is skipped entirely


def test_deep_history_matches_are_found(handler):
    rows = [_row(ANZ, f"2026-05-{(i % 28) + 1:02d}", f"filed{i}",
                 description="WOOLWORTHS", category="groceries") for i in range(120)]
    rows.append(_row(ANZ, "2020-01-01", "deep", description="COLES OLD"))
    table, repo, rule_repo = real_repos({ANZ: rows}, rules=[_rule("coles")])

    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert body["filed"] == [{"id": "deep", "category": "groceries"}]
    # Genuinely paged past page 1: a later ANZ read resumed from a cursor.
    assert [query["ExclusiveStartKey"]["account_id"] for query in date_queries(table)
            if "ExclusiveStartKey" in query] == [ANZ]


def test_the_preview_reports_conflicts_and_the_per_rule_breakdown(handler):
    _, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-03", "conflict", description="COLES RICHMOND"),
        _row(SPENDING, "2026-07-02", "clean", description="COLES CARLTON"),
    ]}, rules=[_rule("coles", "groceries"), _rule("richmond", "coffee")])

    _, body = _call(handler, repo, rule_repo, {})

    assert body["conflicted"] == 1
    assert body["matched"] == 1
    assert body["byCategory"] == {"groceries": 1}
    ids = _rule_ids(rule_repo)
    assert {entry["ruleId"] for entry in body["byRule"]} == {ids["coles"], ids["richmond"]}


def test_a_rules_read_failure_reads_no_history_and_writes_nothing(handler):
    # WHIT-531: the rule read moved to our store, so a read failure is a DatabaseError -> 500
    # (our server), not the old BankSync 502. The early return leaves the transaction repo
    # untouched — nothing scanned, nothing written.
    table, repo, rule_repo = real_repos({SPENDING: [_row(SPENDING, "2026-07-01", "t1")]})
    table.fail("query")
    resp = handler.apply_rules_to_uncategorized(
        _apply_event({"dryRun": False}), repo, FakeCategoryRepo({"groceries"}), rule_repo)

    assert resp["statusCode"] == 500
    assert date_queries(table) == [] and table.update_calls == []


# --- dispatch through lambda_handler ------------------------------------------


def test_post_routes_to_the_apply_handler(handler, monkeypatch):
    _, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1", description="COLES")]},
        rules=[_rule("coles")])
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo({"groceries"}))
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)

    resp = handler.lambda_handler(_apply_event({"dryRun": True}), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["matched"] == 1


@pytest.mark.parametrize("method", ["GET", "PATCH", "DELETE"])
def test_other_methods_on_the_apply_path_are_not_routed(handler, monkeypatch, method):
    # Method-gated: only POST applies rules. In particular a GET must not reach a write path,
    # and the PATCH "/transactions/{id}" branch must not swallow this path.
    def _boom(*a, **k):
        raise AssertionError("apply_rules_to_uncategorized must not run for " + method)

    _, repo, _ = real_repos()
    monkeypatch.setattr(handler, "apply_rules_to_uncategorized", _boom)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(set()))

    resp = handler.lambda_handler(_apply_event({"dryRun": True}, method=method), None)

    assert resp["statusCode"] == 404
