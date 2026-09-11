"""ADVERSARIAL gap tests for GET /transactions/uncategorized/merchants (WHIT-515).

These do NOT duplicate tests/lambda_api/test_uncategorized_merchants.py. That suite locks the
happy grouping, the two-level COLES / COLES EXPRESS disclosure, the whole-bucket rule pattern,
the casing winner, the 4-character floor via BP/BPAY, the nameless charge, already-filed
exclusion, the badge predicate's three cases, the deep-page walk, the no-date-floor scan, the
empty history, the route wiring, the POST 404, and the runaway-cursor raise.

What it does NOT lock, and this file does:

  * [A1]  a group's `count` equals what the minted rule would ACTUALLY file, asserted against
          the REAL rule_apply.rule_matches (the function WHIT-516 will write with) rather than
          a hard-coded number. This is the card's load-bearing claim: an overstated count is a
          lie shown immediately before a bulk write.
  * [A2]  `unfiled` equals the real /transactions/uncategorized/count endpoint on the same rows
          and taxonomy — asserted against that endpoint, not against a re-implementation of it.
  * [A3]  groups + ungrouped genuinely PARTITION the eligible charges on messy mixed data:
          every eligible charge is reached by at least one group's pattern or is in `ungrouped`,
          never both, never neither.
  * [A4]  THREE levels of nesting — the widest group discloses BOTH deeper merchants, and each
          level keeps its own group. The impl suite only covers two levels.
  * [A5]  a sweep that comes from a merchant with NO name relationship (NETFLIX vs
          "PAYPAL *NETFLIX") — disclosure must not depend on one merchant name prefixing another.
  * [A6]  MULTIPLE charges with no merchant name swept in by one rule: all of them are in
          `count` and NONE is also in `ungrouped`. (The impl suite's
          test_a_swept_charge_with_no_merchant_name_is_still_disclosed owns the alsoCatches
          LABEL for the single-charge case; this owns the no-double-report arithmetic.)
  * [A8]  alsoCatches is biggest-first with an alphabetical tiebreak.
  * [A9]  the floor counts LETTERS/DIGITS only — punctuation and spaces cannot pad a 2-letter
          merchant past it.
  * [A10] matching is LITERAL — regex/glob metacharacters in a merchant name match nothing but
          themselves.
  * [A11] a blank date is ignored rather than becoming firstDate, and an all-blank group reports
          JSON null dates instead of crashing.
  * [A12] an accent that BankSync stripped from the description leaves that charge ungrouped
          rather than silently inflating the group's count.
  * [A13] a pathological tail of singleton merchants returns every singleton, fully ordered,
          with nothing silently capped.
  * [A14] the endpoint is READ-ONLY — it writes nothing, even against a repo that can write.
  * [A15] a database failure mid-scan propagates instead of degrading into an empty "all caught
          up" response.
  * [A16] under a length-changing fold, the previewed count still equals what rule_apply would
          file. The impl suite's test_a_description_whose_lowercasing_changes_length_yields_no_rule
          owns "no rule is offered"; this owns "and no count lies". Before the fix this fixture
          previewed 2 while the rule filed 3.

Reuses the shared paged date-index fake (_feed_fakes), so this suite is registered in the
`feed` domain tuple of tests/shared/test_fakes_invariants.py.
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, WESTPAC, _row, FakeFeedRepo, WritableFeedRepo


class _TaxonomyRepo:
    def __init__(self, category_ids=()):
        self._categories = [{"id": category_id} for category_id in category_ids]

    def list_categories(self):
        return [dict(category) for category in self._categories]


def _txn(txn_id, merchant, description, date="2026-07-01", category=None, account_id=ANZ):
    return _row(account_id, date, txn_id, merchant_name=merchant,
                description=description, category=category)


def _body(handler, repo, taxonomy=()):
    response = handler.get_uncategorized_merchants(repo, _TaxonomyRepo(taxonomy))
    assert response["statusCode"] == 200
    assert response["headers"]["Content-Type"] == "application/json"
    return json.loads(response["body"])


def _eligible_rows(handler):
    """The messy fixture's charges that still need filing, decided by the handler's OWN
    predicate. Deliberately not re-implemented here: a test that re-derives eligibility would
    keep agreeing with itself while the endpoint drifted away from the badge."""
    return [row for row in _messy_rows()
            if handler._is_unmapped_category(row.get("category"), {"groceries"})]


def _contains_rule(pattern):
    """The leaf rule WHIT-516 would mint from a group — the shape rule_apply evaluates."""
    return {"field": "description", "operator": "contains", "value": pattern,
            "conditionCount": 1, "categoryId": "groceries"}


# A deliberately messy but REALISTIC spread: nested merchants, a merchant that only appears
# inside another's description, a sub-floor merchant, a nameless charge, a charge whose
# description never carries its merchant name, a mixed-case description, and one already-filed
# row. Kept deliberately varied so [A1]/[A2]/[A3] are sensitive to case, nesting AND the
# eligibility predicate at once.
def _messy_rows():
    return [
        _txn("m01", "COLES", "COLES 0342 RICHMOND", "2026-07-10"),
        _txn("m02", "COLES", "COLES 0342 RICHMOND", "2026-07-09"),
        _txn("m03", "COLES", "COLES ONLINE", "2026-07-08"),
        _txn("m04", "COLES EXPRESS", "COLES EXPRESS 1123", "2026-07-07"),
        _txn("m05", "COLES EXPRESS", "COLES EXPRESS 1123", "2026-07-06"),
        _txn("m06", "WOOLWORTHS", "WOOLWORTHS 1234 KEW", "2026-07-05"),
        _txn("m07", "WOOLWORTHS METRO", "WOOLWORTHS METRO 88", "2026-07-04"),
        _txn("m08", "BP", "BP 2210 RICHMOND", "2026-07-03"),
        _txn("m09", "", "OSKO PAYMENT 4471123", "2026-07-02"),
        _txn("m10", "SEDDONS EATERY", "SQ*SEDDON EATRY 4412", "2026-07-01"),
        _txn("m11", "NETFLIX", "NETFLIX.COM 8887", "2026-06-30", account_id=SPENDING),
        _txn("m12", "PAYPAL", "PAYPAL *NETFLIX 7781", "2026-06-29", account_id=SPENDING),
        _txn("m13", "PAYPAL", "PAYPAL *SPOTIFY 1119", "2026-06-28", account_id=SPENDING),
        _txn("m14", "ALDI", "ALDI 771 KEW", "2026-06-27", category="groceries",
             account_id=WESTPAC),
        _txn("m15", "UBER", "UBER TRIP 88A21", "2026-06-26", account_id=WESTPAC),
        _txn("m16", "UBER EATS", "UBER EATS SYDNEY", "2026-06-25", account_id=WESTPAC),
        # A mixed-case description of a merchant whose other rows are upper-case. The winning
        # pattern stays "COLES", so [A1] only holds while the count is computed
        # case-insensitively — exactly as rule_apply._normalise compares.
        _txn("m17", "COLES", "Coles Online Kew", "2026-06-24"),
        # A raw BankSync enum (unfiled by the badge's rule, but NOT a null category) and an
        # income row (filed, never offered). Together they make [A1]/[A2]/[A3] sensitive to the
        # eligibility predicate itself, not just to "category is null".
        _txn("m18", "ALDI", "ALDI 771 KEW", "2026-06-23", category="FOOD_AND_DRINK"),
        _txn("m19", "EMPLOYER PTY", "SALARY EMPLOYER PTY", "2026-06-22", category="income",
             account_id=SPENDING),
    ]


def _messy_repo():
    rows_by_account = {}
    for row in _messy_rows():
        rows_by_account.setdefault(row["account_id"], []).append(row)
    return FakeFeedRepo(rows_by_account)


def test_every_group_count_is_what_the_minted_rule_would_really_file(handler, rule_apply):
    # [A1] FAIL-ON-REVERT for the card's load-bearing claim. Asserted against the REAL
    # rule_apply.rule_matches — the exact function WHIT-516 files with — so a group whose count
    # was computed any other way (merchant-name equality, case-sensitive containment, counting
    # bucket members instead of matches) reddens here. A hard-coded number cannot catch that.
    body = _body(handler, _messy_repo(), taxonomy={"groceries"})
    eligible = _eligible_rows(handler)
    assert body["groups"], "fixture must produce groups or this test passes vacuously"

    divergences = []
    for group in body["groups"]:
        would_file = sum(
            1 for row in eligible
            if rule_apply.rule_matches(_contains_rule(group["rulePattern"]), row)
        )
        if would_file != group["count"]:
            divergences.append((group["rulePattern"], group["count"], would_file))

    assert divergences == [], (
        "a group's count disagrees with what rule_apply would file for its own rulePattern "
        "(pattern, previewed, would-file): " + repr(divergences)
    )


def test_unfiled_equals_the_real_count_endpoint_on_the_same_rows(handler):
    # [A2] FAIL-ON-REVERT for "the same predicate as the badge". Asserted against the count
    # endpoint itself, so a copy of _is_unmapped_category that drifts (or an extra
    # contributes_to_budget gate slipped in here) reddens instead of quietly showing her a
    # screen whose total disagrees with the tab badge.
    taxonomy = {"groceries"}
    badge = json.loads(
        handler.get_uncategorized_count(_messy_repo(), _TaxonomyRepo(taxonomy))["body"]
    )["count"]
    body = _body(handler, _messy_repo(), taxonomy=taxonomy)

    assert badge > 0  # not a vacuous 0 == 0
    assert body["unfiled"] == badge


def test_groups_and_ungrouped_partition_every_eligible_charge(handler):
    # [A3] FAIL-ON-REVERT for "nothing silently dropped". Coverage is recomputed here from the
    # rulePatterns against the RAW rows, independently of grouped_positions, so a bug that
    # forgets to mark a bucket's members as grouped (or drops a bucket without accounting for
    # it) shows up as a mismatch rather than as a plausible-looking smaller number.
    body = _body(handler, _messy_repo(), taxonomy={"groceries"})
    eligible = _eligible_rows(handler)
    patterns = [group["rulePattern"] for group in body["groups"]]

    reached = {
        row["transaction_id"] for row in eligible
        if any(pattern.lower() in row["description"].lower() for pattern in patterns)
    }
    assert body["unfiled"] == len(eligible)
    assert len(reached) + body["ungrouped"]["count"] == body["unfiled"]
    # The ungrouped samples must be charges no pattern reaches — not charges double-reported.
    for sample in body["ungrouped"]["samples"]:
        assert not any(pattern.lower() in sample.lower() for pattern in patterns), sample


def test_three_levels_of_nesting_each_keep_a_group_and_the_wider_ones_disclose_both(handler):
    # [A4] FAIL-ON-REVERT. The impl suite only proves two levels. With three, merging or
    # dropping the middle one is still invisible to it: COLES must disclose BOTH deeper
    # merchants, COLES EXPRESS must disclose the deepest, and all three must survive.
    repo = FakeFeedRepo({ANZ: [
        _txn("c1", "COLES", "COLES 0342 RICHMOND", "2026-07-10"),
        _txn("c2", "COLES", "COLES ONLINE", "2026-07-09"),
        _txn("e1", "COLES EXPRESS", "COLES EXPRESS 1123", "2026-07-08"),
        _txn("e2", "COLES EXPRESS", "COLES EXPRESS 1123", "2026-07-07"),
        _txn("r1", "COLES EXPRESS RICHMOND", "COLES EXPRESS RICHMOND 9", "2026-07-06"),
    ]})

    body = _body(handler, repo)

    assert [(g["rulePattern"], g["count"]) for g in body["groups"]] == [
        ("COLES", 5), ("COLES EXPRESS", 3), ("COLES EXPRESS RICHMOND", 1),
    ]
    assert body["groups"][0]["alsoCatches"] == [
        {"merchant": "COLES EXPRESS", "count": 2},
        {"merchant": "COLES EXPRESS RICHMOND", "count": 1},
    ]
    assert body["groups"][1]["alsoCatches"] == [
        {"merchant": "COLES EXPRESS RICHMOND", "count": 1},
    ]
    assert body["groups"][2]["alsoCatches"] == []
    assert body["ungrouped"]["count"] == 0


def test_a_sweep_from_an_unrelated_merchant_is_still_disclosed(handler):
    # [A5] FAIL-ON-REVERT. COLES/COLES EXPRESS share a name prefix, so a disclosure built on
    # merchant-name prefixes would pass the impl suite. Here NETFLIX and PAYPAL share nothing —
    # the sweep exists only because PayPal spells the merchant into its own description. Filing
    # the NETFLIX group also files a PayPal charge, and she has to be told.
    repo = FakeFeedRepo({ANZ: [
        _txn("n1", "NETFLIX", "NETFLIX.COM 8887", "2026-07-10"),
        _txn("p1", "PAYPAL", "PAYPAL *NETFLIX 7781", "2026-07-09"),
        _txn("p2", "PAYPAL", "PAYPAL *SPOTIFY 1119", "2026-07-08"),
    ]})

    body = _body(handler, repo)

    netflix = next(g for g in body["groups"] if g["rulePattern"] == "NETFLIX")
    assert netflix["count"] == 2
    assert netflix["alsoCatches"] == [{"merchant": "PAYPAL", "count": 1}]
    paypal = next(g for g in body["groups"] if g["rulePattern"] == "PAYPAL")
    assert paypal["count"] == 2
    assert body["ungrouped"]["count"] == 0


def test_nameless_charges_a_rule_sweeps_in_are_counted_once_and_not_also_ungrouped(handler):
    # [A6] FAIL-ON-REVERT for the honest count. A direct-debit row with no merchant name still
    # carries "COLES" in its description, so the COLES rule really will file it: it belongs in
    # `count`. It must NOT also appear in `ungrouped` — that would double-report it and make
    # the screen's totals exceed the badge.
    repo = FakeFeedRepo({ANZ: [
        _txn("c1", "COLES", "COLES 0342 RICHMOND", "2026-07-10"),
        _txn("c2", "COLES", "COLES 0999 KEW", "2026-07-09"),
        _txn("x1", "", "COLES 1111 DIRECT DEBIT", "2026-07-08"),
        _txn("x2", None, "COLES 2222 DIRECT DEBIT", "2026-07-07"),
    ]})

    body = _body(handler, repo)

    assert [(g["rulePattern"], g["count"]) for g in body["groups"]] == [("COLES", 4)]
    assert body["unfiled"] == 4
    assert body["ungrouped"] == {"count": 0, "samples": []}


def test_also_catches_is_biggest_first_with_an_alphabetical_tiebreak(handler):
    # [A8] FAIL-ON-REVERT. The impl suite only ever has ONE entry in alsoCatches, so its order
    # is unconstrained there. The biggest sweep is the one she most needs to see first, and two
    # equal sweeps must not reorder between requests.
    repo = FakeFeedRepo({ANZ: [
        _txn("u0", "UBER", "UBER TRIP 1", "2026-07-10"),
        _txn("u1", "UBER RIDES", "UBER RIDES 1", "2026-07-09"),
        _txn("u2", "UBER EATS", "UBER EATS 1", "2026-07-08"),
        _txn("u3", "UBER EATS", "UBER EATS 2", "2026-07-07"),
        _txn("u4", "UBER CARSHARE", "UBER CARSHARE 1", "2026-07-06"),
    ]})

    body = _body(handler, repo)

    uber = next(g for g in body["groups"] if g["rulePattern"] == "UBER")
    assert uber["count"] == 5
    assert uber["alsoCatches"] == [
        {"merchant": "UBER EATS", "count": 2},
        {"merchant": "UBER CARSHARE", "count": 1},
        {"merchant": "UBER RIDES", "count": 1},
    ]


@pytest.mark.parametrize("merchant, description, is_safe", [
    ("A&B*", "A&B* 1188 MELB", False),        # 4 characters, only 2 letters/digits
    ("7-11", "7-11 RICHMOND", False),          # 4 characters, only 3 letters/digits
    ("  BP  ", "BP 2210 RICHMOND", False),     # padded with spaces, still 2 letters/digits
    ("7-ELEVEN", "7-ELEVEN 2210", True),       # 7 letters/digits
    ("ALDI", "ALDI 771 KEW", True),            # exactly at the floor
])
def test_the_floor_counts_letters_and_digits_only(handler, merchant, description, is_safe):
    # [A9] FAIL-ON-REVERT for the floor's definition. The impl suite's BP/BPAY case passes just
    # as well against a plain len(value) >= 4 check; these do not. "A&B*" and "7-11" are four
    # characters long, and a rule on either would sweep far more than the merchant.
    repo = FakeFeedRepo({ANZ: [
        _txn("f1", merchant, description, "2026-07-10"),
        _txn("f2", merchant, description, "2026-07-09"),
    ]})

    body = _body(handler, repo)

    assert bool(body["groups"]) is is_safe
    assert body["ungrouped"]["count"] == (0 if is_safe else 2)


def test_matching_is_literal_not_a_regular_expression(handler):
    # [A10] FAIL-ON-REVERT. A merchant name full of regex metacharacters must match only itself.
    # If the containment test were ever swapped for re.search, ".*" would sweep in every other
    # charge and she would file her whole history in one tap.
    repo = FakeFeedRepo({ANZ: [
        _txn("g1", "A.*B (PTY)", "A.*B (PTY) 1188", "2026-07-10"),
        _txn("g2", "A.*B (PTY)", "A.*B (PTY) 9911", "2026-07-09"),
        _txn("g3", "AXXB PTY", "AXXB PTY LTD 42", "2026-07-08"),
        _txn("g4", "AXXB PTY", "AXXB PTY LTD 43", "2026-07-07"),
    ]})

    body = _body(handler, repo)

    regexish = next(g for g in body["groups"] if g["rulePattern"] == "A.*B (PTY)")
    assert regexish["count"] == 2
    assert regexish["alsoCatches"] == []


def test_a_blank_date_is_ignored_rather_than_becoming_the_first_date(handler):
    # [A11] FAIL-ON-REVERT. _row always sets a date, so the impl suite never sees a row without
    # one. A blank date sorts before every real date: drop the falsy filter and firstDate
    # becomes "", which renders as an empty "since" line on the group.
    repo = FakeFeedRepo({ANZ: [
        _txn("d1", "WOOLWORTHS", "WOOLWORTHS 1234 KEW", "2026-07-10"),
        _txn("d2", "WOOLWORTHS", "WOOLWORTHS 9987 KEW", "2026-07-08"),
        _txn("d3", "WOOLWORTHS", "WOOLWORTHS ONLINE", ""),
    ]})

    body = _body(handler, repo)

    group = body["groups"][0]
    assert group["count"] == 3
    assert (group["firstDate"], group["lastDate"]) == ("2026-07-08", "2026-07-10")


def test_a_group_with_no_dates_at_all_reports_json_null_not_a_crash(handler):
    # [A11] The all-blank variant: the group still exists and still carries a true count; the
    # dates come back as JSON null, which the app can render as "no date" rather than "".
    repo = FakeFeedRepo({ANZ: [
        _txn("d1", "WOOLWORTHS", "WOOLWORTHS 1234 KEW", ""),
        _txn("d2", "WOOLWORTHS", "WOOLWORTHS 9987 KEW", ""),
    ]})

    body = _body(handler, repo)

    assert body["groups"][0]["count"] == 2
    assert body["groups"][0]["firstDate"] is None
    assert body["groups"][0]["lastDate"] is None


def test_an_accent_the_bank_stripped_leaves_that_charge_ungrouped_not_counted(handler):
    # [A12] FAIL-ON-REVERT for the honest count under real-world accent handling. All three
    # charges are the same cafe and land in one merchant bucket, but the rule
    # `description contains "CAFÉ VUE"` genuinely will NOT file the row the bank wrote without
    # the accent. So the group counts 2, not 3, and the odd one is disclosed as ungrouped —
    # anything else promises a write that will not happen.
    repo = FakeFeedRepo({ANZ: [
        _txn("v1", "CAFÉ VUE", "CAFÉ VUE 0021", "2026-07-10"),
        _txn("v2", "CAFÉ VUE", "CAFÉ VUE 0022", "2026-07-09"),
        _txn("v3", "Café Vue", "CAFE VUE 0023", "2026-07-08"),
    ]})

    body = _body(handler, repo)

    assert [(g["rulePattern"], g["count"]) for g in body["groups"]] == [("CAFÉ VUE", 2)]
    assert body["ungrouped"] == {"count": 1, "samples": ["CAFE VUE 0023"]}


def test_a_long_tail_of_singleton_merchants_is_returned_whole_and_fully_ordered(handler):
    # [A13] The realistic pathological shape: hundreds of merchants seen exactly once. Nothing
    # is capped (a silent cap would hide the tail she is here to clear) and the order is total —
    # every count is 1, so the pattern tiebreak alone decides it. Drop the tiebreak and this
    # reddens.
    rows = [_txn(f"t{index:03d}", f"MERCHANT {index:03d}", f"MERCHANT {index:03d} SHOP",
                 f"2026-0{(index % 9) + 1}-15")
            for index in range(250)]
    body = _body(handler, FakeFeedRepo({ANZ: rows}))

    patterns = [group["rulePattern"] for group in body["groups"]]
    assert len(patterns) == 250
    assert patterns == sorted(patterns)
    assert {group["count"] for group in body["groups"]} == {1}
    assert body["unfiled"] == 250
    assert body["ungrouped"]["count"] == 0


def test_the_endpoint_writes_nothing(handler):
    # [A14] FAIL-ON-REVERT for "read-only". WritableFeedRepo can really write, so an
    # auto-file slipped into this read path (or a repository call that mutates as a side
    # effect) reddens here instead of silently re-categorising her history on a GET.
    repo = WritableFeedRepo({ANZ: [
        _txn("c1", "COLES", "COLES 0342 RICHMOND", "2026-07-10"),
        _txn("c2", "COLES", "COLES ONLINE", "2026-07-09"),
    ]})

    body = _body(handler, repo)

    assert body["groups"][0]["count"] == 2
    assert repo.writes == []


def test_a_database_failure_mid_scan_is_not_swallowed_into_all_caught_up(handler):
    # [A15] FAIL-ON-REVERT. The dangerous failure mode for a read that must reconcile with the
    # badge is a silent one: swallow the error, return zero groups, and the screen says "all
    # caught up" while hundreds of charges wait. The error must reach the caller.
    class _FailsOnSecondPage:
        def __init__(self):
            self.calls = 0

        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
            self.calls += 1
            if self.calls == 1:
                page = [_txn("c1", "COLES", "COLES 0342 RICHMOND", "2026-07-10")]
                return page, {"pk": f"ACCOUNT#{account_id}", "sk": "TXN#c1"}
            raise RuntimeError("dynamodb unavailable")

    with pytest.raises(RuntimeError, match="dynamodb unavailable"):
        handler.get_uncategorized_merchants(_FailsOnSecondPage(), _TaxonomyRepo())


def test_a_length_changing_fold_never_lets_the_preview_disagree_with_the_rule(
    handler, rule_apply
):
    # [A16] FAIL-ON-REVERT, and the sharper half of the "İ" case. The impl suite proves no rule
    # is offered for İMERCHANT. This proves the thing that actually burns her: before the fix
    # this fixture offered a rule on "OLES " — with a trailing space — which previewed 2 charges
    # while rule_apply (which STRIPS a rule value) would have filed 3. A shifted slice does not
    # just look wrong; it makes the number lie one tap before a bulk write.
    rows = [
        _txn("u1", "COLES", "İ MART COLES 123", "2026-07-10"),
        _txn("u2", "COLES", "İ MART COLES", "2026-07-09"),
        _txn("u3", "COLES", "İ MART COLES 456", "2026-07-08"),
    ]
    body = _body(handler, FakeFeedRepo({ANZ: rows}))

    # Pinned exactly so this can never pass merely because there was nothing to iterate.
    assert body["unfiled"] == 3
    assert len(body["groups"]) + body["ungrouped"]["count"] == 3

    for group in body["groups"]:
        would_file = sum(1 for row in rows
                         if rule_apply.rule_matches(_contains_rule(group["rulePattern"]), row))
        assert would_file == group["count"], (
            f"pattern {group['rulePattern']!r} previews {group['count']} but files {would_file}"
        )
