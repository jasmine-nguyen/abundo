"""Tests for POST /transactions/uncategorized/apply-rules (apply_rules_to_uncategorized).

BankSync applies rules at sync time to INCOMING charges only, so rules never reach charges
already stored (WHIT-502). This route closes that gap over full history. The safety-critical
property: it PREVIEWS unless the body explicitly says {"dryRun": false}, so a bulk write to real
data can never happen by accident.

Reuses FakeFeedRepo (the realistic paged date-index fake) so the whole-history scan is genuinely
exercised, and drives a FakeRuleRepo as the handler's rule store (WHIT-531 moved the rule read off
BankSync into our own RuleRepository). FakeRuleRepo speaks the store's SNAKE_CASE row shape, so the
handler's store->client mapper is genuinely exercised.
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _rule(value, category_id="groceries", field="description", operator="contains", rule_id="r1"):
    # A stored rule row (snake_case), the shape RuleRepository/FakeRuleRepo hold.
    return {"id": rule_id, "field": field, "operator": operator, "value": value,
            "category_id": category_id}


def _apply_event(body=None, method="POST"):
    event = {
        "rawPath": "/transactions/uncategorized/apply-rules",
        "requestContext": {"http": {"method": method}},
    }
    if body is not None:
        event["body"] = json.dumps(body)
    return event


def _call(handler, repo, rules, body, categories=frozenset({"groceries", "coffee"})):
    resp = handler.apply_rules_to_uncategorized(
        _apply_event(body), repo, FakeCategoryRepo(categories), FakeRuleRepo(rules=rules))
    return resp, json.loads(resp["body"])


# --- the safety property: preview unless explicitly told otherwise ------------


def test_dry_run_is_the_default_and_writes_nothing(handler):
    repo = WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1",
                                              description="COLES 1", category=None)]})
    resp, body = _call(handler, repo, [_rule("coles")], {})

    assert resp["statusCode"] == 200
    assert body["dryRun"] is True
    assert body["matched"] == 1
    assert body["filed"] == []
    assert repo.writes == []          # FAIL-ON-REVERT: a default of False would write here
    assert body["remaining"] == 1


def test_explicit_dry_run_true_writes_nothing(handler):
    repo = WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1",
                                              description="COLES", category=None)]})
    _, body = _call(handler, repo, [_rule("coles")], {"dryRun": True})
    assert body["filed"] == [] and repo.writes == []


@pytest.mark.parametrize("bad", ["false", "no", 0, 1, None])
def test_a_non_boolean_dry_run_is_rejected_rather_than_guessed(handler, bad):
    repo = WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1", category=None)]})
    resp = handler.apply_rules_to_uncategorized(
        _apply_event({"dryRun": bad}), repo, FakeCategoryRepo({"groceries"}),
        FakeRuleRepo(rules=[_rule("coles")]))

    assert resp["statusCode"] == 400
    assert repo.writes == []


def test_a_missing_body_is_rejected_not_treated_as_a_write(handler):
    repo = WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1", category=None)]})
    resp = handler.apply_rules_to_uncategorized(
        _apply_event(), repo, FakeCategoryRepo({"groceries"}),
        FakeRuleRepo(rules=[_rule("coles")]))

    assert resp["statusCode"] == 400
    assert repo.writes == []


# --- the write path -----------------------------------------------------------


def test_the_write_files_matching_charges_by_their_own_keys(handler):
    repo = WritableFeedRepo({
        SPENDING: [_row(SPENDING, "2026-07-02", "hit", description="COLES 1", category=None),
                   _row(SPENDING, "2026-07-01", "miss", description="BP FUEL", category=None)],
    })
    _, body = _call(handler, repo, [_rule("coles")], {"dryRun": False})

    assert body["dryRun"] is False
    assert body["filed"] == [{"id": "hit", "category": "groceries"}]
    assert body["remaining"] == 0
    # Written by the row's OWN pk/sk from the scan — no id->keys lookup round trip. The trailing
    # None is the category the SCAN saw, which the write is conditional on (WHIT-508): passing the
    # rule's target there instead would make the guard compare a value against itself and never fire.
    assert repo.writes == [(f"ACCOUNT#{SPENDING}", "TXN#hit", "groceries", None)]


def test_the_write_stamps_the_rule_that_filed_each_charge(handler):
    # WHIT-536: a rule-filed row remembers which rule filed it. FAIL-ON-REVERT: drop the
    # filed_by_rule=stamp arg in the handler and the stored row carries no stamp.
    repo = WritableFeedRepo({
        SPENDING: [_row(SPENDING, "2026-07-02", "hit", description="COLES 1", category=None)],
    })
    _call(handler, repo, [_rule("coles", rule_id="r-coles")], {"dryRun": False})
    assert repo._find_row(f"ACCOUNT#{SPENDING}", "TXN#hit")["filed_by_rule"] == "r-coles"


# --- the race the user can actually lose (WHIT-508) --------------------------
# The pass reads all of history, decides, then writes — up to 15s later. A tap in that gap used to
# be silently overwritten by the rule. These lock the rule backing off instead.

def test_a_charge_the_user_files_mid_run_keeps_their_category(handler):
    # FAIL-ON-REVERT: swap the conditional write back for the unconditional one and "t2" reads
    # "groceries" — the rule having overwritten the tap, which is the entire bug.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1", category=None),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2", category=None),
    ]})
    # The user taps "coffee" on t2 while the run is working through t1.
    repo.refile_hook = lambda transaction_id, r: (
        r.set_category("t2", "coffee") if transaction_id == "t1" else None)

    _, body = _call(handler, repo, [_rule("coles")],
                    {"dryRun": False}, categories=("groceries", "coffee"))

    assert body["filed"] == [{"id": "t1", "category": "groceries"}]
    assert body["alreadyFiled"] == ["t2"]
    assert body["vanished"] == [] and body["failed"] == []
    assert repo._find_row(f"ACCOUNT#{SPENDING}", "TXN#t2")["category"] == "coffee"   # the tap stands
    # It was attempted, so there is nothing left to come back for.
    assert body["remaining"] == 0


def test_a_row_that_changed_into_something_still_unfiled_is_retryable(handler):
    # A row that changed underneath is NOT automatically "filed". A settlement can carry the bank's
    # own raw label back onto the row, which still reads as unfiled — so calling that alreadyFiled
    # would let the app announce the job done while the badge still counts the charge. It belongs
    # in `failed`, which the app treats as work left.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1", category=None),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2", category=None),
    ]})
    # t2 was unfiled at scan time; mid-run it gains a raw bank label (a settlement carrying one
    # across), which still reads as unfiled.
    repo.refile_hook = lambda transaction_id, r: (
        r.set_category("t2", "TRANSFER_OUT") if transaction_id == "t1" else None)

    _, body = _call(handler, repo, [_rule("coles", "groceries")],
                    {"dryRun": False}, categories=("groceries", "coffee"))

    assert body["filed"] == [{"id": "t1", "category": "groceries"}]
    assert body["failed"] == ["t2"]        # still unfiled -> a re-run picks it up
    assert body["alreadyFiled"] == []


def test_a_stale_scan_does_not_overwrite_the_stored_category(handler):
    # The everyday version, not the exotic one: the scan reads an index that cannot be read
    # consistently, so "the scan says unfiled, storage already says filed" is the COMMON case.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="COLES 1", category="coffee")]})
    repo.scan_shows = {"t1": None}          # the index is behind: it still reports the row unfiled

    _, body = _call(handler, repo, [_rule("coles")],
                    {"dryRun": False}, categories=("groceries", "coffee"))

    assert body["filed"] == []
    assert body["alreadyFiled"] == ["t1"]
    row = repo._find_row(f"ACCOUNT#{SPENDING}", "TXN#t1")
    assert row["category"] == "coffee"
    # [WHIT-536] documents the handler-integration expectation: a refused write lands no rule
    # stamp on the row the user just claimed. The load-bearing fail-on-revert guard for this is
    # test_whit536_rejected_write_lands_no_stamp_on_hand_filed_row (real conditional write); here
    # the fake refuses before writing, so this line is a readability check, not a revert guard.
    assert "filed_by_rule" not in row


def test_running_twice_files_nothing_the_second_time(handler):
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1", category=None),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2", category=None),
    ]})
    _, first = _call(handler, repo, [_rule("coles")], {"dryRun": False})
    assert len(first["filed"]) == 2

    _, second = _call(handler, repo, [_rule("coles")], {"dryRun": False})
    assert second["matched"] == 0
    assert second["filed"] == []
    assert second["unfiled"] == 0


def test_a_row_that_vanished_mid_run_is_reported_separately_from_a_failure(handler):
    # The conditional write answers ("gone", None) — not an exception — when the row was deleted
    # between the scan and the write (a pending aged out, or its posted twin replaced it).
    # Nothing to retry, so it must NOT be reported as filed, as failed, OR as alreadyFiled:
    # only vanished rows may be dropped from the app's list.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "gone", description="COLES 1", category=None),
        _row(SPENDING, "2026-07-02", "boom", description="COLES 2", category=None),
        _row(SPENDING, "2026-07-01", "ok", description="COLES 3", category=None),
    ]})
    repo.vanished_ids = {"gone"}
    repo.error_ids = {"boom"}

    _, body = _call(handler, repo, [_rule("coles")], {"dryRun": False})

    assert body["filed"] == [{"id": "ok", "category": "groceries"}]
    assert body["vanished"] == ["gone"]
    assert body["alreadyFiled"] == []   # a deleted row is NOT a row someone else filed
    assert body["failed"] == ["boom"]
    assert body["remaining"] == 0      # all three were attempted


def test_one_failure_does_not_stop_the_rest(handler):
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES", category=None)
            for d in range(1, 6)]
    repo = WritableFeedRepo({SPENDING: rows})
    repo.error_ids = {"t3"}

    _, body = _call(handler, repo, [_rule("coles")], {"dryRun": False})

    assert len(body["filed"]) == 4 and body["failed"] == ["t3"]


def test_more_matches_than_the_write_cap_files_the_cap_and_reports_the_rest(handler, monkeypatch):
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 3)
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES", category=None)
            for d in range(1, 8)]
    repo = WritableFeedRepo({SPENDING: rows})

    _, body = _call(handler, repo, [_rule("coles")], {"dryRun": False})

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
    ticks = iter([0, 1, 9, 9, 9])
    monkeypatch.setattr(handler.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(handler, "APPLY_RULES_TIME_BUDGET_SECONDS", 5)
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES", category=None)
            for d in range(1, 5)]
    repo = WritableFeedRepo({SPENDING: rows})

    _, body = _call(handler, repo, [_rule("coles")], {"dryRun": False})

    assert len(body["filed"]) == 2      # wrote what it could...
    assert body["remaining"] == 2       # ...and reported the rest honestly
    assert len(repo.writes) == 2


def test_an_already_spent_budget_still_makes_one_attempt(handler, monkeypatch):
    # Guarantees forward progress: `started` is stamped before the rule read and the history
    # scan, so a slow pair could spend the whole budget before the first row. Without the
    # at-least-one floor the user would tap forever and never file anything.
    monkeypatch.setattr(handler, "APPLY_RULES_TIME_BUDGET_SECONDS", 0)
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES", category=None)
            for d in range(1, 5)]
    repo = WritableFeedRepo({SPENDING: rows})

    _, body = _call(handler, repo, [_rule("coles")], {"dryRun": False})

    assert len(body["filed"]) == 1      # never zero — progress is guaranteed
    assert body["remaining"] == 3


# --- scope, breakdown, and the cheap paths ------------------------------------


def test_no_rules_returns_zeros_without_scanning_history(handler):
    repo = WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1", category=None)]})
    _, body = _call(handler, repo, [], {})

    assert body["matched"] == 0 and body["unfiled"] == 0 and body["rulesConsidered"] == 0
    assert repo.calls == []            # the whole-history scan is skipped entirely


def test_deep_history_matches_are_found(handler):
    rows = [_row(ANZ, f"2026-05-{(i % 28) + 1:02d}", f"filed{i}",
                 description="WOOLWORTHS", category="groceries") for i in range(120)]
    rows.append(_row(ANZ, "2020-01-01", "deep", description="COLES OLD", category=None))
    repo = WritableFeedRepo({ANZ: rows})

    _, body = _call(handler, repo, [_rule("coles")], {"dryRun": False})

    assert body["filed"] == [{"id": "deep", "category": "groceries"}]
    assert len([c for c in repo.calls if c[0] == ANZ]) > 1   # genuinely paged past page 1


def test_the_preview_reports_conflicts_and_the_per_rule_breakdown(handler):
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "conflict", description="COLES RICHMOND", category=None),
        _row(SPENDING, "2026-07-02", "clean", description="COLES CARLTON", category=None),
    ]})
    rules = [_rule("coles", "groceries", rule_id="r-coles"),
             _rule("richmond", "coffee", rule_id="r-richmond")]

    _, body = _call(handler, repo, rules, {})

    assert body["conflicted"] == 1
    assert body["matched"] == 1
    assert body["byCategory"] == {"groceries": 1}
    assert {entry["ruleId"] for entry in body["byRule"]} == {"r-coles", "r-richmond"}


def test_a_rules_read_failure_reads_no_history_and_writes_nothing(handler):
    # WHIT-531: the rule read moved to our store, so a read failure is a DatabaseError -> 500
    # (our server), not the old BankSync 502. The early return leaves the transaction repo
    # untouched — nothing scanned, nothing written.
    repo = WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1", category=None)]})
    resp = handler.apply_rules_to_uncategorized(
        _apply_event({"dryRun": False}), repo, FakeCategoryRepo({"groceries"}),
        FakeRuleRepo(list_error=True))

    assert resp["statusCode"] == 500
    assert repo.calls == [] and repo.writes == []


# --- dispatch through lambda_handler ------------------------------------------


def test_post_routes_to_the_apply_handler(handler, monkeypatch):
    repo = WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1",
                                              description="COLES", category=None)]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo({"groceries"}))
    monkeypatch.setattr(handler, "RuleRepository", lambda: FakeRuleRepo(rules=[_rule("coles")]))

    resp = handler.lambda_handler(_apply_event({"dryRun": True}), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["matched"] == 1


@pytest.mark.parametrize("method", ["GET", "PATCH", "DELETE"])
def test_other_methods_on_the_apply_path_are_not_routed(handler, monkeypatch, method):
    # Method-gated: only POST applies rules. In particular a GET must not reach a write path,
    # and the PATCH "/transactions/{id}" branch must not swallow this path.
    def _boom(*a, **k):
        raise AssertionError("apply_rules_to_uncategorized must not run for " + method)

    monkeypatch.setattr(handler, "apply_rules_to_uncategorized", _boom)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: WritableFeedRepo({}))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(set()))

    resp = handler.lambda_handler(_apply_event({"dryRun": True}, method=method), None)

    assert resp["statusCode"] == 404
