"""Tests for the optional inline `rule` on POST /transactions/uncategorized/apply-rules
(WHIT-516) — "make a rule for this shop AND file the charges it already has", in one request.

Established by WHIT-502: making a rule does NOT touch charges already stored; rules only run
when new data arrives. So minting a rule for COLES on its own leaves all 38 existing COLES
charges exactly where they were. This closes that in one request, so there is no window where
the rule exists and the charges are untouched.

The rule minted here outlives the request and files in bulk, so it is fenced hard: the same
letters/digits floor the merchant screen offers groups by, a category the user actually has, and
`description contains` only — a supplied field/operator is rejected, never quietly narrowed.

Fakes `list_rules`/`create_rule` at the handler boundary, like test_apply_rules.py — the BankSync
HTTP plumbing has its own suite (test_enrichments.py).
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, _row, WritableFeedRepo, FakeCategoryRepo


class _RecordingBankSync:
    """Records what create_rule was asked to mint, and hands back a rule with an id."""

    def __init__(self, existing=()):
        self.existing = list(existing)
        self.minted = []

    def list_rules(self):
        return list(self.existing)

    def create_rule(self, field, operator, value, category_id):
        self.minted.append((field, operator, value, category_id))
        return {"id": "enr_new", "field": field, "operator": operator, "value": value,
                "categoryId": category_id, "conditionCount": 1}


def _event(body):
    return {
        "rawPath": "/transactions/uncategorized/apply-rules",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps(body),
    }


def _call(handler, monkeypatch, repo, body, banksync=None,
          categories=frozenset({"groceries", "petrol"})):
    banksync = banksync or _RecordingBankSync()
    monkeypatch.setattr(handler, "list_rules", banksync.list_rules)
    monkeypatch.setattr(handler, "create_rule", banksync.create_rule)
    resp = handler.apply_rules_to_uncategorized(
        _event(body), repo, FakeCategoryRepo(categories))
    return resp, json.loads(resp["body"]), banksync


def _coles_repo():
    return WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342 RICHMOND", category=None),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE", category=None),
        _row(SPENDING, "2026-07-01", "t3", description="NETFLIX.COM", category=None),
    ]})


# --- the point of the card ---------------------------------------------------


def test_one_request_mints_the_rule_and_files_the_charges_it_already_has(handler, monkeypatch):
    # FAIL-ON-REVERT for the whole card. Making the rule alone leaves every stored charge
    # unfiled (WHIT-502), which is the problem — so both must happen, in one request.
    repo = _coles_repo()
    resp, body, banksync = _call(
        handler, monkeypatch, repo, {"dryRun": False, "rule": {"value": "COLES",
                                                               "categoryId": "groceries"}})

    assert resp["statusCode"] == 200
    assert banksync.minted == [("description", "contains", "COLES", "groceries")]
    assert body["createdRule"]["id"] == "enr_new"
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]  # never NETFLIX
    assert [(pk, sk, category) for pk, sk, category, _ in repo.writes] == [
        (f"ACCOUNT#{SPENDING}", "TXN#t1", "groceries"),
        (f"ACCOUNT#{SPENDING}", "TXN#t2", "groceries"),
    ]


def test_a_preview_shows_the_numbers_without_minting_anything(handler, monkeypatch):
    # FAIL-ON-REVERT. The screen shows what would happen BEFORE she commits, so a preview must
    # not leave a rule behind in BankSync — a rule she never confirmed would go on filing every
    # future charge from that shop.
    repo = _coles_repo()
    resp, body, banksync = _call(
        handler, monkeypatch, repo, {"dryRun": True, "rule": {"value": "COLES",
                                                              "categoryId": "groceries"}})

    assert body["dryRun"] is True
    assert body["matched"] == 2       # the preview still counts what it WOULD file
    assert body["createdRule"] is None
    assert banksync.minted == []
    assert repo.writes == []


def test_the_inline_rule_files_only_its_own_shop_not_her_other_rules(handler, monkeypatch):
    # FAIL-ON-REVERT for the whole card (WHIT-523). She taps "file COLES"; her BP charge, which
    # a DIFFERENT rule of hers covers, must be left alone. The sweep runs the inline rule ONLY,
    # so only the COLES charge files — the BP rule is read (for the clash check) but not swept.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 0342", category=None),
        _row(SPENDING, "2026-07-01", "t2", description="BP 2210 SERVO", category=None),
    ]})
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "BP 2210",
                 "categoryId": "petrol", "conditionCount": 1}]

    _, body, _ = _call(handler, monkeypatch, repo,
                       {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
                       banksync=_RecordingBankSync(existing))

    assert body["byCategory"] == {"groceries": 1}          # never petrol
    assert body["filed"] == [{"id": "t1", "category": "groceries"}]  # BP charge left unfiled
    assert body["rulesConsidered"] == 1                    # only the inline rule was swept
    assert [entry["ruleId"] for entry in body["byRule"]] == [None]


def test_no_inline_rule_behaves_exactly_as_before(handler, monkeypatch):
    # FAIL-ON-REVERT for the plain "Apply my rules" path: an absent `rule` must mint nothing.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "groceries", "conditionCount": 1}]

    _, body, banksync = _call(handler, monkeypatch, repo, {"dryRun": False},
                              banksync=_RecordingBankSync(existing))

    assert banksync.minted == []
    assert body["createdRule"] is None
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_the_rule_is_minted_before_the_sweep(handler, monkeypatch):
    # Order matters for the failure mode. A rule that exists with its charges not yet filed is
    # simply today's state — tapping again finishes it. Filing first and then failing to mint
    # would leave the charges filed with nothing to catch the next one.
    order = []
    repo = _coles_repo()
    banksync = _RecordingBankSync()
    real_create = banksync.create_rule

    def _record_then_create(*args):
        order.append("mint")
        return real_create(*args)

    banksync.create_rule = _record_then_create
    repo.refile_hook = lambda transaction_id, _repo: order.append(f"write:{transaction_id}")

    _call(handler, monkeypatch, repo,
          {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
          banksync=banksync)

    assert order == ["mint", "write:t1", "write:t2"]


def test_a_failure_to_mint_writes_nothing(handler, monkeypatch):
    # FAIL-ON-REVERT. If BankSync refuses the rule, the sweep must not run: filing the charges
    # with no rule behind them silently loses the "and catch future ones" half she asked for.
    repo = _coles_repo()
    banksync = _RecordingBankSync()

    def _refuse(*args):
        raise handler.BankSyncError(503, "banksync down")

    banksync.create_rule = _refuse
    resp, body, _ = _call(handler, monkeypatch, repo,
                          {"dryRun": False, "rule": {"value": "COLES",
                                                     "categoryId": "groceries"}},
                          banksync=banksync)

    # Exactly 502 — a failure upstream, not ours. ">= 500" would stay green if this started
    # returning a bare 500, which reads to the app as "our bug, don't retry".
    assert resp["statusCode"] == 502
    assert repo.writes == []


# --- the fences --------------------------------------------------------------


@pytest.mark.parametrize("value", ["BP", "7-11", "A&B*", "   ", "  BP  "])
def test_a_rule_value_too_short_to_be_safe_is_rejected(handler, monkeypatch, value):
    # FAIL-ON-REVERT for the floor, and it must count LETTERS AND DIGITS, not characters:
    # "7-11" and "A&B*" are four characters long. A rule on "BP" files every BPAY transfer as
    # petrol, permanently — so this is a 400, not a silent skip.
    repo = _coles_repo()
    resp, body, banksync = _call(handler, monkeypatch, repo,
                                 {"dryRun": False, "rule": {"value": value,
                                                            "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert "letters or digits" in body["error"]
    assert banksync.minted == [] and repo.writes == []


def test_a_group_the_merchant_screen_offers_files_exactly_what_it_promised(handler, monkeypatch):
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
        handler, monkeypatch, WritableFeedRepo({SPENDING: rows}),
        {"dryRun": False, "rule": {"value": group["rulePattern"], "categoryId": "petrol"}})

    assert resp["statusCode"] == 200          # never a fence refusing what the screen offered
    assert len(body["filed"]) == group["count"]


@pytest.mark.parametrize("category_id", ["not-a-category", "", None, 7, "GROCERIES"])
def test_a_category_she_does_not_have_is_rejected(handler, monkeypatch, category_id):
    # FAIL-ON-REVERT. Filing to a category that isn't hers leaves every charge STILL unfiled by
    # the badge's own rule, so the next run would file them again — forever. rule_apply would
    # skip such a rule silently; here she gets told.
    repo = _coles_repo()
    resp, body, banksync = _call(handler, monkeypatch, repo,
                                 {"dryRun": False, "rule": {"value": "COLES",
                                                            "categoryId": category_id}})

    assert resp["statusCode"] == 400
    assert "categoryId" in body["error"]
    assert banksync.minted == [] and repo.writes == []


@pytest.mark.parametrize("extra", [{"operator": "equals"}, {"field": "category"},
                                   {"field": "description", "operator": "contains"}])
def test_a_supplied_field_or_operator_is_rejected_not_ignored(handler, monkeypatch, extra):
    # FAIL-ON-REVERT. This route mints "description contains" only. Quietly ignoring a supplied
    # "equals" would file a completely different set of charges than the caller asked for, and
    # nothing would say so — even the harmless-looking explicit defaults are refused, so the
    # contract is one thing rather than two.
    repo = _coles_repo()
    rule = {"value": "COLES", "categoryId": "groceries", **extra}
    resp, body, banksync = _call(handler, monkeypatch, repo, {"dryRun": False, "rule": rule})

    assert resp["statusCode"] == 400
    assert "field/operator" in body["error"]
    assert banksync.minted == [] and repo.writes == []


def test_a_rule_already_sending_that_shop_elsewhere_is_refused(handler, monkeypatch):
    # FAIL-ON-REVERT. Without this the route mints a SECOND rule for the same text pointing at a
    # different category, files nothing (the two disagree, so every charge is conflicted and
    # conflicted charges are never filed, now or ever), and returns 200 — she sees "done", the
    # charges are untouched, and she is left with a permanent contradiction she can't see.
    #
    # The realistic way in: a rule written months ago never touched her stored charges
    # (WHIT-502), so that shop is still on the merchant screen with its charges unfiled.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "petrol", "conditionCount": 1}]

    resp, body, banksync = _call(handler, monkeypatch, repo,
                                 {"dryRun": False, "rule": {"value": "COLES",
                                                            "categoryId": "groceries"}},
                                 banksync=_RecordingBankSync(existing))

    assert resp["statusCode"] == 409
    assert "petrol" in body["error"]              # names where the existing rule sends them
    assert body["existingRule"]["id"] == "r1"     # so the app can offer to edit that one
    assert banksync.minted == [] and repo.writes == []


def test_the_clash_check_ignores_case_and_spacing(handler, monkeypatch):
    # Rules are matched on the same folded identity BankSync's own dedup uses, so " coles " and
    # "COLES" are the same rule. Comparing raw text would let the clash slip straight through.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": " coles ",
                 "categoryId": "petrol", "conditionCount": 1}]

    resp, _, banksync = _call(handler, monkeypatch, repo,
                              {"dryRun": False, "rule": {"value": "COLES",
                                                         "categoryId": "groceries"}},
                              banksync=_RecordingBankSync(existing))

    assert resp["statusCode"] == 409
    assert banksync.minted == []


def test_an_existing_rule_to_the_SAME_category_is_not_a_clash(handler, monkeypatch):
    # FAIL-ON-REVERT the other way. Refusing this would break the re-tap after a capped run —
    # the rule is already there by design, and the second tap has to finish the filing.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "groceries", "conditionCount": 1}]

    resp, body, _ = _call(handler, monkeypatch, repo,
                          {"dryRun": False, "rule": {"value": "COLES",
                                                     "categoryId": "groceries"}},
                          banksync=_RecordingBankSync(existing))

    assert resp["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_a_rule_for_a_different_shop_is_not_a_clash(handler, monkeypatch):
    # Only the SAME target text clashes. A rule for another shop filing elsewhere is normal —
    # refusing on category alone would make the screen unusable after the first few shops.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "NETFLIX",
                 "categoryId": "petrol", "conditionCount": 1}]

    resp, body, banksync = _call(handler, monkeypatch, repo,
                                 {"dryRun": False, "rule": {"value": "COLES",
                                                            "categoryId": "groceries"}},
                                 banksync=_RecordingBankSync(existing))

    assert resp["statusCode"] == 200
    assert banksync.minted == [("description", "contains", "COLES", "groceries")]
    # A different shop's rule is no clash, so the COLES rule is minted and swept — but ONLY it
    # (WHIT-523). The NETFLIX charge (t3) her existing rule covers is left unfiled; filing COLES
    # files just COLES.
    assert sorted((filed["id"], filed["category"]) for filed in body["filed"]) == [
        ("t1", "groceries"), ("t2", "groceries"),
    ]


def test_a_same_category_unrelated_rule_still_files_only_this_shop(handler, monkeypatch):
    # FAIL-ON-REVERT, and the case the clash guard can't catch: an existing NETFLIX rule filing
    # to the SAME category (groceries) as the inline COLES rule does NOT clash (they agree), so
    # nothing refuses it. The scope must still hold — the NETFLIX charge stays unfiled, because
    # only the inline rule is swept, not "every rule that happens to agree on category".
    repo = _coles_repo()  # t1/t2 COLES, t3 NETFLIX.COM
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "NETFLIX",
                 "categoryId": "groceries", "conditionCount": 1}]

    resp, body, banksync = _call(handler, monkeypatch, repo,
                                 {"dryRun": False, "rule": {"value": "COLES",
                                                            "categoryId": "groceries"}},
                                 banksync=_RecordingBankSync(existing))

    assert resp["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]  # never t3 (NETFLIX)
    assert body["rulesConsidered"] == 1


def test_a_preview_reports_the_clash_too(handler, monkeypatch):
    # She should learn about it from the preview, before committing — not after tapping through.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "petrol", "conditionCount": 1}]

    resp, _, _ = _call(handler, monkeypatch, repo,
                       {"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}},
                       banksync=_RecordingBankSync(existing))

    assert resp["statusCode"] == 409
    assert repo.writes == []


@pytest.mark.parametrize("rule", ["COLES", ["COLES"], 7, True])
def test_a_rule_that_is_not_an_object_is_rejected(handler, monkeypatch, rule):
    repo = _coles_repo()
    resp, body, banksync = _call(handler, monkeypatch, repo, {"dryRun": False, "rule": rule})

    assert resp["statusCode"] == 400
    assert banksync.minted == [] and repo.writes == []


@pytest.mark.parametrize("value", [None, 7, ["COLES"], {"v": 1}])
def test_a_rule_value_that_is_not_a_string_is_rejected(handler, monkeypatch, value):
    repo = _coles_repo()
    resp, _, banksync = _call(handler, monkeypatch, repo,
                              {"dryRun": False, "rule": {"value": value,
                                                         "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert banksync.minted == [] and repo.writes == []


def test_the_fences_are_checked_before_the_history_scan(handler, monkeypatch):
    # A rejected rule must cost nothing. Scanning all history first and then 400ing would make a
    # typo as expensive as a real run.
    class _ExplodingRepo:
        def get_transactions_by_date_range(self, *args, **kwargs):
            raise AssertionError("history must not be scanned for a rejected rule")

    resp, _, banksync = _call(handler, monkeypatch, _ExplodingRepo(),
                              {"dryRun": False, "rule": {"value": "BP",
                                                         "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert banksync.minted == []


# --- interaction with what already exists ------------------------------------


def test_a_hand_filed_charge_still_beats_the_new_rule(handler, monkeypatch):
    # FAIL-ON-REVERT for WHIT-508 surviving this path. She taps a category on a charge while the
    # sweep is running; the conditional write must leave her choice alone and report it, not
    # overwrite it with the rule's category.
    repo = _coles_repo()
    repo.refile_hook = lambda transaction_id, r: (
        r.set_category("t2", "petrol") if transaction_id == "t1" else None)

    _, body, _ = _call(handler, monkeypatch, repo,
                       {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert [filed["id"] for filed in body["filed"]] == ["t1"]
    assert body["alreadyFiled"] == ["t2"]


def test_the_handler_goes_through_create_rule_rather_than_posting_its_own(handler, monkeypatch):
    # The app retries when a run reports `remaining`, and create_rule is what makes that safe:
    # it returns the rule already there instead of minting a second (WHIT-497, its own suite).
    # What THIS pins is narrower and still worth pinning — the handler routes every mint through
    # create_rule, so it inherits that dedup rather than bypassing it with its own POST.
    class _IdempotentBankSync(_RecordingBankSync):
        def create_rule(self, field, operator, value, category_id):
            for rule in self.existing:
                if rule["value"].lower() == value.lower():
                    return rule
            return super().create_rule(field, operator, value, category_id)

    banksync = _IdempotentBankSync([
        {"id": "enr_1", "field": "description", "operator": "contains", "value": "coles",
         "categoryId": "groceries", "conditionCount": 1},
    ])
    _, body, _ = _call(handler, monkeypatch, _coles_repo(),
                       {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
                       banksync=banksync)

    assert banksync.minted == []
    assert body["createdRule"]["id"] == "enr_1"


def test_a_capped_run_leaves_the_rule_in_place_so_tapping_again_finishes(handler, monkeypatch):
    # FAIL-ON-REVERT for the state the app actually hits on a big history: the write cap stops
    # the sweep partway, `remaining` says so, and the app taps again. The rule must already
    # exist at that point — otherwise the second tap mints a duplicate, and the charges filed by
    # the first tap have nothing behind them if she stops there.
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 1)
    repo = _coles_repo()

    _, body, banksync = _call(handler, monkeypatch, repo,
                              {"dryRun": False, "rule": {"value": "COLES",
                                                         "categoryId": "groceries"}})

    assert len(body["filed"]) == 1
    assert body["remaining"] == 1
    assert body["createdRule"]["id"] == "enr_new"
    assert banksync.minted == [("description", "contains", "COLES", "groceries")]


def test_the_route_carries_the_inline_rule_through(handler, monkeypatch):
    repo = _coles_repo()
    banksync = _RecordingBankSync()
    monkeypatch.setattr(handler, "list_rules", banksync.list_rules)
    monkeypatch.setattr(handler, "create_rule", banksync.create_rule)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo({"groceries"}))

    resp = handler.lambda_handler(
        _event({"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}}), None)

    assert resp["statusCode"] == 200
    assert banksync.minted == [("description", "contains", "COLES", "groceries")]
    assert sorted(filed["id"] for filed in json.loads(resp["body"])["filed"]) == ["t1", "t2"]
