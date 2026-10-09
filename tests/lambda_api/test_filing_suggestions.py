"""Tests for GET /transactions/filing-suggestions (WHIT-542) — rules suggested from the user's
hand-filing habits.

The mirror of the merchants endpoint pointed at the FILED-by-hand charges: when the user has
hand-filed the same shop to the same category on enough SEPARATE days, offer the rule that would do
it automatically. "Hand-filed" = category in the user's taxonomy AND no `filed_by_rule` stamp, so a
raw bank enum, a rule-filed charge, and a deleted category's dangling id never count. Distinct DAYS,
so one shopping trip filed in one sitting isn't mistaken for a habit; suppressed when a rule already
covers the merchant; and — like the merchant screen — it discloses what else the rule would sweep
out of the still-unfiled charges.

Runs the real TransactionRepository (deep-page paging) and RuleRepository (real snake_case store
rows) over one FakeTable, so the suppression path goes through the real rule_book.rule_from_row
mapping.
"""

import json

from _api_event import api_event
from _feed_fakes import ANZ, FakeCategoryRepo, real_repos, _row


def _suggest(handler, rows_by_account, taxonomy=("dining", "groceries", "petrol"), rules=()):
    _, repo, rule_repo = real_repos(rows_by_account, rules=rules)
    resp = handler.get_filing_suggestions(repo, FakeCategoryRepo(set(taxonomy)), rule_repo)
    assert resp["statusCode"] == 200
    return json.loads(resp["body"])


def _filed(account_id, date, txn_id, merchant, description, category, **extra):
    return _row(account_id, date, txn_id, merchant_name=merchant,
                description=description, category=category, **extra)


def _seddons_over_days(dates, category="dining"):
    return [_filed(ANZ, date, f"s{index}", "SEDDONS EATERY", "SEDDONS EATERY MELB", category)
            for index, date in enumerate(dates)]


def test_suggests_a_rule_for_a_merchant_filed_by_hand_on_four_distinct_days(handler):
    history = {ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])}

    body = _suggest(handler, history)

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
    history = {ANZ: _seddons_over_days(["2026-07-01", "2026-07-02", "2026-07-03"])}

    assert _suggest(handler, history)["suggestions"] == []


def test_charges_on_the_same_day_count_as_one_day(handler):
    # FAIL-ON-REVERT for distinct-DAYS. Four filings but two share a date -> three distinct days ->
    # below the threshold. Counting raw filings instead of distinct days would suggest here.
    history = {ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-01", "2026-07-02", "2026-07-03"])}

    assert _suggest(handler, history)["suggestions"] == []


def test_a_rule_filed_charge_is_not_a_hand_filing_habit(handler):
    # FAIL-ON-REVERT. A charge a rule already filed carries `filed_by_rule` and must not count
    # toward the habit — otherwise the feature suggests a rule for charges a rule already handles.
    rows = _seddons_over_days(["2026-07-01", "2026-07-02", "2026-07-03"])
    rows.append(_filed(ANZ, "2026-07-04", "r1", "SEDDONS EATERY", "SEDDONS EATERY MELB",
                       "dining", filed_by_rule="somerule"))

    assert _suggest(handler, {ANZ: rows})["suggestions"] == []


def test_a_bank_labelled_charge_is_not_hand_filed(handler):
    # FAIL-ON-REVERT for the critic's over-count fix. The bank stores its own raw category with no
    # stamp; that is not a hand-file. A raw enum ("FOOD_AND_DRINK") is not in the taxonomy, so it is
    # excluded — only the user's own categories count.
    rows = [_filed(ANZ, f"2026-07-0{index + 1}", f"b{index}", "SEDDONS EATERY",
                   "SEDDONS EATERY MELB", "FOOD_AND_DRINK") for index in range(4)]

    assert _suggest(handler, {ANZ: rows})["suggestions"] == []


def test_a_nameless_charge_forms_no_habit(handler):
    # A charge with no merchant name has no merchant identity to rule on (grouping on the full
    # description would make a habit per charge), so it is skipped.
    rows = [_row(ANZ, f"2026-07-0{index + 1}", f"n{index}", merchant_name="",
                 description="OSKO PAYMENT 447112" + str(index), category="dining")
            for index in range(4)]

    assert _suggest(handler, {ANZ: rows})["suggestions"] == []


def test_a_merchant_too_short_to_rule_on_is_not_suggested(handler):
    # FAIL-ON-REVERT for the letters/digits floor (reused from merchant_groups). A rule on "BP"
    # would file every BPAY transfer as petrol, so a two-character pattern yields no suggestion.
    rows = [_filed(ANZ, f"2026-07-0{index + 1}", f"b{index}", "BP", "BP 2210 RICHMOND", "petrol")
            for index in range(4)]

    assert _suggest(handler, {ANZ: rows})["suggestions"] == []


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

    body = _suggest(handler, {ANZ: rows})

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

    body = _suggest(handler, {ANZ: rows})

    suggestion = body["suggestions"][0]
    assert suggestion["rulePattern"] == "COLES"
    assert suggestion["alsoCatches"] == [{"merchant": "COLES EXPRESS", "count": 1}]


def test_suppressed_when_a_rule_already_covers_the_merchant(handler):
    # FAIL-ON-REVERT for suppression. The user already has a "description contains SEDDONS" rule, so
    # nudging them to make one is noise.
    history = {ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])}
    rules = [{"field": "description", "operator": "contains", "value": "SEDDONS",
              "category_id": "dining"}]

    assert _suggest(handler, history, rules=rules)["suggestions"] == []


def test_a_broad_amount_or_direction_rule_does_not_suppress_everything(handler):
    # FAIL-ON-REVERT for the critic's over-suppression fix. A blanket "direction is debit" rule
    # matches every spend; if suppression used a raw rule_matches it would mute EVERY suggestion.
    # Only merchant-identity rules suppress, so this suggestion survives.
    history = {ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])}
    rules = [{"field": "direction", "operator": "is", "value": "debit", "category_id": "dining"}]

    body = _suggest(handler, history, rules=rules)

    assert [s["rulePattern"] for s in body["suggestions"]] == ["SEDDONS EATERY"]


def test_suppressed_when_minting_would_clash_with_a_more_specific_rule(handler):
    # A "COLES EXPRESS -> petrol" rule already exists; minting the broader "COLES -> groceries" the
    # habit suggests would steamroll it, and the file-by-shop mint would refuse the clash. Offering
    # a suggestion the mint rejects is a dead end, so suppress it.
    rows = [_filed(ANZ, d, f"c{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
            for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    rules = [{"field": "description", "operator": "contains", "value": "COLES EXPRESS",
              "category_id": "petrol"}]

    assert _suggest(handler, {ANZ: rows}, rules=rules)["suggestions"] == []


def test_a_same_category_more_specific_rule_does_not_suppress(handler):
    # The clash gate is category-scoped: a more-specific rule to the SAME category agrees, so it is
    # not a clash and must not suppress the broader suggestion.
    rows = [_filed(ANZ, d, f"c{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
            for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    rules = [{"field": "description", "operator": "contains", "value": "COLES EXPRESS",
              "category_id": "groceries"}]

    body = _suggest(handler, {ANZ: rows}, rules=rules)

    assert [s["rulePattern"] for s in body["suggestions"]] == ["COLES"]


def test_route_wires_to_get_filing_suggestions(handler, monkeypatch):
    _, repo, rule_repo = real_repos({ANZ: _seddons_over_days(
        ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo({"dining"}))
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)

    resp = handler.lambda_handler(api_event("GET", "/transactions/filing-suggestions"), None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["suggestions"][0]["rulePattern"] == "SEDDONS EATERY"


def test_a_hand_filed_charge_with_no_date_is_not_counted_as_a_day(handler):
    # A charge whose date is missing carries no spending-day signal; _winning_category skips it.
    # Three real distinct days plus one dateless charge = three distinct days = BELOW the threshold.
    # Counting the dateless charge (or crashing on the empty date) would wrongly reach four.
    rows = _seddons_over_days(["2026-07-01", "2026-07-02", "2026-07-03", ""])

    assert _suggest(handler, {ANZ: rows})["suggestions"] == []


def test_alsocatches_discloses_a_nameless_unfiled_sweep_as_a_null_merchant_line(handler):
    # A "COLES" rule minted from the hand-filed COLES charges would also sweep a still-UNFILED
    # NAMELESS charge whose description contains "coles" (e.g. "PAYPAL *COLES ONLINE"). It has no
    # merchant identity, so it is disclosed as the single null-merchant line, not hidden.
    rows = [_filed(ANZ, d, f"c{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
            for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    rows.append(_row(ANZ, "2026-07-05", "x1", merchant_name="",
                     description="PAYPAL *COLES ONLINE 8842", category=None))

    body = _suggest(handler, {ANZ: rows})

    suggestion = body["suggestions"][0]
    assert suggestion["rulePattern"] == "COLES"
    assert suggestion["alsoCatches"] == [{"merchant": None, "count": 1}]


def test_a_merchant_both_unfiled_and_hand_filed_still_suggests_without_self_disclosure(handler):
    # COLES is hand-filed to groceries on 4 days AND has one still-UNFILED COLES charge. The habit
    # is real, so the suggestion stands; and the shop's OWN unfiled charge (same merchant) is NOT
    # disclosed as an also-catches sweep of a "different shop" -- alsoCatches stays empty.
    rows = [_filed(ANZ, d, f"c{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
            for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    rows.append(_filed(ANZ, "2026-07-09", "u1", "COLES", "COLES 0999 KEW", None))

    body = _suggest(handler, {ANZ: rows})

    assert len(body["suggestions"]) == 1
    assert body["suggestions"][0]["rulePattern"] == "COLES"
    assert body["suggestions"][0]["categoryId"] == "groceries"
    assert body["suggestions"][0]["alsoCatches"] == []
