"""WHIT-542 GAP tests for GET /transactions/filing-suggestions — adversarial edges the
implementer's test_filing_suggestions.py does not cover.

Covers, one per candidate gap:
  [G1] an EQUAL distinct-day tie between two categories -> deterministic winner (category id);
  [G2] a hand-filed charge with a MISSING date is not counted as a spending day (and doesn't crash);
  [G3] alsoCatches discloses a NAMELESS unfiled sweep as the single null-merchant line;
  [G4a/b] a `description equals` (not contains) rule suppresses only on an EXACT-match description;
  [G5] the SAME merchant appearing as an unfiled charge AND a hand-filed habit still suggests, and
       its own unfiled charge is not mis-disclosed as an also-catches sweep.

Reuses the same fakes + _suggest helper style as test_filing_suggestions.py so suppression runs
through the real _rule_to_client mapping.
"""

import json

from _feed_fakes import ANZ, _row, FakeFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


def _suggest(handler, repo, taxonomy=("dining", "groceries", "petrol"), rules=()):
    resp = handler.get_filing_suggestions(
        repo, FakeCategoryRepo(set(taxonomy)), FakeRuleRepo(rules))
    assert resp["statusCode"] == 200
    return json.loads(resp["body"])


def _filed(account_id, date, txn_id, merchant, description, category, **extra):
    return _row(account_id, date, txn_id, merchant_name=merchant,
                description=description, category=category, **extra)


def test_equal_distinct_day_tie_between_two_categories_breaks_deterministically(handler):
    # [G1] COLES hand-filed to "groceries" on 4 days AND to "petrol" on 4 DIFFERENT days -> a 4-4
    # tie. It must still be ONE suggestion (two would collide on the shared rule id), and the winner
    # must be deterministic: _winning_category breaks the tie on the category id (min), so
    # "groceries" < "petrol" wins the SAME way on every request regardless of row order.
    rows = (
        [_filed(ANZ, d, f"p{i}", "COLES", "COLES 0342 RICHMOND", "petrol")
         for i, d in enumerate(["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08"])]
        + [_filed(ANZ, d, f"g{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
           for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    )

    body = _suggest(handler, FakeFeedRepo({ANZ: rows}))

    assert len(body["suggestions"]) == 1
    assert body["suggestions"][0]["categoryId"] == "groceries"
    assert body["suggestions"][0]["distinctDays"] == 4


def test_a_hand_filed_charge_with_no_date_is_not_counted_as_a_day(handler):
    # [G2] A charge whose date is missing carries no spending-day signal; _winning_category skips it.
    # Three real distinct days plus one dateless charge = three distinct days = BELOW the threshold.
    # Counting the dateless charge (or crashing on the empty date) would wrongly reach four.
    rows = [
        _filed(ANZ, "2026-07-01", "d1", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining"),
        _filed(ANZ, "2026-07-02", "d2", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining"),
        _filed(ANZ, "2026-07-03", "d3", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining"),
        _filed(ANZ, "", "d4", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining"),
    ]

    assert _suggest(handler, FakeFeedRepo({ANZ: rows}))["suggestions"] == []


def test_a_dateless_charge_does_not_inflate_a_real_four_day_habit(handler):
    # [G2b] The mirror: four REAL distinct days is a habit, and an extra dateless charge for the same
    # shop must not push the count to five. distinctDays stays 4.
    rows = [
        _filed(ANZ, "2026-07-01", "d1", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining"),
        _filed(ANZ, "2026-07-02", "d2", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining"),
        _filed(ANZ, "2026-07-03", "d3", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining"),
        _filed(ANZ, "2026-07-04", "d4", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining"),
        _filed(ANZ, "", "d5", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining"),
    ]

    body = _suggest(handler, FakeFeedRepo({ANZ: rows}))

    assert len(body["suggestions"]) == 1
    assert body["suggestions"][0]["distinctDays"] == 4


def test_alsocatches_discloses_a_nameless_unfiled_sweep_as_a_null_merchant_line(handler):
    # [G3] A "COLES" rule minted from the hand-filed COLES charges would also sweep a still-UNFILED
    # NAMELESS charge whose description contains "coles" (e.g. "PAYPAL *COLES ONLINE"). It has no
    # merchant identity, so it is disclosed as the single null-merchant line, not hidden.
    rows = [_filed(ANZ, d, f"c{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
            for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    rows.append(_row(ANZ, "2026-07-05", "x1", merchant_name="",
                     description="PAYPAL *COLES ONLINE 8842", category=None))

    body = _suggest(handler, FakeFeedRepo({ANZ: rows}))

    suggestion = body["suggestions"][0]
    assert suggestion["rulePattern"] == "COLES"
    assert suggestion["alsoCatches"] == [{"merchant": None, "count": 1}]


def test_a_description_equals_rule_suppresses_only_on_an_exact_match(handler):
    # [G4a] Suppression covers `description equals`, not only `contains`. A rule that equals the
    # charge's whole description matches it (rule_matches over equals) -> suppress.
    repo = FakeFeedRepo({ANZ: [
        _filed(ANZ, d, f"s{i}", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining")
        for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]})
    rules = [{"field": "description", "operator": "equals", "value": "SEDDONS EATERY MELB",
              "category_id": "dining"}]

    assert _suggest(handler, repo, rules=rules)["suggestions"] == []


def test_a_description_equals_rule_that_is_not_exact_does_not_suppress(handler):
    # [G4b] `equals` is an EXACT match, not a substring. A rule `description equals "SEDDONS EATERY"`
    # does NOT equal the fuller "SEDDONS EATERY MELB" charge, so it does not cover it (rule_matches is
    # False); and it does not clash (same category, so the clash branch is skipped — and the clash
    # gate keys on `description contains` anyway) -> the suggestion survives. Guards against an equals
    # rule being mistaken for a contains cover.
    repo = FakeFeedRepo({ANZ: [
        _filed(ANZ, d, f"s{i}", "SEDDONS EATERY", "SEDDONS EATERY MELB", "dining")
        for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]})
    rules = [{"field": "description", "operator": "equals", "value": "SEDDONS EATERY",
              "category_id": "dining"}]

    body = _suggest(handler, repo, rules=rules)

    assert [s["rulePattern"] for s in body["suggestions"]] == ["SEDDONS EATERY"]


def test_a_merchant_both_unfiled_and_hand_filed_still_suggests_without_self_disclosure(handler):
    # [G5] COLES is hand-filed to groceries on 4 days AND has one still-UNFILED COLES charge. The
    # habit is real, so the suggestion stands; and the shop's OWN unfiled charge (same merchant) is
    # NOT disclosed as an also-catches sweep of a "different shop" -- alsoCatches stays empty.
    rows = [_filed(ANZ, d, f"c{i}", "COLES", "COLES 0342 RICHMOND", "groceries")
            for i, d in enumerate(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"])]
    rows.append(_filed(ANZ, "2026-07-09", "u1", "COLES", "COLES 0999 KEW", None))

    body = _suggest(handler, FakeFeedRepo({ANZ: rows}))

    assert len(body["suggestions"]) == 1
    assert body["suggestions"][0]["rulePattern"] == "COLES"
    assert body["suggestions"][0]["categoryId"] == "groceries"
    assert body["suggestions"][0]["alsoCatches"] == []
