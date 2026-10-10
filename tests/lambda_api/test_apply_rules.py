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
from decimal import Decimal

import pytest

from _feed_fakes import (
    apply_rules_event,
    ANZ, SPENDING, HOMELOAN, WESTPAC, FakeCategoryRepo, charge_writes, date_queries, fail_writes,
    on_write, real_repos, _row, _rule, set_category, stored, vanish_on_write,
)
from _rule_ingest_fakes import apply_rules_to_uncategorized


def _rule_ids(rule_repo):
    # The ids the real store minted, by rule value.
    return {rule["value"]: rule["id"] for rule in rule_repo.list_rules()}


def _call(handler, repo, rule_repo, body, categories=frozenset({"groceries", "coffee"})):
    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event(body), repo, FakeCategoryRepo(categories), rule_repo)
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


@pytest.mark.parametrize("bad", ["false", "no", 0, 1, None])
def test_a_non_boolean_dry_run_is_rejected_rather_than_guessed(handler, bad):
    table, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1")]}, rules=[_rule("coles")])
    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event({"dryRun": bad}), repo, FakeCategoryRepo({"groceries"}), rule_repo)

    assert resp["statusCode"] == 400
    assert table.update_calls == []


def test_a_missing_body_is_rejected_not_treated_as_a_write(handler):
    table, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1")]}, rules=[_rule("coles")])
    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event(), repo, FakeCategoryRepo({"groceries"}), rule_repo)

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


@pytest.mark.parametrize("mid_run_category, bucket", [
    ("coffee", "alreadyFiled"),        # the user taps the raw-labelled charge
    ("TRANSFER_OUT", "failed"),        # a re-sync swaps the raw label: retry
])
def test_a_mid_run_change_to_a_raw_labelled_charge_is_never_overwritten(
        handler, mid_run_category, bucket):
    # The scan saw t2 with the bank's raw label, so the real conditional write takes its
    # `#c = :expected` half (the unfiled half is covered above). It must refuse the rule's write
    # once the row changed — and a change into another raw label is still unfiled, so it is
    # reported as failed (retry), not filed.
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1"),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2", category="FOOD_AND_DRINK"),
    ]}, rules=[_rule("coles")])
    on_write(table, "t1", lambda tbl: set_category(tbl, "t2", mid_run_category))

    resp, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert resp["statusCode"] == 200
    assert body["filed"] == [{"id": "t1", "category": "groceries"}]
    assert body[bucket] == ["t2"]
    assert stored(table, "t2")["category"] == mid_run_category
    assert "filed_by_rule" not in stored(table, "t2")


def test_a_charge_that_became_income_mid_run_is_already_filed_not_retried_forever(handler):
    # `income` is the one category that counts as FILED without being a taxonomy id
    # (is_unfiled_category). A settlement or a tap that lands it on income leaves nothing to
    # retry. Classify it as unfiled instead and the write is refused every round while the app
    # keeps offering "Apply the rest" — an endless loop over one charge.
    # FAIL-ON-REVERT: swap `is_unfiled(current_category)` for `current_category not in taxonomy`
    # and this row moves to `failed` -> red.
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1"),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2"),
    ]}, rules=[_rule("coles")])
    on_write(table, "t1", lambda tbl: set_category(tbl, "t2", "income"))

    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert body["alreadyFiled"] == ["t2"]
    assert body["failed"] == []
    assert body["remaining"] == 0                       # nothing to come back for
    assert stored(table, "t2")["category"] == "income"


def test_a_row_that_changed_into_a_raw_label_is_retried_against_the_NEW_value(handler):
    # The other half of termination. A row that changed into something still unfiled (a re-sync
    # carrying the bank's own label back on) lands in `failed`, so the app offers another round —
    # and that round must actually be able to win, or the retry is a lie. The second run re-scans,
    # so it compares against the label the row holds NOW.
    # FAIL-ON-REVERT: cache/reuse the first scan's expected value (or pass the rule's target) and
    # the second round is refused too -> red.
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1"),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2"),
    ]}, rules=[_rule("coles")])
    # t1 is filed on the first run, so the second run never writes it and the relabel runs once.
    on_write(table, "t1", lambda tbl: set_category(tbl, "t2", "TRANSFER_OUT"))

    _, first = _call(handler, repo, rule_repo, {"dryRun": False})
    assert first["failed"] == ["t2"]

    _, second = _call(handler, repo, rule_repo, {"dryRun": False})

    assert second["filed"] == [{"id": "t2", "category": "groceries"}]
    assert second["failed"] == [] and second["remaining"] == 0
    assert stored(table, "t2")["category"] == "groceries"


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
    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event({"dryRun": False}), repo, FakeCategoryRepo({"groceries"}), rule_repo)

    assert resp["statusCode"] == 500
    assert date_queries(table) == [] and table.update_calls == []


def test_matches_in_every_account_are_filed_in_scan_order(handler):
    # The scan walks all four accounts in ACCOUNT_ID_MAP order, each newest-first. An account
    # silently dropped from the scan is otherwise invisible: the response would still look like a
    # clean success.
    _, repo, rule_repo = real_repos({
        ANZ: [_row(ANZ, "2026-07-01", "anz-old", description="COLES"),
              _row(ANZ, "2026-07-09", "anz-new", description="COLES")],
        SPENDING: [_row(SPENDING, "2026-07-05", "spend", description="COLES")],
        HOMELOAN: [_row(HOMELOAN, "2026-07-06", "loan", description="COLES")],
        WESTPAC: [_row(WESTPAC, "2026-07-07", "west", description="COLES")],
    }, rules=[_rule("coles")])

    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert [entry["id"] for entry in body["filed"]] == [
        "anz-new", "anz-old", "spend", "loan", "west"]
    assert body["unfiled"] == 5


def test_the_plain_sweep_still_files_across_ALL_her_rules(handler):
    # REGRESSION GUARD — the worst outcome of WHIT-523 would be the inline scoping leaking onto
    # the plain "Apply my rules" button (no inline rule), quietly filing only ONE of her rules.
    # With no inline `rule`, EVERY rule must still sweep: a COLES charge AND a BP charge both
    # file, to their own categories, and both rules show in byRule.
    _, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-04", "t1", description="COLES 0342"),
        _row(SPENDING, "2026-07-03", "t2", description="COLES ONLINE"),
        _row(SPENDING, "2026-07-02", "b1", description="BP 2210 SERVO"),
        _row(SPENDING, "2026-07-01", "n1", description="NETFLIX.COM"),
    ]}, rules=[_rule("COLES", "groceries"), _rule("BP 2210", "petrol")])

    resp, body = _call(handler, repo, rule_repo, {"dryRun": False},
                       categories=("groceries", "petrol"))

    assert resp["statusCode"] == 200
    assert body["createdRule"] is None                                  # plain path mints nothing
    assert len(rule_repo.list_rules()) == 2
    assert sorted(filed["id"] for filed in body["filed"]) == ["b1", "t1", "t2"]  # never n1
    assert body["byCategory"] == {"groceries": 2, "petrol": 1}
    assert body["rulesConsidered"] == 2
    ids = _rule_ids(rule_repo)
    assert sorted(entry["ruleId"] for entry in body["byRule"]) == sorted(
        [ids["COLES"], ids["BP 2210"]])


def test_a_conflicted_charge_is_never_written_even_on_a_real_write_run(handler):
    # A conflict must never be silently decided by the WRITE path either.
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-03", "conflict", description="COLES RICHMOND"),
        _row(SPENDING, "2026-07-02", "clean", description="COLES CARLTON"),
    ]}, rules=[_rule("coles", "groceries"), _rule("richmond", "coffee")])

    _, body = _call(handler, repo, rule_repo, {"dryRun": False})

    assert body["conflicted"] == 1
    assert [entry["id"] for entry in body["filed"]] == ["clean"]
    # The conflict was not touched.
    assert charge_writes(table) == [(f"ACCOUNT#{SPENDING}", "TXN#clean")]
    # And the conflict is actionable, not a bare number the user can't chase down.
    assert body["conflictedSamples"] == [
        {"description": "COLES RICHMOND", "categoryIds": ["coffee", "groceries"]}]


_UNDER_30 = [{"field": "merchant", "operator": "contains", "value": "uber"},
             {"field": "amount", "operator": "less_than", "value": "30"}]
_CREDIT = [{"field": "direction", "operator": "is", "value": "credit"}]


@pytest.mark.parametrize("conditions, category_id, amount, expected", [
    (_UNDER_30, "transport", Decimal("-25.00"), "transport"),   # every AND condition holds
    (_UNDER_30, "transport", Decimal("-40.00"), None),          # misses the amount condition
    (_CREDIT, "income", Decimal("1500.00"), "income"),          # direction=credit files income
    (_CREDIT, "income", Decimal("-25.00"), None),               # ...and leaves a spend alone
])
def test_the_sweep_files_by_a_multi_condition_rule(handler, conditions, category_id, amount, expected):
    # WHIT-561: the stored charge is filed only when every condition of the rule holds.
    first = conditions[0]
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", merchant_name="UBER",
             amount=amount)]},
        rules=[_rule(first["value"], category_id, first["field"], first["operator"],
                     conditions=conditions, logic="all")])

    _, body = _call(handler, repo, rule_repo, {"dryRun": False},
                    categories=frozenset({"transport"}))

    assert stored(table, "t1").get("category") == expected
    assert body["matched"] == (1 if expected else 0)


@pytest.mark.parametrize("row_fields, expected", [
    ({}, {"category": "groceries"}),                                   # the rule never excludes
    ({"budget_excluded": True}, {"category": "groceries", "budget_excluded": True}),  # hand-set
])
def test_a_rule_with_the_budget_flag_off_never_touches_the_flag(handler, row_fields, expected):
    # WHIT-558: a rule with "keep out of budget" OFF files the category but never writes the flag
    # — not True on a charge whose rule never asked, and not False over the user's own hand-set
    # exclusion. FAIL-ON-REVERT: passing budget_excluded unconditionally reddens one of the rows.
    table, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1", description="COLES 1", **row_fields)]},
        rules=[_rule("coles", budget_excluded=False)])

    _call(handler, repo, rule_repo, {"dryRun": False})

    row = stored(table, "t1")
    assert {key: row[key] for key in ("category", "budget_excluded") if key in row} == expected


# --- the taxonomy coupling and parity with the badge ----------------------------


def test_an_empty_taxonomy_skips_every_rule_but_still_honours_an_income_rule(handler):
    # A brand-new user with no categories yet: every normal rule's target is "unfiled" by the
    # badge's own predicate, so it is skipped and nothing is written — filing to a non-existent
    # category would leave the charge unfiled and the next run would re-file it forever. `income`
    # is the one target that is filed WITHOUT being a taxonomy id.
    table, repo, rule_repo = real_repos({SPENDING: [
        _row(SPENDING, "2026-07-02", "shop", description="COLES"),
        _row(SPENDING, "2026-07-01", "pay", description="ACME SALARY"),
    ]}, rules=[_rule("coles", "groceries"), _rule("salary", "income")])

    _, body = _call(handler, repo, rule_repo, {"dryRun": False}, categories=())

    assert [entry["reason"] for entry in body["skippedRules"]] == ["category no longer exists"]
    assert body["skippedRules"][0]["id"] == _rule_ids(rule_repo)["coles"]
    assert body["filed"] == [{"id": "pay", "category": "income"}]
    assert charge_writes(table) == [(f"ACCOUNT#{SPENDING}", "TXN#pay")]


def test_deleting_the_targeted_category_between_runs_neither_writes_nor_loops(handler):
    # Safe-to-run-twice under a CHANGING taxonomy. Run 1 files t1 -> groceries. The user then
    # deletes "groceries". Run 2 sees t1 as unfiled again (its category is now a dangling id)
    # but the rule is now skipped, so nothing is re-written and nothing loops.
    table, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1", description="COLES")]},
        rules=[_rule("coles")])

    _, first = _call(handler, repo, rule_repo, {"dryRun": False}, categories=("groceries",))
    assert first["filed"] == [{"id": "t1", "category": "groceries"}]

    _, second = _call(handler, repo, rule_repo, {"dryRun": False}, categories=("coffee",))

    assert second["unfiled"] == 1           # the row reads as unfiled again...
    assert second["matched"] == 0           # ...but the rule can no longer file it
    assert second["filed"] == [] and second["remaining"] == 0
    assert len(table.update_calls) == 1     # no second write


def test_the_previews_unfiled_total_equals_the_badge_count_endpoint(handler):
    # "The unfiled set matches the badge's rule", asserted against the REAL count endpoint on the
    # same rows and taxonomy — not a re-implementation. The mix deliberately includes an income
    # row, a raw-enum row, an excluded transfer, and a no-category row, which is exactly where a
    # divergent predicate would show up.
    rows = {
        ANZ: [
            _row(ANZ, "2026-07-05", "null", description="COLES"),
            _row(ANZ, "2026-07-04", "raw", description="BP", category="TRANSPORT"),
            _row(ANZ, "2026-07-03", "filed", description="ALDI", category="groceries"),
            _row(ANZ, "2026-07-02", "pay", description="ACME SALARY", category="income"),
        ],
        SPENDING: [
            _row(SPENDING, "2026-07-01", "transfer", description="TRANSFER OUT",
                 counts_to_budget=False, budget_excluded=True),
        ],
    }
    taxonomy = {"groceries", "coffee"}

    _, count_repo, _ = real_repos(rows)
    count_resp = handler.get_uncategorized_count(count_repo, FakeCategoryRepo(taxonomy))
    badge_count = json.loads(count_resp["body"])["count"]

    _, repo, rule_repo = real_repos(rows, rules=[_rule("zzz-matches-nothing")])
    _, body = _call(handler, repo, rule_repo, {}, categories=tuple(taxonomy))

    assert body["unfiled"] == badge_count
    assert badge_count == 3     # no category + raw enum + excluded transfer; income is filed


def test_validate_rule_body_rejects_a_non_boolean_budget_excluded(handler):
    event = {"body": json.dumps({"value": "COLES", "categoryId": "groceries",
                                 "budgetExcluded": "yes"})}
    parsed, error = handler._validate_rule_body(event)
    assert parsed is None
    assert error["statusCode"] == 400


# --- dispatch through lambda_handler ------------------------------------------


def test_post_routes_to_the_apply_handler(handler, monkeypatch):
    _, repo, rule_repo = real_repos(
        {SPENDING: [_row(SPENDING, "2026-07-01", "t1", description="COLES")]},
        rules=[_rule("coles")])
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo({"groceries"}))
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)

    resp = handler.lambda_handler(apply_rules_event({"dryRun": True}), None)

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

    resp = handler.lambda_handler(apply_rules_event({"dryRun": True}, method=method), None)

    assert resp["statusCode"] == 404
