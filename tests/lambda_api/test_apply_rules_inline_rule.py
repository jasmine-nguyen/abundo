"""Tests for the optional inline `rule` on POST /transactions/uncategorized/apply-rules
(WHIT-516) — "make a rule for this shop AND file the charges it already has", in one request.

Established by WHIT-502: making a rule does NOT touch charges already stored; rules only run
when new data arrives. So minting a rule for COLES on its own leaves all 38 existing COLES
charges exactly where they were. This closes that in one request, so there is no window where
the rule exists and the charges are untouched.

The rule minted here outlives the request and files in bulk, so it is fenced hard: the same
letters/digits floor the merchant screen offers groups by, a category the user actually has, and
`description contains` only — a supplied field/operator is rejected, never quietly narrowed.

Runs the real TransactionRepository and RuleRepository over one FakeTable (WHIT-625). Rule ids
come from the real store, so the tests assert relationally (createdRule is the minted/existing row)
rather than on a hand-picked id.
"""

import json

import pytest

from _feed_fakes import (
    apply_rules_event,
    SPENDING, WESTPAC, FakeCategoryRepo, Repos, charge_writes, fail_writes, on_write, _row,
    set_category, stored,
)
from _rule_ingest_fakes import apply_rules_to_uncategorized


def _coles_rows():
    return [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342 RICHMOND"),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE"),
        _row(SPENDING, "2026-07-01", "t3", description="NETFLIX.COM"),
    ]


def _nested_coles_rows():
    """COLES and COLES EXPRESS — the nesting the merchant screen discloses via `alsoCatches`.
    A rule on COLES sweeps the EXPRESS charge in too."""
    return [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342 RICHMOND",
             merchant_name="Coles"),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE",
             merchant_name="Coles"),
        _row(SPENDING, "2026-07-01", "e1", description="COLES EXPRESS 5512",
             merchant_name="Coles Express"),
    ]


def _messy_rows():
    """Unfiled charges from deliberately awkward merchants: a unicode name, a punctuation-heavy
    one, and one whose only letters/digits are DIGITS — plus a nameless "PAYPAL *" charge the
    unicode merchant's rule sweeps in, so a group count taken from the merchant BUCKET rather
    than from the rule's real members would disagree with what gets filed. The two nameless OSKO
    charges make a WORDING group (grouped by trimming the trailing reference, WHIT-519)."""
    return {
        SPENDING: [
            _row(SPENDING, "2026-07-10", "o1", description="OSKO PAYMENT 4471123", merchant_name=""),
            _row(SPENDING, "2026-07-09", "o2", description="OSKO PAYMENT 4471124", merchant_name=""),
            _row(SPENDING, "2026-07-08", "u1", description="CAFÉ MÖRK 0042 FITZROY",
                 merchant_name="Café Mörk"),
            _row(SPENDING, "2026-07-07", "u2", description="CAFÉ MÖRK 0042 FITZROY",
                 merchant_name="Café Mörk"),
            _row(SPENDING, "2026-07-06", "u3", description="PAYPAL *CAFÉ MÖRK 99213"),
            _row(SPENDING, "2026-07-05", "p1", description="J.B. HI-FI 1234 CHADSTONE",
                 merchant_name="J.B. Hi-Fi"),
            _row(SPENDING, "2026-07-04", "p2", description="J.B. HI-FI ONLINE",
                 merchant_name="J.B. Hi-Fi"),
        ],
        WESTPAC: [
            _row(WESTPAC, "2026-07-03", "d1", description="1300 655 506 PAYMENT",
                 merchant_name="1300 655 506"),
            _row(WESTPAC, "2026-07-02", "d2", description="DD 1300 655 506",
                 merchant_name="1300 655 506"),
            _row(WESTPAC, "2026-07-01", "n1", description="NETFLIX.COM",
                 merchant_name="Netflix"),
        ],
    }


def _existing(value, category_id):
    # The kwargs of one real RuleRepository.create_rule call — a rule she already has.
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id}


class _Run(Repos):
    """The real repos over one table, seeded with her charges (default: two COLES + NETFLIX)."""

    def __init__(self, rows=None, existing=()):
        super().__init__({SPENDING: _coles_rows() if rows is None else rows}, rules=existing)

    def minted(self):
        """The minted rows as (field, operator, value, category_id), for order-free equality."""
        return [(rule["field"], rule["operator"], rule["value"], rule["category_id"])
                for rule in self.minted_rules()]

    def filed_keys(self):
        """(sk, category) of every stored charge the request filed, by the charge's own key."""
        return sorted((row["sk"], row["category"]) for row in self.table.store.values()
                      if row["pk"] == f"ACCOUNT#{SPENDING}" and "category" in row)


def _call(handler, body, run=None, categories=frozenset({"groceries", "petrol"})):
    if run is None:
        run = _Run()
    resp = apply_rules_to_uncategorized(
        handler,
        apply_rules_event(body), run.transaction_repo, FakeCategoryRepo(categories), run.rule_repo)
    return resp, json.loads(resp["body"]), run


def _merchants(handler, rows_by_account, categories=("groceries", "petrol")):
    response = handler.get_uncategorized_merchants(
        Repos(rows_by_account).transaction_repo, FakeCategoryRepo(categories))
    return json.loads(response["body"])["groups"]


_COLES = {"value": "COLES", "categoryId": "groceries"}


# --- the point of the card ---------------------------------------------------


def test_one_request_mints_the_rule_and_files_the_charges_it_already_has(handler):
    # FAIL-ON-REVERT for the whole card. Making the rule alone leaves every stored charge
    # unfiled (WHIT-502), which is the problem — so both must happen, in one request.
    resp, body, run = _call(handler, {"dryRun": False, "rule": _COLES})

    assert resp["statusCode"] == 200
    assert run.minted() == [("description", "contains", "COLES", "groceries")]
    assert body["createdRule"]["id"] == run.minted_rules()[0]["id"]   # the rule we just minted
    assert body["createdRule"]["categoryId"] == "groceries"          # mapped to client shape
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]  # never NETFLIX
    assert charge_writes(run.table) == [
        (f"ACCOUNT#{SPENDING}", "TXN#t1"),
        (f"ACCOUNT#{SPENDING}", "TXN#t2"),
    ]
    assert run.filed_keys() == [("TXN#t1", "groceries"), ("TXN#t2", "groceries")]


def test_the_minted_inline_rule_stamps_the_charges_it_files(handler):
    # WHIT-536: the plan is computed BEFORE the inline rule is minted, so its plan-time id is
    # None; the filed rows must carry the freshly-created rule's real id, not None.
    _resp, _body, run = _call(handler, {"dryRun": False, "rule": _COLES})
    minted_id = run.minted_rules()[0]["id"]
    assert minted_id
    for txn_id in ("t1", "t2"):
        row = run.table.store[(f"ACCOUNT#{SPENDING}", f"TXN#{txn_id}")]
        assert row["filed_by_rule"] == minted_id


def test_a_preview_shows_the_numbers_without_minting_anything(handler):
    # FAIL-ON-REVERT. The screen shows what would happen BEFORE she commits, so a preview must
    # not leave a rule behind — a rule she never confirmed would go on filing every future charge
    # from that shop.
    resp, body, run = _call(handler, {"dryRun": True, "rule": _COLES})

    assert body["dryRun"] is True
    assert body["matched"] == 2       # the preview still counts what it WOULD file
    assert body["createdRule"] is None
    assert run.minted() == []
    assert run.table.update_calls == []


def test_the_inline_rule_files_only_its_own_shop_not_her_other_rules(handler):
    # FAIL-ON-REVERT for the whole card (WHIT-523). She taps "file COLES"; her BP charge, which
    # a DIFFERENT rule of hers covers, must be left alone. The sweep runs the inline rule ONLY,
    # so only the COLES charge files — the BP rule is read (for the clash check) but not swept.
    run = _Run(rows=[
        _row(SPENDING, "2026-07-02", "t1", description="COLES 0342"),
        _row(SPENDING, "2026-07-01", "t2", description="BP 2210 SERVO"),
    ], existing=[_existing("BP 2210", "petrol")])

    _, body, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert body["byCategory"] == {"groceries": 1}          # never petrol
    assert body["filed"] == [{"id": "t1", "category": "groceries"}]  # BP charge left unfiled
    assert body["rulesConsidered"] == 1                    # only the inline rule was swept
    assert [entry["ruleId"] for entry in body["byRule"]] == [None]


def test_the_count_the_merchant_screen_shows_is_the_number_this_route_really_files(handler):
    # FAIL-ON-REVERT for the seam's arithmetic, asserted between two REAL production functions:
    # merchant_groups' count and the sweep's own `filed` list. "COLES — 38 charges" shown
    # immediately before a bulk write has to be the 38 that move — for merchant groups and for
    # nameless-charge WORDING groups alike.
    groups = _merchants(handler, _messy_rows())
    wording = next(group for group in groups if group["groupedBy"] == "description")
    assert wording["rulePattern"] == "OSKO PAYMENT"

    for group in groups:
        _, body, run = _call(
            handler, {"dryRun": False, "rule": {"value": group["rulePattern"], "categoryId": "groceries"}},
            run=Repos(_messy_rows()))
        assert len(body["filed"]) == group["count"], group["rulePattern"]
        assert body["byCategory"] == {"groceries": group["count"]}
        assert len(run.table.update_calls) == group["count"]


@pytest.mark.parametrize("budget_excluded, expected", [
    (True, {"category": "groceries", "budget_excluded": True}),
    (None, {"category": "groceries"}),
])
def test_inline_file_this_shop_keeps_out_of_budget_only_when_asked(handler, budget_excluded, expected):
    # WHIT-558: the inline mint stamps "keep out of budget" in the same write as the category,
    # and only when the request asks for it.
    rule = {"value": "ALDI", "categoryId": "groceries"}
    if budget_excluded is not None:
        rule["budgetExcluded"] = budget_excluded
    run = _Run(rows=[_row(SPENDING, "2026-07-01", "t1", description="ALDI 1")])

    _call(handler, {"dryRun": False, "rule": rule}, run=run)

    row = stored(run.table, "t1")
    assert {key: row[key] for key in ("category", "budget_excluded") if key in row} == expected


def test_a_failure_to_mint_writes_nothing(handler):
    # FAIL-ON-REVERT. If the rule can't be saved, the sweep must not run: filing the charges with
    # no rule behind them silently loses the "and catch future ones" half she asked for.
    # WHIT-531: the mint is our store now, so a write failure is a DatabaseError -> 500 (our
    # server), not the old BankSync 502. A bare-500 vs 502 detail no longer applies.
    run = _Run()
    run.table.fail("put_item")
    resp, _, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 500
    assert run.table.update_calls == []


def test_a_failure_to_read_her_rules_mints_nothing(handler):
    # The inline rule must not be minted when we could not read the rules it must check for a
    # clash before minting. Minting first would leave a rule behind for a request that failed.
    # WHIT-531: the read is our store, so its failure is a DatabaseError -> 500 (our server).
    run = _Run()
    run.table.fail("query")
    resp, _, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 500
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_the_rule_stays_minted_when_every_write_fails(handler):
    # The recoverable state the mint-before-sweep ordering promises: the rule exists, the charges
    # did not move, and tapping again finishes the job. A 500 here would be a lie (the rule DID
    # get made) and would hide which rows still need retrying.
    run = _Run()
    fail_writes(run.table, "t1", "t2")
    resp, body, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 200
    assert body["createdRule"]["id"] == run.minted_rules()[0]["id"]
    assert body["filed"] == []
    assert sorted(body["failed"]) == ["t1", "t2"]
    assert len(run.minted_rules()) == 1


def test_a_rule_that_clashes_only_at_mint_time_returns_409_not_500(handler, monkeypatch):
    # The pre-scan clash check read the rules list once; a concurrent request then created a
    # same-text, different-category rule before our mint. create_rule raises RuleClashError, and
    # the mint path must turn that into a 409 with the winning rule — never let it escape as a 500.
    run = _Run()
    create_rule = run.rule_repo.create_rule

    def raced_create_rule(*args, **kwargs):
        create_rule("description", "contains", "COLES", "petrol")   # the concurrent request wins
        return create_rule(*args, **kwargs)

    monkeypatch.setattr(run.rule_repo, "create_rule", raced_create_rule)

    resp, body, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == run.rule_id("COLES")
    assert body["existingRule"]["categoryId"] == "petrol"   # mapped from the store's category_id
    assert run.table.update_calls == []


# --- the fences --------------------------------------------------------------


@pytest.mark.parametrize("value", ["BP", "7-11", "A&B*", "   ", "  BP  "])
def test_a_rule_value_too_short_to_be_safe_is_rejected(handler, value):
    # FAIL-ON-REVERT for the floor, and it must count LETTERS AND DIGITS, not characters:
    # "7-11" and "A&B*" are four characters long. A rule on "BP" files every BPAY transfer as
    # petrol, permanently — so this is a 400, not a silent skip.
    resp, _, run = _call(handler, {"dryRun": False, "rule": {"value": value,
                                                             "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert run.minted() == [] and run.table.update_calls == []


@pytest.mark.parametrize("category_id", ["not-a-category", "", None, 7, "GROCERIES"])
def test_a_category_she_does_not_have_is_rejected(handler, category_id):
    # FAIL-ON-REVERT. Filing to a category that isn't hers leaves every charge STILL unfiled by
    # the badge's own rule, so the next run would file them again — forever. rule_engine would
    # skip such a rule silently; here she gets told.
    resp, _, run = _call(handler, {"dryRun": False, "rule": {"value": "COLES",
                                                             "categoryId": category_id}})

    assert resp["statusCode"] == 400
    assert run.minted() == [] and run.table.update_calls == []


@pytest.mark.parametrize("extra", [{"operator": "equals"}, {"field": "category"},
                                   {"field": "description", "operator": "contains"}])
def test_a_supplied_field_or_operator_is_rejected_not_ignored(handler, extra):
    # FAIL-ON-REVERT. This route mints "description contains" only. Quietly ignoring a supplied
    # "equals" would file a completely different set of charges than the caller asked for, and
    # nothing would say so — even the harmless-looking explicit defaults are refused, so the
    # contract is one thing rather than two.
    rule = {"value": "COLES", "categoryId": "groceries", **extra}
    resp, _, run = _call(handler, {"dryRun": False, "rule": rule})

    assert resp["statusCode"] == 400
    assert run.minted() == [] and run.table.update_calls == []


@pytest.mark.parametrize("rule", ["COLES", ["COLES"], 7, True])
def test_a_rule_that_is_not_an_object_is_rejected(handler, rule):
    resp, body, run = _call(handler, {"dryRun": False, "rule": rule})

    assert resp["statusCode"] == 400
    assert run.minted() == [] and run.table.update_calls == []


@pytest.mark.parametrize("value", [None, 7, ["COLES"], {"v": 1}])
def test_a_rule_value_that_is_not_a_string_is_rejected(handler, value):
    resp, _, run = _call(handler, {"dryRun": False, "rule": {"value": value,
                                                             "categoryId": "groceries"}})

    assert resp["statusCode"] == 400
    assert run.minted() == [] and run.table.update_calls == []


def test_inline_rule_rejects_a_non_boolean_budget_excluded(handler):
    run = _Run(rows=[_row(SPENDING, "2026-07-01", "t1", description="ALDI 1")])
    body = {"dryRun": False,
            "rule": {"value": "ALDI", "categoryId": "groceries", "budgetExcluded": "yes"}}
    resp, _, _ = _call(handler, body, run=run)
    assert resp["statusCode"] == 400
    assert run.table.update_calls == []


# --- a conflict with a rule she already has -----------------------------------


@pytest.mark.parametrize("existing_value", ["COLES", "coles", "  Coles  "])
def test_an_existing_rule_on_the_same_text_filing_elsewhere_is_refused(handler, existing_value):
    # She already has COLES -> petrol and the screen offers COLES; filing it to groceries would
    # leave the two rules permanently disagreeing, so every COLES charge is conflicted and NEVER
    # filed — on this run or any future one. Refused outright, and the casing/spacing variants
    # must be caught too (the same merchant is spelled inconsistently in real rules).
    run = _Run(rows=_nested_coles_rows(), existing=[_existing(existing_value, "petrol")])

    resp, body, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == run.rule_id(existing_value)
    assert "petrol" in body["error"]
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_a_preview_reports_the_clash_too(handler):
    # She should learn about it from the preview, before committing — not after tapping through.
    run = _Run(existing=[_existing("COLES", "petrol")])

    resp, _, _ = _call(handler, {"dryRun": True, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 409
    assert run.table.update_calls == []


def test_inline_mint_clashing_only_on_the_flag_is_refused_in_the_preview(handler):
    # WHIT-558 coherence: an existing "ALDI -> groceries" (not excluded); the inline mint wants
    # "ALDI -> groceries + keep out of budget". create_rule would clash on the differing flag, so the
    # DRY-RUN preview must report the clash too — else it promises a filing the commit then 409s.
    # FAIL-ON-REVERT: drop `_rule_that_would_clash_on_exclusion` from the pre-scan and the preview
    # returns 200 "would file" instead of 409. The existing rule carries its REAL derived id (no
    # hardcoded id) so the pre-scan's id match is exercised.
    existing = {"field": "description", "operator": "contains", "value": "ALDI",
                "category_id": "groceries", "budget_excluded": False}
    run = _Run(rows=[_row(SPENDING, "2026-07-01", "t1", description="ALDI 1")], existing=[existing])
    body = {"dryRun": True,
            "rule": {"value": "ALDI", "categoryId": "groceries", "budgetExcluded": True}}
    resp, _, _ = _call(handler, body, run=run)
    assert resp["statusCode"] == 409
    assert run.table.update_calls == []


def test_a_clash_on_a_rule_past_the_old_100_row_page_is_still_found(handler):
    # FAIL-ON-REVERT for WHIT-531's reason to exist. BankSync capped list_rules at 100; our store
    # is uncapped. Seed 150 unrelated rules plus a COLES->petrol clash that the store lists past
    # row 100 (rules list in id order). A preview of COLES->groceries must 409 on it. Reintroduce
    # a `[:100]` slice on the read and the clash is dropped -> the preview returns 200 -> red. A
    # PREVIEW deliberately: it never mints, so create_rule's own dedup can't backstop a dropped
    # pre-scan clash.
    rules = [_existing(f"SHOP-{i:03d}-ZZ", "petrol") for i in range(150)]
    rules.append(_existing("COLES", "petrol"))
    run = _Run(rows=[], existing=rules)
    listed = run.rule_repo.list_rules()
    clash = next(rule for rule in listed if rule["value"] == "COLES")
    assert listed.index(clash) >= 100                        # the premise: past the old page

    resp, body, _ = _call(handler, {"dryRun": True, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == clash["id"]
    assert body["existingRule"]["categoryId"] == "petrol"   # mapped from category_id
    assert len(run.rule_repo.list_rules()) == 151            # nothing minted


def test_an_existing_rule_to_the_SAME_category_is_not_a_clash(handler):
    # FAIL-ON-REVERT the other way. Refusing this would break the re-tap after a capped run —
    # the rule is already there by design, and the second tap has to finish the filing. Its store
    # id matches an inline mint of the same text, so create_rule dedups it.
    run = _Run(existing=[_existing("COLES", "groceries")])

    resp, body, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_a_rule_for_a_different_shop_is_not_a_clash(handler):
    # Only the SAME target text clashes. A rule for another shop filing elsewhere is normal —
    # refusing on category alone would make the screen unusable after the first few shops.
    run = _Run(existing=[_existing("NETFLIX", "petrol")])

    resp, body, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 200
    assert run.minted() == [("description", "contains", "COLES", "groceries")]
    # A different shop's rule is no clash, so the COLES rule is minted and swept — but ONLY it
    # (WHIT-523). The NETFLIX charge (t3) her existing rule covers is left unfiled; filing COLES
    # files just COLES.
    assert sorted((filed["id"], filed["category"]) for filed in body["filed"]) == [
        ("t1", "groceries"), ("t2", "groceries"),
    ]


def test_a_NESTED_existing_rule_is_refused_too_not_just_an_exact_repeat(handler):
    # The likeliest conflict of the lot, and the one an equality-only guard waves straight
    # through. An existing "COLES EXPRESS -> petrol" is different TEXT from an inline
    # "COLES -> groceries", but every EXPRESS charge matches both — so they fight, and a charge
    # two rules disagree about is never filed, on this run or any future one.
    #
    # Minting would file the 2 plain COLES charges, strand the EXPRESS one for good, and return
    # 200 with a bare `conflicted: 1`. The screen said 3. This is the inline-MORE-GENERAL direction:
    # the sweep narrows to the inline COLES rule, which would steamroll the existing COLES EXPRESS
    # rule's charge into groceries. WHIT-518 keeps refusing THIS direction (the reverse — a more
    # specific inline — is now allowed; see the next test).
    offered = _merchants(handler, {SPENDING: _nested_coles_rows()})
    group = next(g for g in offered if g["rulePattern"] == "COLES")
    assert group["count"] == 3
    assert group["alsoCatches"] == [{"merchant": "Coles Express", "count": 1}]

    run = _Run(rows=_nested_coles_rows(), existing=[_existing("COLES EXPRESS", "petrol")])
    resp, body, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == run.rule_id("COLES EXPRESS")
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_a_more_specific_inline_rule_is_now_allowed(handler):
    # [WHIT-518] The reverse of the case above: an existing rule on the WIDER text ("COLES" ->
    # groceries), an inline rule on the NARROWER one ("COLES EXPRESS" -> petrol). This is the
    # inline-MORE-SPECIFIC direction, now ALLOWED — the narrowed sweep files only the inline rule's
    # OWN charges (e1), and a full "Apply my rules" would resolve the same charge to petrol by
    # most-specific-wins, so the two paths agree. The plain COLES charges (t1, t2) are untouched.
    # FAIL-ON-REVERT: a symmetric (two-way) clash check would 409 this and file nothing.
    run = _Run(rows=_nested_coles_rows(), existing=[_existing("COLES", "groceries")])
    resp, body, _ = _call(
        handler, {"dryRun": False, "rule": {"value": "COLES EXPRESS", "categoryId": "petrol"}},
        run=run)

    assert resp["statusCode"] == 200
    assert [filed["id"] for filed in body["filed"]] == ["e1"]      # only the EXPRESS charge
    assert body["byCategory"] == {"petrol": 1}
    assert len(run.minted_rules()) == 1 and run.minted_rules()[0]["value"] == "COLES EXPRESS"
    assert charge_writes(run.table) == [(f"ACCOUNT#{SPENDING}", "TXN#e1")]   # t1/t2 never touched


def test_inline_between_a_more_general_and_a_more_specific_existing_rule_is_refused(handler):
    # A three-rule store the per-rule loop must judge one at a time: the existing "COLES" is MORE
    # GENERAL than the inline "COLES EXPRESS" (safe to be more specific than), but the existing
    # "COLES EXPRESS STATION" is MORE SPECIFIC than it and would be steamrolled. Minting must 409,
    # naming the specific rule — not be waved through just because one existing rule is safe.
    run = _Run(rows=_nested_coles_rows(), existing=[
        _existing("COLES", "groceries"), _existing("COLES EXPRESS STATION", "coffee")])
    resp, body, _ = _call(
        handler, {"dryRun": False, "rule": {"value": "COLES EXPRESS", "categoryId": "petrol"}},
        run=run, categories=("groceries", "petrol", "coffee"))

    assert resp["statusCode"] == 409
    assert body["existingRule"]["id"] == run.rule_id("COLES EXPRESS STATION")
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_a_nested_rule_to_the_SAME_category_is_still_fine(handler):
    # Overlap only matters when the two DISAGREE. "COLES EXPRESS -> groceries" and
    # "COLES -> groceries" both file to the same place, so nothing conflicts and the charges
    # file normally. Refusing on overlap alone would block a perfectly sensible pair.
    run = _Run(rows=_nested_coles_rows(), existing=[_existing("COLES EXPRESS", "groceries")])
    resp, body, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert resp["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["e1", "t1", "t2"]


# --- interaction with what already exists ------------------------------------


def test_a_hand_filed_charge_still_beats_the_new_rule(handler):
    # FAIL-ON-REVERT for WHIT-508 surviving this path. She taps a category on a charge while the
    # sweep is running; the conditional write must leave her choice alone and report it, not
    # overwrite it with the rule's category.
    run = _Run()
    on_write(run.table, "t1", lambda table: set_category(table, "t2", "petrol"))

    _, body, _ = _call(handler, {"dryRun": False, "rule": _COLES}, run=run)

    assert [filed["id"] for filed in body["filed"]] == ["t1"]
    assert body["alreadyFiled"] == ["t2"]


def test_tapping_again_after_the_cap_finishes_the_job_and_rewrites_nothing(handler):
    # The DB-write half of safe-to-run-twice across the cap boundary. The first `cap` are FILED,
    # so the second request's scan no longer sees them — no row is written twice even though the
    # rule is now BOTH in her store and re-sent inline. The SAME rule store spans both taps, so the
    # mint from the first is visible (and deduped) on the second.
    cap = handler.APPLY_RULES_MAX_WRITES
    run = _Run(rows=[
        _row(SPENDING, "2026-07-01", f"t{index:04d}", description=f"COLES {index}",
             merchant_name="Coles")
        for index in range(cap + 25)
    ])
    request = {"dryRun": False, "rule": _COLES}

    _, first, _ = _call(handler, request, run=run)
    _, second, _ = _call(handler, request, run=run)

    first_ids = {filed["id"] for filed in first["filed"]}
    second_ids = {filed["id"] for filed in second["filed"]}
    assert len(first_ids) == cap and len(second_ids) == 25
    assert first_ids.isdisjoint(second_ids)
    assert second["remaining"] == 0 and second["unfiled"] == 25
    # Exactly one write per row across BOTH requests — nothing refiled.
    assert len(run.table.update_calls) == cap + 25
    # The mint deduped on the second tap: one row minted in total, not two.
    assert len(run.minted_rules()) == 1
    # WHIT-523: the sweep is the inline rule ALONE, even on the re-tap when a copy of it now
    # exists in the store. So it is considered once, not twice.
    assert second["rulesConsidered"] == 1
    assert [entry["ruleId"] for entry in second["byRule"]] == [None]


# --- value handling -----------------------------------------------------------


@pytest.mark.parametrize("value", ["  COLES  ", "\tCOLES\n", "COLES "])
def test_an_accepted_value_is_minted_trimmed(handler, value):
    # The minted value is what the store keeps and what the client's duplicate-rule guard folds
    # against, so a stray trailing space would make the same rule mintable twice.
    _, body, run = _call(handler, {"dryRun": False, "rule": {"value": value,
                                                             "categoryId": "groceries"}})

    assert run.minted() == [("description", "contains", "COLES", "groceries")]
    assert body["createdRule"]["value"] == "COLES"
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_an_explicit_null_rule_is_the_plain_sweep_not_a_400(handler):
    # The app serialising an absent rule as JSON null must not become a 400 — and must not
    # become a mint either.
    run = _Run(existing=[_existing("COLES", "groceries")])
    resp, body, _ = _call(handler, {"dryRun": False, "rule": None}, run=run)

    assert resp["statusCode"] == 200
    assert run.minted_rules() == [] and body["createdRule"] is None
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]
