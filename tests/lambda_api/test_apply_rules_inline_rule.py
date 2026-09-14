"""Tests for the optional inline `rule` on POST /transactions/uncategorized/apply-rules
(WHIT-516) — "make a rule for this shop AND file the charges it already has", in one request.

Established by WHIT-502: making a rule does NOT touch charges already stored; rules only run
when new data arrives. So minting a rule for COLES on its own leaves all 38 existing COLES
charges exactly where they were. This closes that in one request, so there is no window where
the rule exists and the charges are untouched.

The rule minted here outlives the request and files in bulk, so it is fenced hard: the same
letters/digits floor the merchant screen offers groups by, a category the user actually has, and
`description contains` only — a supplied field/operator is rejected, never quietly narrowed.

Drives a FakeRuleRepo as the handler's rule store (WHIT-531 moved the mint + clash check off
BankSync into our own RuleRepository). Its ids come from rule_engine.rule_id_for, so the tests
assert relationally (createdRule is the minted/existing row) rather than on a hand-picked id.
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _store_row(rule):
    """A camelCase existing-rule dict -> the snake_case store row FakeRuleRepo holds. Keeps an
    explicit `id` (clash tests assert existingRule.id); with id absent, FakeRuleRepo computes the
    real rule_id_for id so create_rule's dedup matches an inline mint of the same text."""
    return {"id": rule.get("id"), "field": rule["field"], "operator": rule["operator"],
            "value": rule["value"], "category_id": rule["categoryId"]}


def _minted(rule_repo):
    """create_rule's writes as (field, operator, value, category_id) tuples, for order-free
    equality against what the inline mint asked for."""
    return [(r["field"], r["operator"], r["value"], r["category_id"]) for r in rule_repo.minted]


def _event(body):
    return {
        "rawPath": "/transactions/uncategorized/apply-rules",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps(body),
    }


def _call(handler, repo, body, existing=(), categories=frozenset({"groceries", "petrol"}),
          rule_repo=None):
    if rule_repo is None:
        rule_repo = FakeRuleRepo(rules=[_store_row(r) for r in existing])
    resp = handler.apply_rules_to_uncategorized(
        _event(body), repo, FakeCategoryRepo(categories), rule_repo)
    return resp, json.loads(resp["body"]), rule_repo


def _coles_repo():
    return WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342 RICHMOND", category=None),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE", category=None),
        _row(SPENDING, "2026-07-01", "t3", description="NETFLIX.COM", category=None),
    ]})


# --- the point of the card ---------------------------------------------------


def test_one_request_mints_the_rule_and_files_the_charges_it_already_has(handler):
    # FAIL-ON-REVERT for the whole card. Making the rule alone leaves every stored charge
    # unfiled (WHIT-502), which is the problem — so both must happen, in one request.
    repo = _coles_repo()
    resp, body, rule_repo = _call(
        handler, repo, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert resp["statusCode"] == 200
    assert _minted(rule_repo) == [("description", "contains", "COLES", "groceries")]
    assert body["createdRule"]["id"] == rule_repo.minted[0]["id"]   # the rule we just minted
    assert body["createdRule"]["categoryId"] == "groceries"        # mapped to client shape
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]  # never NETFLIX
    assert [(pk, sk, category) for pk, sk, category, _ in repo.writes] == [
        (f"ACCOUNT#{SPENDING}", "TXN#t1", "groceries"),
        (f"ACCOUNT#{SPENDING}", "TXN#t2", "groceries"),
    ]


def test_the_minted_inline_rule_stamps_the_charges_it_files(handler):
    # WHIT-536: the plan is computed BEFORE the inline rule is minted, so its plan-time id is
    # None; the filed rows must carry the freshly-created rule's real id, not None.
    repo = _coles_repo()
    _resp, _body, rule_repo = _call(
        handler, repo, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}})
    minted_id = rule_repo.minted[0]["id"]
    assert minted_id
    for txn_id in ("t1", "t2"):
        assert repo._find_row(f"ACCOUNT#{SPENDING}", f"TXN#{txn_id}")["filed_by_rule"] == minted_id


def test_a_preview_shows_the_numbers_without_minting_anything(handler):
    # FAIL-ON-REVERT. The screen shows what would happen BEFORE she commits, so a preview must
    # not leave a rule behind — a rule she never confirmed would go on filing every future charge
    # from that shop.
    repo = _coles_repo()
    resp, body, rule_repo = _call(
        handler, repo, {"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert body["dryRun"] is True
    assert body["matched"] == 2       # the preview still counts what it WOULD file
    assert body["createdRule"] is None
    assert rule_repo.minted == []
    assert repo.writes == []


def test_the_inline_rule_files_only_its_own_shop_not_her_other_rules(handler):
    # FAIL-ON-REVERT for the whole card (WHIT-523). She taps "file COLES"; her BP charge, which
    # a DIFFERENT rule of hers covers, must be left alone. The sweep runs the inline rule ONLY,
    # so only the COLES charge files — the BP rule is read (for the clash check) but not swept.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 0342", category=None),
        _row(SPENDING, "2026-07-01", "t2", description="BP 2210 SERVO", category=None),
    ]})
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "BP 2210",
                 "categoryId": "petrol"}]

    _, body, _ = _call(handler, repo,
                       {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
                       existing=existing)

    assert body["byCategory"] == {"groceries": 1}          # never petrol
    assert body["filed"] == [{"id": "t1", "category": "groceries"}]  # BP charge left unfiled
    assert body["rulesConsidered"] == 1                    # only the inline rule was swept
    assert [entry["ruleId"] for entry in body["byRule"]] == [None]


def test_no_inline_rule_behaves_exactly_as_before(handler):
    # FAIL-ON-REVERT for the plain "Apply my rules" path: an absent `rule` must mint nothing.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "groceries"}]

    _, body, rule_repo = _call(handler, repo, {"dryRun": False}, existing=existing)

    assert rule_repo.minted == []
    assert body["createdRule"] is None
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_the_rule_is_minted_before_the_sweep(handler):
    # Order matters for the failure mode. A rule that exists with its charges not yet filed is
    # simply today's state — tapping again finishes it. Filing first and then failing to mint
    # would leave the charges filed with nothing to catch the next one.
    order = []
    repo = _coles_repo()

    class _OrderRuleRepo(FakeRuleRepo):
        def create_rule(self, *args, **kwargs):
            order.append("mint")
            return super().create_rule(*args, **kwargs)

    repo.refile_hook = lambda transaction_id, _repo: order.append(f"write:{transaction_id}")

    _call(handler, repo,
          {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
          rule_repo=_OrderRuleRepo())

    assert order == ["mint", "write:t1", "write:t2"]


def test_a_failure_to_mint_writes_nothing(handler):
    # FAIL-ON-REVERT. If the rule can't be saved, the sweep must not run: filing the charges with
    # no rule behind them silently loses the "and catch future ones" half she asked for.
    # WHIT-531: the mint is our store now, so a write failure is a DatabaseError -> 500 (our
    # server), not the old BankSync 502. A bare-500 vs 502 detail no longer applies.
    repo = _coles_repo()
    resp, _, _ = _call(handler, repo,
                       {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
                       rule_repo=FakeRuleRepo(create_error=True))

    assert resp["statusCode"] == 500
    assert repo.writes == []


def test_a_rule_that_clashes_only_at_mint_time_returns_409_not_500(handler):
    # The pre-scan clash check read the rules list once; a concurrent request then created a
    # same-text, different-category rule before our mint. create_rule raises RuleClashError, and
    # the mint path must turn that into a 409 with the winning rule — never let it escape as a 500.
    repo = _coles_repo()

    class _RacingRuleRepo(FakeRuleRepo):
        def create_rule(self, *args, **kwargs):
            from repository import RuleClashError
            raise RuleClashError({"id": "raced", "field": "description", "operator": "contains",
                                  "value": "COLES", "category_id": "petrol"})

    resp, body, _ = _call(handler, repo,
                          {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
                          rule_repo=_RacingRuleRepo())

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == "raced"
    assert body["existingRule"]["categoryId"] == "petrol"   # mapped from the store's category_id
    assert repo.writes == []


# --- the fences --------------------------------------------------------------


@pytest.mark.parametrize("value", ["BP", "7-11", "A&B*", "   ", "  BP  "])
def test_a_rule_value_too_short_to_be_safe_is_rejected(handler, value):
    # FAIL-ON-REVERT for the floor, and it must count LETTERS AND DIGITS, not characters:
    # "7-11" and "A&B*" are four characters long. A rule on "BP" files every BPAY transfer as
    # petrol, permanently — so this is a 400, not a silent skip.
    repo = _coles_repo()
    resp, body, rule_repo = _call(handler, repo,
                                  {"dryRun": False, "rule": {"value": value,
                                                             "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert "letters or digits" in body["error"]
    assert rule_repo.minted == [] and repo.writes == []


def test_a_group_the_merchant_screen_offers_files_exactly_what_it_promised(handler):
    # FAIL-ON-REVERT for the seam between the two halves, and the contract that matters: the
    # count on the screen is the number that gets filed. A round trip, not an identity check —
    # asserting the two modules share a function proves only that nobody hand-copied it, and
    # says nothing about the OTHER fences, which can refuse a group just as easily.
    #
    # "7-ELEVEN" is deliberate: it clears the letters/digits floor while "7-11" would not, so a
    # floor that counted characters on one side and alphanumerics on the other reddens here.
    import merchant_groups

    rows = [
        _row(SPENDING, "2026-07-03", "t1", merchant_name="7-ELEVEN",
             description="7-ELEVEN 2210 KEW", category=None),
        _row(SPENDING, "2026-07-02", "t2", merchant_name="7-ELEVEN",
             description="7-ELEVEN 0199 CBD", category=None),
        _row(SPENDING, "2026-07-01", "t3", merchant_name="NETFLIX",
             description="NETFLIX.COM", category=None),
    ]
    offered = merchant_groups.group_unfiled_by_merchant(
        rows, lambda category: category != "income" and category not in {"groceries", "petrol"})
    group = next(g for g in offered["groups"] if g["merchant"] == "7-ELEVEN")

    resp, body, _ = _call(
        handler, WritableFeedRepo({SPENDING: rows}),
        {"dryRun": False, "rule": {"value": group["rulePattern"], "categoryId": "petrol"}})

    assert resp["statusCode"] == 200          # never a fence refusing what the screen offered
    assert len(body["filed"]) == group["count"]


@pytest.mark.parametrize("category_id", ["not-a-category", "", None, 7, "GROCERIES"])
def test_a_category_she_does_not_have_is_rejected(handler, category_id):
    # FAIL-ON-REVERT. Filing to a category that isn't hers leaves every charge STILL unfiled by
    # the badge's own rule, so the next run would file them again — forever. rule_engine would
    # skip such a rule silently; here she gets told.
    repo = _coles_repo()
    resp, body, rule_repo = _call(handler, repo,
                                  {"dryRun": False, "rule": {"value": "COLES",
                                                             "categoryId": category_id}})

    assert resp["statusCode"] == 400
    assert "categoryId" in body["error"]
    assert rule_repo.minted == [] and repo.writes == []


@pytest.mark.parametrize("extra", [{"operator": "equals"}, {"field": "category"},
                                   {"field": "description", "operator": "contains"}])
def test_a_supplied_field_or_operator_is_rejected_not_ignored(handler, extra):
    # FAIL-ON-REVERT. This route mints "description contains" only. Quietly ignoring a supplied
    # "equals" would file a completely different set of charges than the caller asked for, and
    # nothing would say so — even the harmless-looking explicit defaults are refused, so the
    # contract is one thing rather than two.
    repo = _coles_repo()
    rule = {"value": "COLES", "categoryId": "groceries", **extra}
    resp, body, rule_repo = _call(handler, repo, {"dryRun": False, "rule": rule})

    assert resp["statusCode"] == 400
    assert "field/operator" in body["error"]
    assert rule_repo.minted == [] and repo.writes == []


def test_a_rule_already_sending_that_shop_elsewhere_is_refused(handler):
    # FAIL-ON-REVERT. Without this the route mints a SECOND rule for the same text pointing at a
    # different category, files nothing (the two disagree, so every charge is conflicted and
    # conflicted charges are never filed, now or ever), and returns 200 — she sees "done", the
    # charges are untouched, and she is left with a permanent contradiction she can't see.
    #
    # The realistic way in: a rule written months ago never touched her stored charges
    # (WHIT-502), so that shop is still on the merchant screen with its charges unfiled.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "petrol"}]

    resp, body, rule_repo = _call(handler, repo,
                                  {"dryRun": False, "rule": {"value": "COLES",
                                                             "categoryId": "groceries"}},
                                  existing=existing)

    assert resp["statusCode"] == 409
    assert "petrol" in body["error"]              # names where the existing rule sends them
    assert body["existingRule"]["id"] == "r1"     # so the app can offer to edit that one
    assert rule_repo.minted == [] and repo.writes == []


def test_the_clash_check_ignores_case_and_spacing(handler):
    # Rules are matched on the same folded identity the store's dedup uses, so " coles " and
    # "COLES" are the same rule. Comparing raw text would let the clash slip straight through.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": " coles ",
                 "categoryId": "petrol"}]

    resp, _, rule_repo = _call(handler, repo,
                               {"dryRun": False, "rule": {"value": "COLES",
                                                          "categoryId": "groceries"}},
                               existing=existing)

    assert resp["statusCode"] == 409
    assert rule_repo.minted == []


def test_an_existing_rule_to_the_SAME_category_is_not_a_clash(handler):
    # FAIL-ON-REVERT the other way. Refusing this would break the re-tap after a capped run —
    # the rule is already there by design, and the second tap has to finish the filing. Seeded
    # with no id so its store id matches an inline mint of the same text (create_rule dedups it).
    repo = _coles_repo()
    existing = [{"field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "groceries"}]

    resp, body, _ = _call(handler, repo,
                          {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
                          existing=existing)

    assert resp["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_a_rule_for_a_different_shop_is_not_a_clash(handler):
    # Only the SAME target text clashes. A rule for another shop filing elsewhere is normal —
    # refusing on category alone would make the screen unusable after the first few shops.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "NETFLIX",
                 "categoryId": "petrol"}]

    resp, body, rule_repo = _call(handler, repo,
                                  {"dryRun": False, "rule": {"value": "COLES",
                                                             "categoryId": "groceries"}},
                                  existing=existing)

    assert resp["statusCode"] == 200
    assert _minted(rule_repo) == [("description", "contains", "COLES", "groceries")]
    # A different shop's rule is no clash, so the COLES rule is minted and swept — but ONLY it
    # (WHIT-523). The NETFLIX charge (t3) her existing rule covers is left unfiled; filing COLES
    # files just COLES.
    assert sorted((filed["id"], filed["category"]) for filed in body["filed"]) == [
        ("t1", "groceries"), ("t2", "groceries"),
    ]


def test_a_same_category_unrelated_rule_still_files_only_this_shop(handler):
    # FAIL-ON-REVERT, and the case the clash guard can't catch: an existing NETFLIX rule filing
    # to the SAME category (groceries) as the inline COLES rule does NOT clash (they agree), so
    # nothing refuses it. The scope must still hold — the NETFLIX charge stays unfiled, because
    # only the inline rule is swept, not "every rule that happens to agree on category".
    repo = _coles_repo()  # t1/t2 COLES, t3 NETFLIX.COM
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "NETFLIX",
                 "categoryId": "groceries"}]

    resp, body, _ = _call(handler, repo,
                          {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
                          existing=existing)

    assert resp["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]  # never t3 (NETFLIX)
    assert body["rulesConsidered"] == 1


def test_a_preview_reports_the_clash_too(handler):
    # She should learn about it from the preview, before committing — not after tapping through.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "petrol"}]

    resp, _, _ = _call(handler, repo,
                       {"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}},
                       existing=existing)

    assert resp["statusCode"] == 409
    assert repo.writes == []


@pytest.mark.parametrize("rule", ["COLES", ["COLES"], 7, True])
def test_a_rule_that_is_not_an_object_is_rejected(handler, rule):
    repo = _coles_repo()
    resp, body, rule_repo = _call(handler, repo, {"dryRun": False, "rule": rule})

    assert resp["statusCode"] == 400
    assert rule_repo.minted == [] and repo.writes == []


@pytest.mark.parametrize("value", [None, 7, ["COLES"], {"v": 1}])
def test_a_rule_value_that_is_not_a_string_is_rejected(handler, value):
    repo = _coles_repo()
    resp, _, rule_repo = _call(handler, repo,
                               {"dryRun": False, "rule": {"value": value,
                                                          "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert rule_repo.minted == [] and repo.writes == []


def test_the_fences_are_checked_before_the_history_scan(handler):
    # A rejected rule must cost nothing. Scanning all history first and then 400ing would make a
    # typo as expensive as a real run.
    class _ExplodingRepo:
        def get_transactions_by_date_range(self, *args, **kwargs):
            raise AssertionError("history must not be scanned for a rejected rule")

    resp, _, rule_repo = _call(handler, _ExplodingRepo(),
                               {"dryRun": False, "rule": {"value": "BP",
                                                          "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert rule_repo.minted == []


# --- interaction with what already exists ------------------------------------


def test_a_hand_filed_charge_still_beats_the_new_rule(handler):
    # FAIL-ON-REVERT for WHIT-508 surviving this path. She taps a category on a charge while the
    # sweep is running; the conditional write must leave her choice alone and report it, not
    # overwrite it with the rule's category.
    repo = _coles_repo()
    repo.refile_hook = lambda transaction_id, r: (
        r.set_category("t2", "petrol") if transaction_id == "t1" else None)

    _, body, _ = _call(handler, repo,
                       {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert [filed["id"] for filed in body["filed"]] == ["t1"]
    assert body["alreadyFiled"] == ["t2"]


def test_the_handler_goes_through_create_rule_rather_than_posting_its_own(handler):
    # The app retries when a run reports `remaining`, and create_rule is what makes that safe:
    # it returns the rule already there instead of minting a second (WHIT-497). What THIS pins is
    # that the handler routes every mint through the store's create_rule, so it inherits that
    # dedup. Seeded with the SAME folded text ("coles"), so the inline "COLES" mint dedups onto it.
    existing = [{"field": "description", "operator": "contains", "value": "coles",
                 "categoryId": "groceries"}]

    _, body, rule_repo = _call(handler, _coles_repo(),
                               {"dryRun": False, "rule": {"value": "COLES",
                                                          "categoryId": "groceries"}},
                               existing=existing)

    assert rule_repo.minted == []                    # dedup: no second row minted
    assert body["createdRule"]["value"] == "coles"   # returned the EXISTING rule, not a new "COLES"


def test_a_capped_run_leaves_the_rule_in_place_so_tapping_again_finishes(handler, monkeypatch):
    # FAIL-ON-REVERT for the state the app actually hits on a big history: the write cap stops
    # the sweep partway, `remaining` says so, and the app taps again. The rule must already
    # exist at that point — otherwise the second tap mints a duplicate, and the charges filed by
    # the first tap have nothing behind them if she stops there.
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 1)
    repo = _coles_repo()

    _, body, rule_repo = _call(handler, repo,
                               {"dryRun": False, "rule": {"value": "COLES",
                                                          "categoryId": "groceries"}})

    assert len(body["filed"]) == 1
    assert body["remaining"] == 1
    assert body["createdRule"]["id"] == rule_repo.minted[0]["id"]
    assert _minted(rule_repo) == [("description", "contains", "COLES", "groceries")]


def test_the_route_carries_the_inline_rule_through(handler, monkeypatch):
    repo = _coles_repo()
    rule_repo = FakeRuleRepo()
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo({"groceries"}))

    resp = handler.lambda_handler(
        _event({"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}}), None)

    assert resp["statusCode"] == 200
    assert _minted(rule_repo) == [("description", "contains", "COLES", "groceries")]
    assert sorted(filed["id"] for filed in json.loads(resp["body"])["filed"]) == ["t1", "t2"]
