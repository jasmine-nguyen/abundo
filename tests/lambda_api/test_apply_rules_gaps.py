"""ADVERSARIAL gap tests for POST /transactions/uncategorized/apply-rules.

These do NOT duplicate tests/lambda_api/test_apply_rules.py or test_rule_apply.py. Those suites
lock the preview-by-default safety property, the write-by-own-keys path, run-twice, the
vanished-vs-failed split, the cap, the budget floor, the deep-history page walk, the BankSync
502, and the pure matcher's case/space/conflict rules.

What they do NOT lock, and this file does:

  * [A10]-[A13] the budget tripping MID-run, and the `remaining` arithmetic across every exit
    path — a row whose write RAISED counts as attempted (so it is NOT in `remaining`) even
    though it is still unfiled. Pinned deliberately: it is the one place the headline number
    can understate what is left, and the caller must read `failed` alongside it.
  * [A14] every account is scanned and `filed` follows the scan order — an account dropped
    from the scan is otherwise invisible (the response still looks like a clean success).
  * [A15] `byCategory` describes the PLAN, `filed` describes the WRITE — after a capped run
    the two deliberately disagree, and the app must not render byCategory as "what was filed".
  * [A16]-[A17] conflicts and skipped rules on the WRITE path (previously only previewed).
  * [A18]-[A20] the taxonomy coupling: an EMPTY taxonomy skips every rule but still honours an
    `income` rule; a category id differing only by CASE is skipped; deleting the targeted
    category between runs neither writes nor loops.
  * [A21]-[A25] body parsing on THIS route: base64 gateway bodies, a JSON array, garbage,
    unknown extra keys, and `{}` (valid object -> preview, vs missing body -> 400).
  * [A30]-[A36] matcher edges: same-category rules double-counted in byRule, non-string rule
    values and descriptions, unicode/accents, a rule with NO categoryId, `equals` vs substring,
    the empty-string category.
  * [A40] parity with the badge — the preview's `unfiled` equals the real count endpoint on the
    same rows and taxonomy, asserted against that endpoint rather than a re-implementation.

Reuses the shared paged date-index fake (_feed_fakes), so this suite is registered in the
`feed` domain tuple of tests/shared/test_fakes_invariants.py.
"""

import base64
import json

import pytest

from _feed_fakes import ANZ, HOMELOAN, SPENDING, WESTPAC, _row, WritableFeedRepo


class _CategoryRepo:
    def __init__(self, category_ids):
        self._categories = [{"id": category_id} for category_id in category_ids]

    def list_categories(self):
        return [dict(category) for category in self._categories]


class _StepClock:
    """Stands in for the handler's `time` module with a clock that advances a fixed step on
    every read — deterministic, no real time, no sleep."""

    def __init__(self, step):
        self.step = step
        self.reads = 0

    def monotonic(self):
        value = self.reads * self.step
        self.reads += 1
        return value


def _rule(value, category_id="groceries", field="description", operator="contains", rule_id="r1"):
    return {"id": rule_id, "field": field, "operator": operator, "value": value,
            "categoryId": category_id}


def _apply_event(body=None, raw=None, base64_encoded=False):
    event = {
        "rawPath": "/transactions/uncategorized/apply-rules",
        "requestContext": {"http": {"method": "POST"}},
    }
    if raw is not None:
        event["body"] = raw
    elif body is not None:
        event["body"] = json.dumps(body)
    if base64_encoded:
        event["isBase64Encoded"] = True
    return event


def _call(handler, monkeypatch, repo, rules, body, categories=("groceries", "coffee"), **event_kw):
    monkeypatch.setattr(handler, "list_rules", lambda: list(rules))
    resp = handler.apply_rules_to_uncategorized(
        _apply_event(body, **event_kw), repo, _CategoryRepo(set(categories)))
    return resp, json.loads(resp["body"])


def _coles_rows(account, count, first_day=1):
    return [_row(account, f"2026-07-{first_day + i:02d}", f"t{first_day + i}",
                 description=f"COLES {i}", category=None) for i in range(count)]


# --- [A10]-[A13] the time budget mid-run, and what `remaining` really counts ---------------


def test_the_budget_tripping_mid_run_files_what_it_managed_and_reports_the_rest(
        handler, monkeypatch):
    # [A10] The REAL "tap again" case: some rows written, THEN the clock runs out. The first row
    # never reads the clock (the progress floor short-circuits it), so reads are:
    # start=0, row2=4, row3=8, row4=12 -> 12-0 >= 10 -> stop after 3 writes.
    monkeypatch.setattr(handler, "APPLY_RULES_TIME_BUDGET_SECONDS", 10)
    monkeypatch.setattr(handler, "time", _StepClock(step=4))
    repo = WritableFeedRepo({SPENDING: _coles_rows(SPENDING, 5)})

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert body["matched"] == 5
    assert len(body["filed"]) == 3          # partial, not all-or-nothing
    assert len(repo.writes) == 3            # it really stopped writing
    assert body["remaining"] == 2           # honest "tap again for the rest"
    assert body["failed"] == [] and body["vanished"] == []


def test_the_budget_covers_the_whole_request_but_still_guarantees_one_write(
        handler, monkeypatch):
    # [A11] `started` is stamped BEFORE list_rules and the whole-history scan, so a slow read
    # eats the write budget — that is the point (the API Gateway window covers the whole
    # request). But the progress floor guarantees at least ONE write anyway, so a slow read can
    # never starve the loop into returning "0 filed, N remaining" forever.
    monkeypatch.setattr(handler, "APPLY_RULES_TIME_BUDGET_SECONDS", 10)
    clock = _StepClock(step=4)
    monkeypatch.setattr(handler, "time", clock)
    repo = WritableFeedRepo({SPENDING: _coles_rows(SPENDING, 3)})

    def _slow_rules():
        clock.monotonic()                   # the read burns 4s of the budget
        clock.monotonic()                   # ...and the scan another 4s
        return [_rule("coles")]

    monkeypatch.setattr(handler, "list_rules", _slow_rules)
    resp = handler.apply_rules_to_uncategorized(
        _apply_event({"dryRun": False}), repo, _CategoryRepo({"groceries"}))
    body = json.loads(resp["body"])

    # The budget is long spent by the first row, but the floor still writes one.
    assert len(body["filed"]) == 1
    assert body["remaining"] == 2


def test_a_row_whose_write_failed_is_counted_as_attempted_not_as_remaining(handler, monkeypatch):
    # [A12] Pins the arithmetic: `remaining = matched - attempted`, and a DatabaseError counts
    # as an attempt (it consumed a slot of the write cap). Cap 3 over 5 matches with one failing
    # -> 2 filed + 1 failed = 3 attempts, so remaining is 2, NOT 3.
    # Consequence worth knowing: `remaining` UNDERSTATES what is still unfiled whenever a write
    # failed. The failed ids are reported separately, so the caller can still see them.
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 3)
    repo = WritableFeedRepo({SPENDING: _coles_rows(SPENDING, 5)})
    repo.error_ids = {"t4"}                 # scan order is newest-first: t5, t4, t3, t2, t1

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert body["failed"] == ["t4"]
    assert [entry["id"] for entry in body["filed"]] == ["t5", "t3"]
    assert body["remaining"] == 2
    assert len(repo.writes) == 3            # the failure consumed a cap slot


def test_a_row_filed_by_the_user_mid_run_consumes_a_cap_slot_and_leaves_no_remainder(
        handler, monkeypatch):
    # [A12b] WHIT-508's arithmetic. A row the user filed mid-run was ATTEMPTED, so it consumes a
    # slot of the write cap and drops out of `remaining` — and there is genuinely nothing to come
    # back for, since it is filed and the next scan won't even see it. Cap 3 over 5 matches with
    # one lost race -> 2 filed + 1 alreadyFiled = 3 attempts, remaining 2.
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 3)
    repo = WritableFeedRepo({SPENDING: _coles_rows(SPENDING, 5)})
    repo.scan_shows = {"t4": None}          # the scan is behind...
    repo.set_category("t4", "coffee")       # ...the user already filed it

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False},
                    categories=("groceries", "coffee"))

    assert body["alreadyFiled"] == ["t4"]
    assert [entry["id"] for entry in body["filed"]] == ["t5", "t3"]
    assert body["remaining"] == 2
    assert len(repo.writes) == 3            # the lost race consumed a cap slot


def test_a_run_where_every_write_fails_reports_remaining_zero_while_nothing_was_filed(
        handler, monkeypatch):
    # [A13] The honesty boundary. Every row still needs filing, yet `remaining` is 0 because
    # every row was ATTEMPTED. The caller must read `failed` (not `remaining`) to know a retry
    # is worthwhile. Pinned so a change to this semantic is a deliberate one.
    repo = WritableFeedRepo({SPENDING: _coles_rows(SPENDING, 3)})
    repo.error_ids = {"t1", "t2", "t3"}

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert body["filed"] == []
    assert sorted(body["failed"]) == ["t1", "t2", "t3"]
    assert body["remaining"] == 0
    assert body["matched"] == 3             # ...but `matched` still tells the true story


def test_a_run_where_every_row_vanished_files_nothing_and_leaves_nothing_remaining(
        handler, monkeypatch):
    # [A13b] The other all-or-nothing exit: every row was deleted between scan and write.
    # Nothing to retry, so remaining 0 here IS honest.
    repo = WritableFeedRepo({SPENDING: _coles_rows(SPENDING, 3)})
    repo.vanished_ids = {"t1", "t2", "t3"}

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert body["filed"] == [] and body["failed"] == []
    assert sorted(body["vanished"]) == ["t1", "t2", "t3"]
    assert body["remaining"] == 0


# --- [A14]-[A17] scope of the scan, and the write path's breakdown -------------------------


def test_matches_in_every_account_are_filed_in_scan_order(handler, monkeypatch):
    # [A14] The scan walks all four accounts in ACCOUNT_ID_MAP order, each newest-first. An
    # account silently dropped from the scan is otherwise invisible: the response would still
    # look like a clean success.
    repo = WritableFeedRepo({
        ANZ: [_row(ANZ, "2026-07-01", "anz-old", description="COLES", category=None),
              _row(ANZ, "2026-07-09", "anz-new", description="COLES", category=None)],
        SPENDING: [_row(SPENDING, "2026-07-05", "spend", description="COLES", category=None)],
        HOMELOAN: [_row(HOMELOAN, "2026-07-06", "loan", description="COLES", category=None)],
        WESTPAC: [_row(WESTPAC, "2026-07-07", "west", description="COLES", category=None)],
    })

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert [entry["id"] for entry in body["filed"]] == [
        "anz-new", "anz-old", "spend", "loan", "west"]
    assert body["unfiled"] == 5


def test_by_category_describes_the_plan_while_filed_describes_the_write(handler, monkeypatch):
    # [A15] After a capped run the two deliberately disagree: byCategory counts every MATCH,
    # `filed` only what was written. Pinned so the app never renders byCategory as "filed".
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 2)
    repo = WritableFeedRepo({SPENDING: _coles_rows(SPENDING, 5)})

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert body["byCategory"] == {"groceries": 5}     # the PLAN
    assert len(body["filed"]) == 2                    # the WRITE
    assert body["matched"] == 5 and body["remaining"] == 3
    assert sum(entry["count"] for entry in body["byRule"]) == 5


def test_a_conflicted_charge_is_never_written_even_on_a_real_write_run(handler, monkeypatch):
    # [A16] The impl suite only proves conflicts in the PREVIEW. A conflict must never be
    # silently decided by the WRITE path either.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "conflict", description="COLES RICHMOND", category=None),
        _row(SPENDING, "2026-07-02", "clean", description="COLES CARLTON", category=None),
    ]})
    rules = [_rule("coles", "groceries", rule_id="r-coles"),
             _rule("richmond", "coffee", rule_id="r-richmond")]

    _, body = _call(handler, monkeypatch, repo, rules, {"dryRun": False})

    assert body["conflicted"] == 1
    assert [entry["id"] for entry in body["filed"]] == ["clean"]
    assert [write[1] for write in repo.writes] == ["TXN#clean"]   # the conflict was not touched
    # And the conflict is actionable, not a bare number the user can't chase down.
    assert body["conflictedSamples"] == [
        {"description": "COLES RICHMOND", "categoryIds": ["coffee", "groceries"]}]


def test_skipped_rules_are_reported_on_the_write_path_and_file_nothing(handler, monkeypatch):
    # [A17] Same: the impl suite reports skipped rules only from the pure planner.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES", category=None)]})
    rules = [_rule("coles", "deleted-cat", rule_id="dangling"),
             _rule("x", field="amount", rule_id="unsupported"),
             _rule("   ", rule_id="blank")]

    _, body = _call(handler, monkeypatch, repo, rules, {"dryRun": False})

    assert {entry["id"]: entry["reason"] for entry in body["skippedRules"]} == {
        "dangling": "category no longer exists",
        "unsupported": "unsupported rule type",
        "blank": "empty rule value",
    }
    assert body["filed"] == [] and repo.writes == []
    assert body["rulesConsidered"] == 3


# --- [A18]-[A20] the taxonomy coupling ------------------------------------------------------


def test_an_empty_taxonomy_skips_every_rule_but_still_honours_an_income_rule(
        handler, monkeypatch):
    # [A18] A brand-new user with no categories yet: every normal rule's target is "unfiled" by
    # the badge's own predicate, so it is skipped and nothing is written — filing to a
    # non-existent category would leave the charge unfiled and the next run would re-file it
    # forever. `income` is the one target that is filed WITHOUT being a taxonomy id.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "shop", description="COLES", category=None),
        _row(SPENDING, "2026-07-01", "pay", description="ACME SALARY", category=None),
    ]})
    rules = [_rule("coles", "groceries", rule_id="r-shop"),
             _rule("salary", "income", rule_id="r-pay")]

    _, body = _call(handler, monkeypatch, repo, rules, {"dryRun": False}, categories=())

    assert [entry["reason"] for entry in body["skippedRules"]] == ["category no longer exists"]
    assert body["skippedRules"][0]["id"] == "r-shop"
    assert body["filed"] == [{"id": "pay", "category": "income"}]
    assert [write[1] for write in repo.writes] == ["TXN#pay"]


def test_a_rule_targeting_a_category_id_that_differs_only_by_case_is_skipped(
        handler, monkeypatch):
    # [A19] Category ids are compared EXACTLY. "Groceries" is not "groceries", so the rule is
    # skipped rather than filing charges to an id the taxonomy does not contain — which would
    # leave them unfiled forever.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="COLES", category=None)]})

    _, body = _call(handler, monkeypatch, repo, [_rule("coles", "Groceries")],
                    {"dryRun": False}, categories=("groceries",))

    assert body["skippedRules"][0]["reason"] == "category no longer exists"
    assert repo.writes == []


def test_deleting_the_targeted_category_between_runs_neither_writes_nor_loops(
        handler, monkeypatch):
    # [A20] Safe-to-run-twice under a CHANGING taxonomy. Run 1 files t1 -> groceries. The user
    # then deletes "groceries". Run 2 sees t1 as unfiled again (its category is now a dangling
    # id) but the rule is now skipped, so nothing is re-written and nothing loops.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="COLES", category=None)]})

    _, first = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False},
                     categories=("groceries",))
    assert first["filed"] == [{"id": "t1", "category": "groceries"}]

    _, second = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False},
                      categories=("coffee",))

    assert second["unfiled"] == 1           # the row reads as unfiled again...
    assert second["matched"] == 0           # ...but the rule can no longer file it
    assert second["filed"] == [] and second["remaining"] == 0
    assert len(repo.writes) == 1            # no second write


# --- [A21]-[A25] body parsing on this route -------------------------------------------------


def test_a_base64_encoded_gateway_body_is_honoured(handler, monkeypatch):
    # [A21] API Gateway may deliver the body base64-encoded. If this route stopped decoding it,
    # every write request would 400 — and the preview default makes that failure look benign.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="COLES", category=None)]})
    encoded = base64.b64encode(json.dumps({"dryRun": False}).encode()).decode()

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], None,
                    raw=encoded, base64_encoded=True)

    assert body["dryRun"] is False
    assert body["filed"] == [{"id": "t1", "category": "groceries"}]


def test_a_malformed_base64_body_is_a_400_and_writes_nothing(handler, monkeypatch):
    # [A22] A binary/garbage base64 payload must 400, not 500 and not fall through to a write.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="COLES", category=None)]})

    resp, _ = _call(handler, monkeypatch, repo, [_rule("coles")], None,
                    raw="!!!not-base64!!!", base64_encoded=True)

    assert resp["statusCode"] == 400
    assert repo.writes == []


@pytest.mark.parametrize("raw", ['[{"dryRun": false}]', '"dryRun"', "42", "true", "{not json"])
def test_a_non_object_or_garbage_body_is_a_400_and_writes_nothing(handler, monkeypatch, raw):
    # [A23] A JSON ARRAY is the one that matters: `body.get("dryRun", True)` would raise
    # AttributeError (a 500) if the object check were dropped, and a 500 tells the user
    # nothing about whether anything was written.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="COLES", category=None)]})

    resp, _ = _call(handler, monkeypatch, repo, [_rule("coles")], None, raw=raw)

    assert resp["statusCode"] == 400
    assert repo.writes == []


def test_unknown_extra_body_keys_are_ignored_and_do_not_narrow_the_run(handler, monkeypatch):
    # [A24] There is no `limit`/`categoryId`/`ruleId` knob: a client sending one gets a FULL
    # run, not a filtered one. Pinned so nobody assumes the endpoint honours a scope it doesn't.
    repo = WritableFeedRepo({SPENDING: _coles_rows(SPENDING, 4)})

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")],
                    {"dryRun": False, "limit": 1, "ruleId": "r-other", "categoryId": "coffee"})

    assert len(body["filed"]) == 4
    assert {entry["category"] for entry in body["filed"]} == {"groceries"}


def test_an_empty_json_object_body_previews_rather_than_writing(handler, monkeypatch):
    # [A25] Boundary next to the impl suite's missing-body 400: `{}` is a VALID object, so it is
    # accepted and previews (dryRun defaults to True). Missing body -> 400; `{}` -> preview.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", "t1", description="COLES", category=None)]})

    resp, body = _call(handler, monkeypatch, repo, [_rule("coles")], None, raw="{}")

    assert resp["statusCode"] == 200 and body["dryRun"] is True
    assert repo.writes == []


# --- [A40] parity with the badge ------------------------------------------------------------


def test_the_previews_unfiled_total_equals_the_badge_count_endpoint(handler, monkeypatch):
    # [A40] The acceptance criterion "the unfiled set matches the badge's rule", asserted
    # against the REAL count endpoint on the same rows and taxonomy — not a re-implementation.
    # The mix deliberately includes an income row, a raw-enum row, an excluded transfer, and a
    # null-category row, which is exactly where a divergent predicate would show up.
    rows = {
        ANZ: [
            _row(ANZ, "2026-07-05", "null", description="COLES", category=None),
            _row(ANZ, "2026-07-04", "raw", description="BP", category="TRANSPORT"),
            _row(ANZ, "2026-07-03", "filed", description="ALDI", category="groceries"),
            _row(ANZ, "2026-07-02", "pay", description="ACME SALARY", category="income"),
        ],
        SPENDING: [
            _row(SPENDING, "2026-07-01", "transfer", description="TRANSFER OUT",
                 category=None, counts_to_budget=False, budget_excluded=True),
        ],
    }
    taxonomy = {"groceries", "coffee"}

    count_resp = handler.get_uncategorized_count(WritableFeedRepo(rows), _CategoryRepo(taxonomy))
    badge_count = json.loads(count_resp["body"])["count"]

    _, body = _call(handler, monkeypatch, WritableFeedRepo(rows), [_rule("zzz-matches-nothing")], {},
                    categories=tuple(taxonomy))

    assert body["unfiled"] == badge_count
    assert badge_count == 3                 # null + raw enum + excluded transfer; income is filed


# --- [A30]-[A36] matcher edges (pure logic) -------------------------------------------------


def _is_unfiled(taxonomy):
    return lambda category: category != "income" and category not in taxonomy


def _txn(transaction_id, description="COLES 1234", category=None):
    return {"transaction_id": transaction_id, "description": description, "category": category,
            "pk": "ACCOUNT#a1", "sk": f"TXN#{transaction_id}"}


def test_two_rules_with_the_same_category_file_once_but_are_counted_by_each(rule_apply):
    # [A30] Not a conflict (the categories agree), so the charge is filed ONCE — but byRule
    # credits BOTH rules with the hit. That overlap is deliberate: byRule is a per-rule
    # "how over-eager is this rule?" signal, never a total.
    rules = [_rule("coles", "groceries", rule_id="r-a"),
             _rule("1234", "groceries", rule_id="r-b")]
    plan = rule_apply.plan_rule_application(rules, [_txn("t1")], _is_unfiled({"groceries"}))

    assert len(plan["matched"]) == 1
    assert plan["by_category"] == {"groceries": 1}
    assert {entry["ruleId"]: entry["count"] for entry in plan["by_rule"]} == {"r-a": 1, "r-b": 1}
    assert sum(entry["count"] for entry in plan["by_rule"]) == 2      # > matched, by design


@pytest.mark.parametrize("value,description,expected", [
    (1234, "COLES 1234", True),          # an int rule value is stringified, not crashed on
    (1234, "COLES 9999", False),
    (0, "PAYMENT 0", False),             # 0 is falsy -> treated as an empty value, matches nothing
    (None, "ANYTHING", False),
    (False, "FALSE ALARM", False),
])
def test_a_non_string_rule_value_is_stringified_and_never_crashes(
        rule_apply, value, description, expected):
    # [A31] `value` reaches us from BankSync, not from our own client, so it is not guaranteed
    # to be a string. It must never raise — an exception here would 500 the whole run.
    assert rule_apply.rule_matches(_rule(value), _txn("t1", description)) is expected


@pytest.mark.parametrize("description,expected", [
    (12345, True),                       # a numeric description is stringified
    (None, False),
    ("", False),
    (0, False),
])
def test_a_non_string_transaction_description_never_crashes(rule_apply, description, expected):
    # [A32] Same for the stored row: a description that is not a string must not 500 the run.
    assert rule_apply.rule_matches(_rule("1234"), _txn("t1", description)) is expected


def test_matching_is_case_insensitive_across_accents_but_never_folds_them(rule_apply):
    # [A33] Real descriptions carry accents (CAFÉ, NOËL). Lower-casing handles the CASE, but
    # nothing strips the accent — so a rule typed without the accent does NOT match. Pinned
    # because "why doesn't my CAFE rule match CAFÉ?" is otherwise an invisible behaviour.
    assert rule_apply.rule_matches(_rule("café"), _txn("t1", "CAFÉ DE PARIS"))
    assert rule_apply.rule_matches(_rule("CAFÉ"), _txn("t2", "café de paris"))
    assert not rule_apply.rule_matches(_rule("cafe"), _txn("t3", "CAFÉ DE PARIS"))
    assert not rule_apply.rule_matches(_rule("café"), _txn("t4", "CAFE DE PARIS"))


def test_a_rule_with_no_category_id_is_skipped_rather_than_crashing_the_run(rule_apply):
    # [A34] A rule missing `categoryId` entirely (a hand-made or half-migrated BankSync rule).
    # _skip_reason must catch it BEFORE the planner reaches rule["categoryId"] — that subscript
    # would raise KeyError and 500 the whole run, taking every other rule with it. The reason
    # names the real problem rather than blaming a deleted category.
    rule = {"id": "no-cat", "field": "description", "operator": "contains", "value": "coles"}
    plan = rule_apply.plan_rule_application([rule], [_txn("t1")], _is_unfiled({"groceries"}))

    assert plan["matched"] == []
    assert plan["skipped_rules"] == [
        {"id": "no-cat", "value": "coles", "reason": "rule has no category"}]


def test_category_equals_does_not_match_a_prefix_of_the_stored_category(rule_apply):
    # [A35] `equals` is not `contains`: a FOOD rule must not sweep up every FOOD_AND_DRINK
    # charge.
    rule = _rule("FOOD", field="category", operator="equals")
    assert not rule_apply.rule_matches(rule, _txn("t1", category="FOOD_AND_DRINK"))
    assert rule_apply.rule_matches(_rule("FOOD_AND_DRINK", field="category", operator="equals"),
                                   _txn("t2", category="FOOD_AND_DRINK"))


def test_a_charge_whose_category_is_an_empty_string_is_eligible_and_filable(rule_apply):
    # [A36] "" is neither income nor a taxonomy id, so the badge counts it — the apply pass must
    # be able to file it too, or those rows are permanently stuck.
    plan = rule_apply.plan_rule_application(
        [_rule("coles")], [_txn("t1", "COLES", category="")], _is_unfiled({"groceries"}))

    assert plan["unfiled"] == 1
    assert [t["transaction_id"] for t, _ in plan["matched"]] == ["t1"]


# --- [A44]-[A46] WHIT-508: the taxonomy edge, and proof the loop ENDS -------------------
# The app turns `remaining + failed` into "still to go" and offers "Apply the rest" again, so a row
# that keeps landing in `failed` is a button the user can tap forever. These pin the two ways a
# lost race resolves: filed rows leave the set for good, and unfiled ones converge on the next run.


def test_a_charge_that_became_income_mid_run_is_already_filed_not_retried_forever(
        handler, monkeypatch):
    # [A44] `income` is the one category that counts as FILED without being a taxonomy id
    # (_is_unmapped_category). A settlement or a tap that lands it on income leaves nothing to
    # retry. Classify it as unfiled instead and the write is refused every round while the app
    # keeps offering "Apply the rest" — an endless loop over one charge.
    # FAIL-ON-REVERT: swap `is_unfiled(current_category)` for `current_category not in taxonomy`
    # and this row moves to `failed` -> red.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1", category=None),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2", category=None),
    ]})
    repo.refile_hook = lambda transaction_id, r: (
        r.set_category("t2", "income") if transaction_id == "t1" else None)

    _, body = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert body["alreadyFiled"] == ["t2"]
    assert body["failed"] == []
    assert body["remaining"] == 0                       # nothing to come back for
    assert repo._find_row(f"ACCOUNT#{SPENDING}", "TXN#t2")["category"] == "income"



def test_a_row_that_changed_into_a_raw_label_is_retried_against_the_NEW_value(
        handler, monkeypatch):
    # [A46] The other half of termination. A row that changed into something still unfiled (a
    # re-sync carrying the bank's own label back on) lands in `failed`, so the app offers another
    # round — and that round must actually be able to win, or the retry is a lie. The second run
    # re-scans, so it compares against the label the row holds NOW.
    # FAIL-ON-REVERT: cache/reuse the first scan's expected value (or pass the rule's target) and
    # the second round is refused too -> red.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1", category=None),
        _row(SPENDING, "2026-07-01", "t2", description="COLES 2", category=None),
    ]})
    repo.refile_hook = lambda transaction_id, r: (
        r.set_category("t2", "TRANSFER_OUT") if transaction_id == "t1" else None)

    _, first = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})
    assert first["failed"] == ["t2"]

    repo.refile_hook = None
    _, second = _call(handler, monkeypatch, repo, [_rule("coles")], {"dryRun": False})

    assert second["filed"] == [{"id": "t2", "category": "groceries"}]
    assert second["failed"] == [] and second["remaining"] == 0
    # The expected value is the label the scan saw THIS time, not the None the first scan saw.
    assert repo.writes[-1] == (f"ACCOUNT#{SPENDING}", "TXN#t2", "groceries", "TRANSFER_OUT")
