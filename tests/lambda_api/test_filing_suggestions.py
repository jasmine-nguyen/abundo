"""Tests for GET /transactions/filing-suggestions (WHIT-542) — rules suggested from the user's
hand-filing habits.

The mirror of the merchants endpoint pointed at the FILED-by-hand charges: when the user has
hand-filed the same shop to the same category on enough SEPARATE days, offer the rule that would do
it automatically. "Hand-filed" = category in the user's taxonomy AND no `filed_by_rule` stamp, so a
raw bank enum, a rule-filed charge, and a deleted category's dangling id never count. Distinct DAYS,
so one shopping trip filed in one sitting isn't mistaken for a habit; suppressed when a rule already
covers the merchant; and — like the merchant screen — it discloses what else the rule would sweep
out of the still-unfiled charges.

Reuses FakeFeedRepo (deep-page paging) and FakeRuleRepo (faithful snake_case store rows) so the
suppression path is exercised through the real _rule_to_client mapping.
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, _row, FakeFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _suggest(handler, repo, taxonomy=("dining", "groceries", "petrol"), rules=()):
    resp = handler.get_filing_suggestions(
        repo, FakeCategoryRepo(set(taxonomy)), FakeRuleRepo(rules))
    assert resp["statusCode"] == 200
    return json.loads(resp["body"])


def _filed(account_id, date, txn_id, merchant, description, category, **extra):
    return _row(account_id, date, txn_id, merchant_name=merchant,
                description=description, category=category, **extra)


def _seddons_over_days(dates, category="dining"):
    return [_filed(ANZ, date, f"s{index}", "SEDDONS EATERY", "SEDDONS EATERY MELB", category)
            for index, date in enumerate(dates)]


def test_suggests_a_rule_for_a_merchant_filed_by_hand_on_four_distinct_days(handler):
    repo = FakeFeedRepo({ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])})

    body = _suggest(handler, repo)

    assert len(body["suggestions"]) == 1
    suggestion = body["suggestions"][0]
    assert suggestion["merchant"] == "SEDDONS EATERY"
    assert suggestion["rulePattern"] == "SEDDONS EATERY"
    assert suggestion["categoryId"] == "dining"
    assert suggestion["distinctDays"] == 4
    assert suggestion["alsoCatches"] == []


def test_three_distinct_days_is_below_the_threshold(handler):
    # FAIL-ON-REVERT for the N=4 floor. Three separate days is not yet a habit; drop the threshold
    # to 3 and this reddens.
    repo = FakeFeedRepo({ANZ: _seddons_over_days(["2026-07-01", "2026-07-02", "2026-07-03"])})

    assert _suggest(handler, repo)["suggestions"] == []


def test_charges_on_the_same_day_count_as_one_day(handler):
    # FAIL-ON-REVERT for distinct-DAYS. Four filings but two share a date -> three distinct days ->
    # below the threshold. Counting raw filings instead of distinct days would suggest here.
    repo = FakeFeedRepo({ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-01", "2026-07-02", "2026-07-03"])})

    assert _suggest(handler, repo)["suggestions"] == []


def test_a_rule_filed_charge_is_not_a_hand_filing_habit(handler):
    # FAIL-ON-REVERT. A charge a rule already filed carries `filed_by_rule` and must not count
    # toward the habit — otherwise the feature suggests a rule for charges a rule already handles.
    rows = _seddons_over_days(["2026-07-01", "2026-07-02", "2026-07-03"])
    rows.append(_filed(ANZ, "2026-07-04", "r1", "SEDDONS EATERY", "SEDDONS EATERY MELB",
                       "dining", filed_by_rule="somerule"))

    assert _suggest(handler, FakeFeedRepo({ANZ: rows}))["suggestions"] == []


def test_a_bank_labelled_charge_is_not_hand_filed(handler):
    # FAIL-ON-REVERT for the critic's over-count fix. The bank stores its own raw category with no
    # stamp; that is not a hand-file. A raw enum ("FOOD_AND_DRINK") is not in the taxonomy, so it is
    # excluded — only the user's own categories count.
    rows = [_filed(ANZ, f"2026-07-0{index + 1}", f"b{index}", "SEDDONS EATERY",
                   "SEDDONS EATERY MELB", "FOOD_AND_DRINK") for index in range(4)]

    assert _suggest(handler, FakeFeedRepo({ANZ: rows}))["suggestions"] == []


def test_a_deleted_categorys_dangling_id_is_not_hand_filed(handler):
    # A category the user has since deleted leaves a dangling id on old charges. It is not in the
    # taxonomy, so it is excluded — a suggestion filing into a category that no longer exists would
    # leave the charge unfiled forever.
    rows = _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"], category="deleted-cat")

    assert _suggest(handler, FakeFeedRepo({ANZ: rows}))["suggestions"] == []


def test_income_is_not_suggested(handler):
    # `income` is "filed" but is not a pickable taxonomy category (the file-by-shop mint can't target
    # it), so it never yields a suggestion. Keyed on taxonomy membership, income is excluded.
    rows = _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"], category="income")

    assert _suggest(handler, FakeFeedRepo({ANZ: rows}))["suggestions"] == []


def test_a_nameless_charge_forms_no_habit(handler):
    # A charge with no merchant name has no merchant identity to rule on (grouping on the full
    # description would make a habit per charge), so it is skipped.
    rows = [_row(ANZ, f"2026-07-0{index + 1}", f"n{index}", merchant_name="",
                 description="OSKO PAYMENT 447112" + str(index), category="dining")
            for index in range(4)]

    assert _suggest(handler, FakeFeedRepo({ANZ: rows}))["suggestions"] == []


def test_a_merchant_too_short_to_rule_on_is_not_suggested(handler):
    # FAIL-ON-REVERT for the letters/digits floor (reused from merchant_groups). A rule on "BP"
    # would file every BPAY transfer as petrol, so a two-character pattern yields no suggestion.
    rows = [_filed(ANZ, f"2026-07-0{index + 1}", f"b{index}", "BP", "BP 2210 RICHMOND", "petrol")
            for index in range(4)]

    assert _suggest(handler, FakeFeedRepo({ANZ: rows}))["suggestions"] == []


def test_a_merchant_filed_to_two_categories_yields_one_winning_suggestion(handler):
    # A shop filed to two categories must not produce two cards minting the SAME pattern to
    # different categories (they collide on the shared rule id). One suggestion, the category with
    # the most distinct days.
    rows = (
        [_filed(ANZ, d, f"g{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
         for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
        + [_filed(ANZ, d, f"p{i}", "COLES", "COLES 0342 RICHMOND", "petrol")
           for i, d in enumerate(["2026-07-05", "2026-07-06"])]
    )

    body = _suggest(handler, FakeFeedRepo({ANZ: rows}))

    assert len(body["suggestions"]) == 1
    assert body["suggestions"][0]["rulePattern"] == "COLES"
    assert body["suggestions"][0]["categoryId"] == "groceries"  # 4 days beats 2
    assert body["suggestions"][0]["distinctDays"] == 4


def test_discloses_other_merchants_the_rule_would_sweep_from_unfiled_charges(handler):
    # FAIL-ON-REVERT for the critic's alsoCatches-population fix. The disclosure is the FORWARD
    # mis-file risk: a "COLES" rule minted from the hand-filed COLES charges would also file the
    # still-UNFILED "COLES EXPRESS" charge. It must be disclosed, and the already-filed COLES
    # charges must NOT appear (they're not the sweep).
    rows = [_filed(ANZ, d, f"c{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
            for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    rows.append(_filed(ANZ, "2026-07-05", "x1", "COLES EXPRESS", "COLES EXPRESS 1123", None))

    body = _suggest(handler, FakeFeedRepo({ANZ: rows}))

    suggestion = body["suggestions"][0]
    assert suggestion["rulePattern"] == "COLES"
    assert suggestion["alsoCatches"] == [{"merchant": "COLES EXPRESS", "count": 1}]


def test_suppressed_when_a_rule_already_covers_the_merchant(handler):
    # FAIL-ON-REVERT for suppression. The user already has a "description contains SEDDONS" rule, so
    # nudging them to make one is noise.
    repo = FakeFeedRepo({ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])})
    rules = [{"field": "description", "operator": "contains", "value": "SEDDONS",
              "category_id": "dining"}]

    assert _suggest(handler, repo, rules=rules)["suggestions"] == []


def test_a_broad_amount_or_direction_rule_does_not_suppress_everything(handler):
    # FAIL-ON-REVERT for the critic's over-suppression fix. A blanket "direction is debit" rule
    # matches every spend; if suppression used a raw rule_matches it would mute EVERY suggestion.
    # Only merchant-identity rules suppress, so this suggestion survives.
    repo = FakeFeedRepo({ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])})
    rules = [{"field": "direction", "operator": "is", "value": "debit", "category_id": "dining"}]

    body = _suggest(handler, repo, rules=rules)

    assert [s["rulePattern"] for s in body["suggestions"]] == ["SEDDONS EATERY"]


def test_suppressed_when_minting_would_clash_with_a_more_specific_rule(handler):
    # A "COLES EXPRESS -> petrol" rule already exists; minting the broader "COLES -> groceries" the
    # habit suggests would steamroll it, and the file-by-shop mint would refuse the clash. Offering
    # a suggestion the mint rejects is a dead end, so suppress it.
    rows = [_filed(ANZ, d, f"c{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
            for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    rules = [{"field": "description", "operator": "contains", "value": "COLES EXPRESS",
              "category_id": "petrol"}]

    assert _suggest(handler, FakeFeedRepo({ANZ: rows}), rules=rules)["suggestions"] == []


def test_a_same_category_more_specific_rule_does_not_suppress(handler):
    # The clash gate is category-scoped: a more-specific rule to the SAME category agrees, so it is
    # not a clash and must not suppress the broader suggestion.
    rows = [_filed(ANZ, d, f"c{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
            for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    rules = [{"field": "description", "operator": "contains", "value": "COLES EXPRESS",
              "category_id": "groceries"}]

    body = _suggest(handler, FakeFeedRepo({ANZ: rows}), rules=rules)

    assert [s["rulePattern"] for s in body["suggestions"]] == ["COLES"]


def test_suggestions_are_ordered_most_filed_first_then_by_pattern(handler):
    rows = (
        _seddons_over_days(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])
        + [_filed(ANZ, d, f"a{i}", "ALDI", "ALDI 771 KEW", "groceries")
           for i, d in enumerate(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04",
                                  "2026-06-05"])]
        + [_filed(ANZ, d, f"m{i}", "MYER", "MYER CITY", "lifestyle")
           for i, d in enumerate(["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"])]
    )

    body = _suggest(handler, FakeFeedRepo({ANZ: rows}),
                    taxonomy=("dining", "groceries", "lifestyle"))

    # ALDI (5 days) first; SEDDONS and MYER tie at 4, broken by pattern ("SEDDONS EATERY" < ...).
    assert [(s["rulePattern"], s["distinctDays"]) for s in body["suggestions"]] == [
        ("ALDI", 5), ("MYER", 4), ("SEDDONS EATERY", 4),
    ]


def test_empty_history_returns_no_suggestions(handler):
    assert _suggest(handler, FakeFeedRepo({})) == {"suggestions": []}


def test_scans_whole_history_with_no_date_floor(handler):
    repo = FakeFeedRepo({ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])})

    handler.get_filing_suggestions(repo, FakeCategoryRepo({"dining"}), FakeRuleRepo())

    anz_call = next(call for call in repo.calls if call[0] == ANZ)
    assert anz_call[1] is None and anz_call[2] is None


def test_route_wires_to_get_filing_suggestions(handler, monkeypatch):
    repo = FakeFeedRepo({ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo({"dining"}))
    monkeypatch.setattr(handler, "RuleRepository", lambda: FakeRuleRepo())

    resp = handler.lambda_handler({
        "rawPath": "/transactions/filing-suggestions",
        "requestContext": {"http": {"method": "GET"}},
    }, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["suggestions"][0]["rulePattern"] == "SEDDONS EATERY"


def test_post_to_the_suggestions_path_is_not_routed(handler, monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError("get_filing_suggestions must not run for POST")

    monkeypatch.setattr(handler, "get_filing_suggestions", _boom)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: FakeFeedRepo({}))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(set()))
    monkeypatch.setattr(handler, "RuleRepository", lambda: FakeRuleRepo())

    resp = handler.lambda_handler({
        "rawPath": "/transactions/filing-suggestions",
        "requestContext": {"http": {"method": "POST"}},
    }, None)

    assert resp["statusCode"] == 404
