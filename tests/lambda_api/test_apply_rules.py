"""Tests for POST /transactions/uncategorized/apply-rules (apply_rules_to_uncategorized).

BankSync applies rules at sync time to INCOMING charges only, so rules never reach charges
already stored (WHIT-502). This route closes that gap over full history. The safety-critical
property: it PREVIEWS unless the body explicitly says {"dryRun": false}, so a bulk write to real
data can never happen by accident.

Reuses FakeFeedRepo (the realistic paged date-index fake) so the whole-history scan is genuinely
exercised, and fakes `list_rules` at the handler boundary — the BankSync HTTP plumbing has its own
suite (test_enrichments.py).
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, _row, FakeFeedRepo


class _FakeCategoryRepo:
    def __init__(self, category_ids):
        self._categories = [{"id": category_id} for category_id in category_ids]

    def list_categories(self):
        return [dict(category) for category in self._categories]


class _WritableFeedRepo(FakeFeedRepo):
    """FakeFeedRepo plus the category write, so a second run really sees the first run's effect."""

    def __init__(self, rows_by_account):
        super().__init__(rows_by_account)
        self.writes = []
        self.vanished_ids = set()
        self.error_ids = set()

    def update_transaction_category(self, pk, sk, category):
        transaction_id = sk.split("#", 1)[1]
        self.writes.append((pk, sk, category))
        if transaction_id in self.error_ids:
            from repository import DatabaseError
            raise DatabaseError("write failed")
        if transaction_id in self.vanished_ids:
            return False
        for rows in self._rows.values():
            for row in rows:
                if row["sk"] == sk:
                    row["category"] = category
        return True


def _rule(value, category_id="groceries", field="description", operator="contains", rule_id="r1"):
    return {"id": rule_id, "field": field, "operator": operator, "value": value,
            "categoryId": category_id}


def _apply_event(body=None, method="POST"):
    event = {
        "rawPath": "/transactions/uncategorized/apply-rules",
        "requestContext": {"http": {"method": method}},
    }
    if body is not None:
        event["body"] = json.dumps(body)
    return event


def _call(handler, monkeypatch, repo, rules, body, categories=frozenset({"groceries", "coffee"})):
    monkeypatch.setattr(handler, "list_rules", lambda: list(rules))
    resp = handler.apply_rules_to_uncategorized(
        _apply_event(body), repo, _FakeCategoryRepo(categories))
    return resp, json.loads(resp["body"])


# --- the safety property: preview unless explicitly told otherwise ------------


def test_dry_run_is_the_default_and_writes_nothing(handler, monkeypatch):
    repo = _WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1",
                                              description="COLES 1", category=None)]})
    resp, body = _call(handler, monkeypatch, repo, [_rule("coles")], {})

    assert resp["statusCode"] == 200
    assert body["dryRun"] is True
    assert body["matched"] == 1
    assert body["filed"] == []
    assert repo.writes == []          # FAIL-ON-REVERT: a default of False would write here
    assert body["remaining"] == 1


def test_explicit_dry_run_true_writes_nothing(handler, monkeypatch):
    repo = _WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1",
                                              description="COLES", category=None)]})
    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": True})
    assert body["filed"] == [] and repo.writes == []


@pytest.mark.parametrize("bad", ["false", "no", 0, 1, None])
def test_a_non_boolean_dry_run_is_rejected_rather_than_guessed(handler, monkeypatch, bad):
    repo = _WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1", category=None)]})
    monkeypatch.setattr(handler, "list_rules", lambda: [_rule("coles")])
    resp = handler.apply_rules_to_uncategorized(
        _apply_event({"dryRun": bad}), repo, _FakeCategoryRepo({"groceries"}))

    assert resp["statusCode"] == 400
    assert repo.writes == []


def test_a_missing_body_is_rejected_not_treated_as_a_write(handler, monkeypatch):
    repo = _WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1", category=None)]})
    monkeypatch.setattr(handler, "list_rules", lambda: [_rule("coles")])
    resp = handler.apply_rules_to_uncategorized(
        _apply_event(), repo, _FakeCategoryRepo({"groceries"}))

    assert resp["statusCode"] == 400
    assert repo.writes == []


# --- the write path -----------------------------------------------------------


def test_the_write_files_matching_charges_by_their_own_keys(handler, monkeypatch):
    repo = _WritableFeedRepo({
        SPENDING: [_row(SPENDING, "2026-07-02", "hit", description="COLES 1", category=None),
                   _row(SPENDING, "2026-07-01", "miss", description="BP FUEL", category=None)],
    })
    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert body["dryRun"] is False
    assert body["filed"] == [{"id": "hit", "category": "groceries"}]
    assert body["remaining"] == 0
    # Written by the row's OWN pk/sk from the scan — no id->keys lookup round trip.
    assert repo.writes == [(f"ACCOUNT#{SPENDING}", "TXN#hit", "groceries")]


def test_running_twice_files_nothing_the_second_time(handler, monkeypatch):
    repo = _WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1", category=None),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2", category=None),
    ]})
    _, first = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})
    assert len(first["filed"]) == 2

    _, second = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})
    assert second["matched"] == 0
    assert second["filed"] == []
    assert second["unfiled"] == 0


def test_a_row_that_vanished_mid_run_is_reported_separately_from_a_failure(handler, monkeypatch):
    # update_transaction_category returns False (not an exception) when the row was deleted
    # between the scan and the write — a pending aged out, or its posted twin replaced it.
    # Nothing to retry, so it must NOT be reported as filed OR as failed.
    repo = _WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "gone", description="COLES 1", category=None),
        _row(SPENDING, "2026-07-02", "boom", description="COLES 2", category=None),
        _row(SPENDING, "2026-07-01", "ok", description="COLES 3", category=None),
    ]})
    repo.vanished_ids = {"gone"}
    repo.error_ids = {"boom"}

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert body["filed"] == [{"id": "ok", "category": "groceries"}]
    assert body["vanished"] == ["gone"]
    assert body["failed"] == ["boom"]
    assert body["remaining"] == 0      # all three were attempted


def test_one_failure_does_not_stop_the_rest(handler, monkeypatch):
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES", category=None)
            for d in range(1, 6)]
    repo = _WritableFeedRepo({SPENDING: rows})
    repo.error_ids = {"t3"}

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert len(body["filed"]) == 4 and body["failed"] == ["t3"]


def test_more_matches_than_the_write_cap_files_the_cap_and_reports_the_rest(handler, monkeypatch):
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 3)
    rows = [_row(SPENDING, f"2026-07-{d:02d}", f"t{d}", description="COLES", category=None)
            for d in range(1, 8)]
    repo = _WritableFeedRepo({SPENDING: rows})

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

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
    repo = _WritableFeedRepo({SPENDING: rows})

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

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
    repo = _WritableFeedRepo({SPENDING: rows})

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert len(body["filed"]) == 1      # never zero — progress is guaranteed
    assert body["remaining"] == 3


def test_a_multi_condition_rule_is_never_applied(handler, monkeypatch):
    # A foreign rule like "description contains UBER AND amount > 50" reaches us BROADENED (we
    # only read the first condition), so applying it would mis-file every Uber charge. Listing
    # it is harmless; acting on it is not.
    repo = _WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", category=None)]})
    broad = _rule("uber", rule_id="r-multi")
    broad["conditionCount"] = 2

    _, body = _call(handler, monkeypatch, repo, [broad], {"dryRun": False})

    assert body["filed"] == [] and repo.writes == []
    assert body["skippedRules"][0]["reason"] == "rule has more than one condition"


# --- scope, breakdown, and the cheap paths ------------------------------------


def test_no_rules_returns_zeros_without_scanning_history(handler, monkeypatch):
    repo = _WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1", category=None)]})
    _, body = _call(handler, monkeypatch, repo, [], {})

    assert body["matched"] == 0 and body["unfiled"] == 0 and body["rulesConsidered"] == 0
    assert repo.calls == []            # the whole-history scan is skipped entirely


def test_deep_history_matches_are_found(handler, monkeypatch):
    rows = [_row(ANZ, f"2026-05-{(i % 28) + 1:02d}", f"filed{i}",
                 description="WOOLWORTHS", category="groceries") for i in range(120)]
    rows.append(_row(ANZ, "2020-01-01", "deep", description="COLES OLD", category=None))
    repo = _WritableFeedRepo({ANZ: rows})

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert body["filed"] == [{"id": "deep", "category": "groceries"}]
    assert len([c for c in repo.calls if c[0] == ANZ]) > 1   # genuinely paged past page 1


def test_the_preview_reports_conflicts_and_the_per_rule_breakdown(handler, monkeypatch):
    repo = _WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "conflict", description="COLES RICHMOND", category=None),
        _row(SPENDING, "2026-07-02", "clean", description="COLES CARLTON", category=None),
    ]})
    rules = [_rule("coles", "groceries", rule_id="r-coles"),
             _rule("richmond", "coffee", rule_id="r-richmond")]

    _, body = _call(handler, monkeypatch, repo, rules, {})

    assert body["conflicted"] == 1
    assert body["matched"] == 1
    assert body["byCategory"] == {"groceries": 1}
    assert {entry["ruleId"] for entry in body["byRule"]} == {"r-coles", "r-richmond"}


def test_a_banksync_failure_reads_no_history_and_writes_nothing(handler, monkeypatch):
    repo = _WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1", category=None)]})

    def _boom():
        raise handler.BankSyncError(502, "BankSync GET /v1/enrichments -> 502")

    monkeypatch.setattr(handler, "list_rules", _boom)
    resp = handler.apply_rules_to_uncategorized(
        _apply_event({"dryRun": False}), repo, _FakeCategoryRepo({"groceries"}))

    assert resp["statusCode"] == 502
    assert repo.calls == [] and repo.writes == []


# --- dispatch through lambda_handler ------------------------------------------


def test_post_routes_to_the_apply_handler(handler, monkeypatch):
    repo = _WritableFeedRepo({SPENDING: [_row(SPENDING, "2026-07-01", "t1",
                                              description="COLES", category=None)]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _FakeCategoryRepo({"groceries"}))
    monkeypatch.setattr(handler, "list_rules", lambda: [_rule("coles")])

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
    monkeypatch.setattr(handler, "TransactionRepository", lambda: _WritableFeedRepo({}))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: _FakeCategoryRepo(set()))

    resp = handler.lambda_handler(_apply_event({"dryRun": True}, method=method), None)

    assert resp["statusCode"] == 404
