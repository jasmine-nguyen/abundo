"""Tests for GET /transactions/uncategorized/merchants (WHIT-515) — the charges that still
need filing, grouped by merchant, biggest group first.

"Apply my rules" can only file what an existing rule covers. What is left is merchants the
user has never written a rule for, and hundreds of those is the problem this endpoint exists
to shrink: N charges is nowhere near N merchants.

The counts here are load-bearing — WHIT-516 mints a rule from a group and writes with it — so
a group's count is what its rule would ACTUALLY file, evaluated the same literal
`description contains VALUE` way rule_engine does. That is why COLES reports 50 when 12 of them
are really COLES EXPRESS, and why it also has to say so.

Runs the real TransactionRepository over a FakeTable so the deep-page case (a merchant whose
charges sit beyond page 1) is genuinely exercised — the same reason the count suite does.
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, WESTPAC, FakeCategoryRepo, date_reads, real_repos, _row


def _groups(handler, repo, taxonomy=()):
    resp = handler.get_uncategorized_merchants(repo, FakeCategoryRepo(set(taxonomy)))
    assert resp["statusCode"] == 200
    return json.loads(resp["body"])


def _charge(account_id, date, txn_id, merchant, description, category=None):
    return _row(account_id, date, txn_id, merchant_name=merchant,
                description=description, category=category)


def test_groups_unfiled_charges_by_merchant_biggest_first(handler):
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "a1", "WOOLWORTHS", "WOOLWORTHS 1234 KEW"),
        _charge(ANZ, "2026-07-09", "a2", "WOOLWORTHS", "WOOLWORTHS 9987 KEW"),
        _charge(ANZ, "2026-07-08", "a3", "WOOLWORTHS", "WOOLWORTHS ONLINE"),
        _charge(ANZ, "2026-07-07", "a4", "NETFLIX", "NETFLIX SUBSCRIPTION"),
    ]})

    body = _groups(handler, repo)

    assert body["unfiled"] == 4
    assert [(group["merchant"], group["count"]) for group in body["groups"]] == [
        ("WOOLWORTHS", 3), ("NETFLIX", 1),
    ]
    woolworths = body["groups"][0]
    assert woolworths["rulePattern"] == "WOOLWORTHS"
    assert woolworths["samples"] == ["WOOLWORTHS 1234 KEW", "WOOLWORTHS 9987 KEW",
                                     "WOOLWORTHS ONLINE"]
    assert (woolworths["firstDate"], woolworths["lastDate"]) == ("2026-07-08", "2026-07-10")
    assert body["ungrouped"] == {"count": 0, "samples": []}


def test_rule_pattern_comes_from_the_whole_group_not_one_row(handler):
    # FAIL-ON-REVERT. The NEWEST charge's description doesn't contain the merchant name at all,
    # so it yields no clean slice. Deriving the rule from one representative row would pick
    # that one and collapse a 3-charge group to nothing; deriving it from the whole group keeps
    # the group and leaves the odd row out rather than mis-filing it.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "s0", "SEDDONS EATERY", "SQ*SEDDON EATRY 4412"),
        _charge(ANZ, "2026-07-09", "s1", "SEDDONS EATERY", "SEDDONS EATERY MELB"),
        _charge(ANZ, "2026-07-08", "s2", "SEDDONS EATERY", "SEDDONS EATERY MELB"),
        _charge(ANZ, "2026-07-07", "s3", "SEDDONS EATERY", "SEDDONS EATERY CBD"),
    ]})

    body = _groups(handler, repo)

    assert len(body["groups"]) == 1
    assert body["groups"][0]["rulePattern"] == "SEDDONS EATERY"
    assert body["groups"][0]["count"] == 3
    assert body["ungrouped"] == {"count": 1, "samples": ["SQ*SEDDON EATRY 4412"]}


def test_rule_pattern_casing_follows_the_commonest_description(handler):
    # The pattern keeps the DESCRIPTION's casing (so the match works whichever way BankSync
    # compares), and picks the commonest spelling so the same data always mints the same rule.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "k1", "COLES", "Coles Online"),
        _charge(ANZ, "2026-07-09", "k2", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-08", "k3", "COLES", "COLES 0342 RICHMOND"),
    ]})

    body = _groups(handler, repo)

    assert body["groups"][0]["rulePattern"] == "COLES"
    assert body["groups"][0]["count"] == 3  # matching stays case-insensitive


def test_nameless_charges_sharing_wording_become_one_actionable_group(handler):
    # WHIT-519: the card's own example. Three OSKO payments carry no merchant name and a
    # different reference each, so they never form a merchant group. Trimming the trailing
    # reference leaves "OSKO PAYMENT", which repeats -> one actionable group, tagged as
    # grouped-by-wording, and the pile is cleared.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "o1", "", "OSKO PAYMENT 4471123"),
        _charge(ANZ, "2026-07-09", "o2", "", "OSKO PAYMENT 4471124"),
        _charge(ANZ, "2026-07-08", "o3", "", "OSKO PAYMENT 4471125"),
    ]})

    body = _groups(handler, repo)

    assert len(body["groups"]) == 1
    group = body["groups"][0]
    assert group["rulePattern"] == "OSKO PAYMENT"
    assert group["merchant"] == "OSKO PAYMENT"
    assert group["groupedBy"] == "description"
    assert group["count"] == 3
    assert group["alsoCatches"] == []
    assert body["ungrouped"] == {"count": 0, "samples": []}


def test_a_lone_nameless_wording_stays_in_the_pile(handler):
    # FAIL-ON-REVERT for MIN_DESCRIPTION_GROUP_SIZE. A wording seen once is one charge; grouping
    # it would be the one-group-per-charge explosion. Set the minimum to 1 and this reddens.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "o1", "", "OSKO PAYMENT 4471123"),
        _charge(ANZ, "2026-07-09", "w1", "WOOLWORTHS", "WOOLWORTHS 1234 KEW"),
    ]})

    body = _groups(handler, repo)

    assert [group["rulePattern"] for group in body["groups"]] == ["WOOLWORTHS"]
    # The nameless charge is not dropped: it stays in `ungrouped` and in `unfiled`.
    assert body["unfiled"] == 2
    assert body["ungrouped"] == {"count": 1, "samples": ["OSKO PAYMENT 4471123"]}


def test_wording_groups_do_not_merge_to_the_shared_opening(handler):
    # FAIL-ON-REVERT against direction B's failure mode. Two DoorDash holds and two Uber holds
    # all open "POS AUTHORISATION" — but trimming only the trailing reference keeps the payee,
    # so they form TWO specific groups, never one "POS AUTHORISATION" rule that files every
    # pending card hold as one thing.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "d1", "", "POS AUTHORISATION   DD *DOORDASH   +611800958316AU"),
        _charge(ANZ, "2026-07-09", "d2", "", "POS AUTHORISATION   DD *DOORDASH   +611800958317AU"),
        _charge(ANZ, "2026-07-08", "u1", "", "POS AUTHORISATION   DD *UBER   +611800111222AU"),
        _charge(ANZ, "2026-07-07", "u2", "", "POS AUTHORISATION   DD *UBER   +611800111333AU"),
    ]})

    body = _groups(handler, repo)

    patterns = sorted(group["rulePattern"] for group in body["groups"])
    assert patterns == ["POS AUTHORISATION   DD *DOORDASH", "POS AUTHORISATION   DD *UBER"]
    assert all(group["count"] == 2 for group in body["groups"])
    assert body["ungrouped"]["count"] == 0


def test_a_digit_only_stem_mints_no_rule(handler):
    # FAIL-ON-REVERT for the letter guard. A PayID-to-phone leaves a stem of pure digits; a rule
    # on "0412" would file every charge carrying that run (COLES 0412 RICHMOND). Drop the
    # "must contain a letter" guard in _description_stem and this reddens.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "n1", "", "0412 345 678"),
        _charge(ANZ, "2026-07-09", "n2", "", "0412 345 678"),
        _charge(ANZ, "2026-07-08", "c1", "COLES", "COLES 0412 RICHMOND"),
    ]})

    body = _groups(handler, repo)

    assert [group["rulePattern"] for group in body["groups"]] == ["COLES"]
    assert body["ungrouped"]["count"] == 2  # the two nameless phone-number rows


def test_a_nameless_stem_too_short_to_rule_on_stays_in_the_pile(handler):
    # FAIL-ON-REVERT: the 4-letters/digits floor guards wording groups too. Two nameless "BP"
    # holds trim to the stem "BP" (2 alnums) — a rule on that would file every BPAY transfer as
    # petrol. Drop the floor check in _description_stem and this reddens.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "b1", "", "BP 4471123"),
        _charge(ANZ, "2026-07-09", "b2", "", "BP 4471124"),
    ]})

    body = _groups(handler, repo)

    assert body["groups"] == []
    assert body["ungrouped"]["count"] == 2


def test_a_wording_group_discloses_a_named_merchant_it_reaches(handler):
    # The only route out for a merchant name too short to slice today: nameless "SQ*SEDDON EATRY"
    # holds form a wording group, and a named SEDDONS EATERY charge whose description carries the
    # same stem is disclosed (named), each keeping its own group.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "s1", "", "SQ*SEDDON EATRY 4412"),
        _charge(ANZ, "2026-07-09", "s2", "", "SQ*SEDDON EATRY 4413"),
        _charge(ANZ, "2026-07-08", "n1", "SEDDONS EATERY", "SQ*SEDDON EATRY 4414"),
    ]})

    body = _groups(handler, repo)

    stem_group = next(g for g in body["groups"] if g["groupedBy"] == "description")
    assert stem_group["rulePattern"] == "SQ*SEDDON EATRY"
    assert stem_group["count"] == 3
    assert stem_group["alsoCatches"] == [{"merchant": "SEDDONS EATERY", "count": 1}]


def test_already_filed_charges_are_excluded_everywhere(handler):
    # FAIL-ON-REVERT. A charge she has already filed must not swell a group's count, must not
    # appear in alsoCatches, and must not be in `unfiled` — otherwise the preview promises
    # writes that WHIT-508's conditional write will refuse.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "c1", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-09", "c2", "COLES", "COLES 0342 RICHMOND", category="groceries"),
        _charge(ANZ, "2026-07-08", "e1", "COLES EXPRESS", "COLES EXPRESS 1123",
                category="groceries"),
    ]})

    body = _groups(handler, repo, taxonomy={"groceries"})

    assert body["unfiled"] == 1
    assert [(group["rulePattern"], group["count"]) for group in body["groups"]] == [("COLES", 1)]
    assert body["groups"][0]["alsoCatches"] == []


def test_unfiled_uses_the_same_rule_as_the_badge(handler):
    # The same predicate get_uncategorized_count uses: a raw BankSync enum counts, income does
    # not, and an excluded transfer still counts (WHIT-330). If these drifted, the screen would
    # offer to file charges the badge doesn't count, or miss ones it does.
    table, repo, _ = real_repos({
        ANZ: [_charge(ANZ, "2026-07-10", "r1", "ALDI", "ALDI 771 KEW", category="FOOD_AND_DRINK")],
        SPENDING: [_charge(SPENDING, "2026-07-09", "i1", "EMPLOYER", "SALARY", category="income")],
        WESTPAC: [_row(WESTPAC, "2026-07-08", "t1", merchant_name="ANZ TRANSFER",
                       description="ANZ TRANSFER TO SAVINGS", category=None,
                       counts_to_budget=False, budget_excluded=True)],
    })

    body = _groups(handler, repo, taxonomy={"groceries"})

    assert body["unfiled"] == 2  # the raw enum and the excluded transfer; never the income row
    assert sorted(group["rulePattern"] for group in body["groups"]) == ["ALDI", "ANZ TRANSFER"]


def test_groups_a_merchant_whose_charges_sit_beyond_the_first_page(handler):
    # The WHIT-506 lesson: these charges live deep in the tail. The scan must page each account
    # to the end, or the biggest groups are exactly the ones missed.
    rows = [_charge(ANZ, f"2026-05-{(index % 28) + 1:02d}", f"f{index}", "WOOLWORTHS",
                    "WOOLWORTHS 1234 KEW", category="groceries")
            for index in range(120)]
    rows.append(_charge(ANZ, "2020-01-02", "old1", "ALDI", "ALDI 771 KEW"))
    rows.append(_charge(ANZ, "2020-01-01", "old2", "ALDI", "ALDI 771 KEW"))
    table, repo, _ = real_repos({ANZ: rows})

    body = _groups(handler, repo, taxonomy={"groceries"})

    assert [(group["rulePattern"], group["count"]) for group in body["groups"]] == [("ALDI", 2)]
    assert len([call for call in date_reads(table) if call[0] == ANZ]) > 1  # genuinely paged


def test_a_description_whose_lowercasing_changes_length_yields_no_rule(handler):
    # Lowercasing "İ" produces TWO characters, so a position found in the lowered description
    # points past where the shop name really starts in the original. Here that slides the slice
    # off "MERCHANT" onto "ERCHANT " — a rule that would match charges at random. Better to
    # leave these unfiled than to offer a rule built on a misread.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "u1", "MERCHANT", "İMERCHANT 123"),
        _charge(ANZ, "2026-07-09", "u2", "MERCHANT", "İMERCHANT 456"),
    ]})

    body = _groups(handler, repo)

    assert body["groups"] == []
    assert body["ungrouped"]["count"] == 2


def test_swept_charges_with_no_merchant_name_share_one_disclosure_line(handler):
    # FAIL-ON-REVERT, both ways. The disclosure has to cover the messy descriptions —
    # "PAYPAL *COLES ONLINE" carries no merchant name but a COLES rule files it just the same —
    # AND it has to stay readable: those descriptions carry a per-charge reference, so naming
    # them individually would turn the warning into one line per charge.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "c1", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-09", "c2", "COLES", "COLES ONLINE"),
        _charge(ANZ, "2026-07-08", "p1", "", "PAYPAL *COLES ONLINE 0001"),
        _charge(ANZ, "2026-07-07", "p2", "", "PAYPAL *COLES ONLINE 0002"),
        _charge(ANZ, "2026-07-06", "p3", "", "PAYPAL *COLES ONLINE 0003"),
    ]})

    body = _groups(handler, repo)

    coles = body["groups"][0]
    assert coles["count"] == 5
    # One entry with no name, not one per description: those descriptions carry a per-charge
    # reference, so keying them by description would make 300 swept charges 300 warning lines.
    assert coles["alsoCatches"] == [{"merchant": None, "count": 3}]


def _eligible_rows(handler):
    """The messy fixture's charges that still need filing, decided by the handler's OWN
    predicate. Deliberately not re-implemented here: a test that re-derives eligibility would
    keep agreeing with itself while the endpoint drifted away from the badge."""
    return [row for row in _messy_rows()
            if handler.is_unfiled_category(row.get("category"), {"groceries"})]


def _contains_rule(pattern):
    """The leaf rule WHIT-516 would mint from a group — the shape rule_engine evaluates."""
    return {"field": "description", "operator": "contains", "value": pattern,
            "categoryId": "groceries"}


def _would_file(rule_engine, rows, pattern):
    """How many rows the rule minted from this group's pattern would really file."""
    return sum(1 for row in rows if rule_engine.rule_matches(_contains_rule(pattern), row))


# A deliberately messy but REALISTIC spread: nested merchants, a merchant that only appears
# inside another's description, a sub-floor merchant, a nameless charge, a charge whose
# description never carries its merchant name, a mixed-case description, and one already-filed
# row. Kept deliberately varied so [A1]/[A2]/[A3] are sensitive to case, nesting AND the
# eligibility predicate at once.
def _messy_rows():
    return [
        _charge(ANZ, "2026-07-10", "m01", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-09", "m02", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-08", "m03", "COLES", "COLES ONLINE"),
        _charge(ANZ, "2026-07-07", "m04", "COLES EXPRESS", "COLES EXPRESS 1123"),
        _charge(ANZ, "2026-07-06", "m05", "COLES EXPRESS", "COLES EXPRESS 1123"),
        _charge(ANZ, "2026-07-05", "m06", "WOOLWORTHS", "WOOLWORTHS 1234 KEW"),
        _charge(ANZ, "2026-07-04", "m07", "WOOLWORTHS METRO", "WOOLWORTHS METRO 88"),
        _charge(ANZ, "2026-07-03", "m08", "BP", "BP 2210 RICHMOND"),
        _charge(ANZ, "2026-07-02", "m09", "", "OSKO PAYMENT 4471123"),
        _charge(ANZ, "2026-07-01", "m10", "SEDDONS EATERY", "SQ*SEDDON EATRY 4412"),
        _charge(SPENDING, "2026-06-30", "m11", "NETFLIX", "NETFLIX.COM 8887"),
        _charge(SPENDING, "2026-06-29", "m12", "PAYPAL", "PAYPAL *NETFLIX 7781"),
        _charge(SPENDING, "2026-06-28", "m13", "PAYPAL", "PAYPAL *SPOTIFY 1119"),
        _charge(WESTPAC, "2026-06-27", "m14", "ALDI", "ALDI 771 KEW", category="groceries"),
        _charge(WESTPAC, "2026-06-26", "m15", "UBER", "UBER TRIP 88A21"),
        _charge(WESTPAC, "2026-06-25", "m16", "UBER EATS", "UBER EATS SYDNEY"),
        # A mixed-case description of a merchant whose other rows are upper-case. The winning
        # pattern stays "COLES", so [A1] only holds while the count is computed
        # case-insensitively — exactly as rule_engine._normalise compares.
        _charge(ANZ, "2026-06-24", "m17", "COLES", "Coles Online Kew"),
        # A raw BankSync enum (unfiled by the badge's rule, but NOT a null category) and an
        # income row (filed, never offered). Together they make [A1]/[A2]/[A3] sensitive to the
        # eligibility predicate itself, not just to "category is null".
        _charge(ANZ, "2026-06-23", "m18", "ALDI", "ALDI 771 KEW", category="FOOD_AND_DRINK"),
        _charge(SPENDING, "2026-06-22", "m19", "EMPLOYER PTY", "SALARY EMPLOYER PTY", category="income"),
        # The punctuation trap: stripped of punctuation, "nicolescafe" contains "coles". A COLES
        # rule must not reach these, and the COLES group count must not include them.
        _charge(ANZ, "2026-06-21", "m20", "NICOLE'S CAFE", "NICOLE'S CAFE BRUNSWICK"),
        _charge(ANZ, "2026-06-20", "m21", "NICOLE'S CAFE", "NICOLE'S CAFE BRUNSWICK"),
    ]


def _account_rows(table, account_id):
    """The stored rows of one account."""
    return [row for row in table.store.values() if row.get("account_id") == account_id]


def _messy_repo():
    rows_by_account = {}
    for row in _messy_rows():
        rows_by_account.setdefault(row["account_id"], []).append(row)
    return real_repos(rows_by_account)[1]


def test_every_group_count_is_what_the_minted_rule_would_really_file(handler, rule_engine):
    # [A1] FAIL-ON-REVERT for the card's load-bearing claim. Asserted against the REAL
    # rule_engine.rule_matches — the exact function WHIT-516 files with — so a group whose count
    # was computed any other way (merchant-name equality, case-sensitive containment, counting
    # bucket members instead of matches) reddens here. A hard-coded number cannot catch that.
    body = _groups(handler, _messy_repo(), taxonomy={"groceries"})
    eligible = _eligible_rows(handler)
    assert body["groups"], "fixture must produce groups or this test passes vacuously"

    divergences = []
    for group in body["groups"]:
        would_file = _would_file(rule_engine, eligible, group["rulePattern"])
        if would_file != group["count"]:
            divergences.append((group["rulePattern"], group["count"], would_file))

    assert divergences == [], (
        "a group's count disagrees with what rule_engine would file for its own rulePattern "
        "(pattern, previewed, would-file): " + repr(divergences)
    )


def test_groups_and_ungrouped_partition_every_eligible_charge(handler):
    # [A3] FAIL-ON-REVERT for "nothing silently dropped". Coverage is recomputed here from the
    # rulePatterns against the RAW rows, independently of grouped_positions, so a bug that
    # forgets to mark a bucket's members as grouped (or drops a bucket without accounting for
    # it) shows up as a mismatch rather than as a plausible-looking smaller number.
    body = _groups(handler, _messy_repo(), taxonomy={"groceries"})
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
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "c1", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-09", "c2", "COLES", "COLES ONLINE"),
        _charge(ANZ, "2026-07-08", "e1", "COLES EXPRESS", "COLES EXPRESS 1123"),
        _charge(ANZ, "2026-07-07", "e2", "COLES EXPRESS", "COLES EXPRESS 1123"),
        _charge(ANZ, "2026-07-06", "r1", "COLES EXPRESS RICHMOND", "COLES EXPRESS RICHMOND 9"),
    ]})

    body = _groups(handler, repo)

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
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "n1", "NETFLIX", "NETFLIX.COM 8887"),
        _charge(ANZ, "2026-07-09", "p1", "PAYPAL", "PAYPAL *NETFLIX 7781"),
        _charge(ANZ, "2026-07-08", "p2", "PAYPAL", "PAYPAL *SPOTIFY 1119"),
    ]})

    body = _groups(handler, repo)

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
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "c1", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-09", "c2", "COLES", "COLES 0999 KEW"),
        _charge(ANZ, "2026-07-08", "x1", "", "COLES 1111 DIRECT DEBIT"),
        _charge(ANZ, "2026-07-07", "x2", None, "COLES 2222 DIRECT DEBIT"),
    ]})

    body = _groups(handler, repo)

    assert [(g["rulePattern"], g["count"]) for g in body["groups"]] == [("COLES", 4)]
    assert body["unfiled"] == 4
    assert body["ungrouped"] == {"count": 0, "samples": []}


@pytest.mark.parametrize("merchant, description, is_safe", [
    ("A&B*", "A&B* 1188 MELB", False),        # 4 characters, only 2 letters/digits
    ("7-11", "7-11 RICHMOND", False),          # 4 characters, only 3 letters/digits
    ("  BP  ", "BP 2210 RICHMOND", False),     # padded with spaces, still 2 letters/digits
    ("7-ELEVEN", "7-ELEVEN 2210", True),       # 7 letters/digits
    ("ALDI", "ALDI 771 KEW", True),            # exactly at the floor
    ("BPAY", "BPAY BILL 88213", True),         # clears the floor; "BP" (above) would file every BPAY
])
def test_the_floor_counts_letters_and_digits_only(handler, merchant, description, is_safe):
    # [A9] FAIL-ON-REVERT for the floor's definition. The impl suite's BP/BPAY case passes just
    # as well against a plain len(value) >= 4 check; these do not. "A&B*" and "7-11" are four
    # characters long, and a rule on either would sweep far more than the merchant.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "f1", merchant, description),
        _charge(ANZ, "2026-07-09", "f2", merchant, description),
    ]})

    body = _groups(handler, repo)

    assert bool(body["groups"]) is is_safe
    assert body["ungrouped"]["count"] == (0 if is_safe else 2)


def test_a_length_changing_fold_never_lets_the_preview_disagree_with_the_rule(
    handler, rule_engine
):
    # [A16] FAIL-ON-REVERT, and the sharper half of the "İ" case. The impl suite proves no rule
    # is offered for İMERCHANT. This proves the thing that actually burns her: before the fix
    # this fixture offered a rule on "OLES " — with a trailing space — which previewed 2 charges
    # while rule_engine (which STRIPS a rule value) would have filed 3. A shifted slice does not
    # just look wrong; it makes the number lie one tap before a bulk write.
    rows = [
        _charge(ANZ, "2026-07-10", "u1", "COLES", "İ MART COLES 123"),
        _charge(ANZ, "2026-07-09", "u2", "COLES", "İ MART COLES"),
        _charge(ANZ, "2026-07-08", "u3", "COLES", "İ MART COLES 456"),
    ]
    body = _groups(handler, real_repos({ANZ: rows})[1])

    # Pinned exactly so this can never pass merely because there was nothing to iterate.
    assert body["unfiled"] == 3
    assert len(body["groups"]) + body["ungrouped"]["count"] == 3

    for group in body["groups"]:
        would_file = _would_file(rule_engine, rows, group["rulePattern"])
        assert would_file == group["count"], (
            f"pattern {group['rulePattern']!r} previews {group['count']} but files {would_file}"
        )


def test_a_double_spaced_charge_is_not_swept_in_by_a_single_spaced_rule(handler, rule_engine):
    # [A17] FAIL-ON-REVERT for WHIT-527: merchant_groups now shares rule_engine.contains instead
    # of its own `_matches` copy, and both must fold the description the STRICT (non-collapsing)
    # way. This is the length-changing-fold drift the card asks for, at the collapse boundary
    # [A16]'s İ case can't reach: two single-spaced descriptions yield the rule "COLES ONLINE",
    # and a third row carries the SAME merchant but a DOUBLE space in its description.
    #
    #   strict (today)    -> "coles online" is NOT in "coles  online ...", so the group files 2
    #   collapsing (drift)-> both fold to "coles online", so it would file 3 and the count lies
    #
    # rule_engine.rule_matches is the independent oracle (it folds the description via _normalise,
    # merchant_groups folds it up front at :190 — different code, same strict semantics). Revert
    # lever: reintroduce a whitespace-collapsing matcher in merchant_groups and this reddens.
    rows = [
        _charge(ANZ, "2026-07-10", "s1", "COLES ONLINE", "COLES ONLINE 111"),
        _charge(ANZ, "2026-07-09", "s2", "COLES ONLINE", "COLES ONLINE 222"),
        _charge(ANZ, "2026-07-08", "d1", "COLES ONLINE", "COLES  ONLINE 333"),  # double space
    ]
    body = _groups(handler, real_repos({ANZ: rows})[1])

    assert body["unfiled"] == 3
    assert len(body["groups"]) == 1
    group = body["groups"][0]
    assert group["rulePattern"] == "COLES ONLINE"

    would_file = _would_file(rule_engine, rows, group["rulePattern"])
    assert group["count"] == would_file == 2, (
        f"pattern {group['rulePattern']!r} previews {group['count']} but files {would_file} "
        "(a whitespace-collapsing fold would sweep in the double-spaced charge and count 3)"
    )
    # The double-spaced charge is left for its own decision, never silently folded into the group.
    assert body["ungrouped"]["count"] == 1


# --- WHIT-519: the nameless "leftovers" pass meeting the merchant pass -------------------


def test_a_wording_group_and_a_merchant_group_can_both_claim_a_row_without_breaking_the_partition(
    handler, rule_engine
):
    # [A18] FAIL-ON-REVERT for the second pass's grouped_positions accounting. The two nameless
    # "OSKO PAYMENT" rows form a wording group whose pattern "OSKO PAYMENT" ALSO reaches the two
    # NAMED "OSKO PAYMENT DESK" charges (a merchant group in its own right). Those two rows are
    # legitimately in BOTH group counts (like COLES / COLES EXPRESS) — but each row must be marked
    # grouped exactly once, so `unfiled == reached + ungrouped` stays exact and no reached row also
    # shows up in `ungrouped`. Drop the stem pass's grouped_positions.update and the two
    # pure-nameless rows fall into ungrouped while still reached -> partition breaks -> red.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "o1", "", "OSKO PAYMENT 4471123"),
        _charge(ANZ, "2026-07-09", "o2", "", "OSKO PAYMENT 4471124"),
        _charge(ANZ, "2026-07-08", "d1", "OSKO PAYMENT DESK", "OSKO PAYMENT DESK 999"),
        _charge(ANZ, "2026-07-07", "d2", "OSKO PAYMENT DESK", "OSKO PAYMENT DESK 998"),
    ]})

    body = _groups(handler, repo)

    wording = next(g for g in body["groups"] if g["groupedBy"] == "description")
    merchant = next(g for g in body["groups"] if g["groupedBy"] == "merchant")
    assert (wording["rulePattern"], wording["count"]) == ("OSKO PAYMENT", 4)
    assert wording["alsoCatches"] == [{"merchant": "OSKO PAYMENT DESK", "count": 2}]
    assert (merchant["rulePattern"], merchant["count"]) == ("OSKO PAYMENT DESK", 2)

    # Counts deliberately overlap (4 + 2 = 6 > 4 unfiled) — that is the disclosure the feature
    # exists for. But the PARTITION over the raw rows is still exact and single-count.
    eligible = [r for r in _account_rows(table, ANZ)
                if handler.is_unfiled_category(r.get("category"), set())]
    patterns = [g["rulePattern"] for g in body["groups"]]
    reached = {r["transaction_id"] for r in eligible
               if any(p.lower() in r["description"].lower() for p in patterns)}
    assert body["unfiled"] == 4
    assert len(reached) + body["ungrouped"]["count"] == body["unfiled"]  # never both / neither
    assert body["ungrouped"] == {"count": 0, "samples": []}

    for group in body["groups"]:
        would_file = _would_file(rule_engine, eligible, group["rulePattern"])
        assert would_file == group["count"], group["rulePattern"]


def test_a_wording_group_and_a_merchant_group_of_equal_size_order_by_pattern(handler):
    # [A20] FAIL-ON-REVERT for a stable order ACROSS the two kinds. Wording groups are appended
    # AFTER the merchant loop, so without the final sort the wording group would trail regardless
    # of its pattern. Both size 2; "OSKO PAYMENT" sorts before "WOOLWORTHS".
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "w1", "WOOLWORTHS", "WOOLWORTHS 1234 KEW"),
        _charge(ANZ, "2026-07-09", "w2", "WOOLWORTHS", "WOOLWORTHS 9987 KEW"),
        _charge(ANZ, "2026-07-08", "o1", "", "OSKO PAYMENT 4471123"),
        _charge(ANZ, "2026-07-07", "o2", "", "OSKO PAYMENT 4471124"),
    ]})

    body = _groups(handler, repo)

    assert [(g["rulePattern"], g["groupedBy"]) for g in body["groups"]] == [
        ("OSKO PAYMENT", "description"), ("WOOLWORTHS", "merchant"),
    ]


def test_a_double_spaced_stem_mints_a_value_that_literally_matches_its_originals(handler, rule_engine):
    # [A22] FAIL-ON-REVERT for slicing the stem from the ORIGINAL string, so interior spacing
    # survives. `contains` does not collapse whitespace, so a value that normalised the run to one
    # space would match NONE of these triple-spaced charges and preview 0 while claiming a group.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "o1", "", "OSKO   PAYMENT 4471123"),
        _charge(ANZ, "2026-07-09", "o2", "", "OSKO   PAYMENT 4471124"),
    ]})

    body = _groups(handler, repo)

    group = body["groups"][0]
    assert group["rulePattern"] == "OSKO   PAYMENT"  # the triple space is preserved
    for sample in group["samples"]:
        assert group["rulePattern"].lower() in sample.lower()  # literally findable
    would_file = _would_file(rule_engine, _account_rows(table, ANZ), group["rulePattern"])
    assert group["count"] == would_file == 2


def test_two_spacing_variants_of_one_stem_stay_separate_groups(handler, rule_engine):
    # [A22b] FAIL-ON-REVERT for bucketing on strip().lower(), NOT rule_engine.fold. Single- and
    # double-spaced descriptions of the same wording must NOT collapse into one bucket: a
    # single-space rule literally cannot contain a double-spaced charge, so one value can't honestly
    # cover both. If the bucket key used the whitespace-collapsing fold, they would merge and lie.
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "s1", "", "OSKO PAYMENT 4471123"),
        _charge(ANZ, "2026-07-09", "s2", "", "OSKO PAYMENT 4471124"),
        _charge(ANZ, "2026-07-08", "d1", "", "OSKO  PAYMENT 4471125"),
        _charge(ANZ, "2026-07-07", "d2", "", "OSKO  PAYMENT 4471126"),
    ]})

    body = _groups(handler, repo)

    assert sorted(g["rulePattern"] for g in body["groups"]) == ["OSKO  PAYMENT", "OSKO PAYMENT"]
    assert all(g["count"] == 2 for g in body["groups"])
    single = next(g for g in body["groups"] if g["rulePattern"] == "OSKO PAYMENT")
    would_file = _would_file(rule_engine, _account_rows(table, ANZ), single["rulePattern"])
    assert would_file == 2
    assert body["ungrouped"]["count"] == 0


def test_a_wording_group_discloses_many_swept_stems_biggest_first_and_a_no_stem_row_as_null(handler):
    # [A23] FAIL-ON-REVERT for two things in the by_stem=True disclosure: (a) alsoCatches is
    # biggest-first with an alphabetical tiebreak across MULTIPLE swept stems, and (b) a swept
    # nameless row whose OWN stem is None ("XX PAYID99" -> trailing digit token trimmed leaves
    # "XX", under the floor -> None) falls back to the single null line instead of crashing on
    # `.strip()` of None. The PAYID pattern reaches all of these; ALICE (x2) leads, then the null
    # line and BOB (x1) split the tie alphabetically (None sorts as "").
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "p1", "", "PAYID 111"),
        _charge(ANZ, "2026-07-09", "p2", "", "PAYID 222"),
        _charge(ANZ, "2026-07-08", "a1", "", "PAYID TO ALICE 1"),
        _charge(ANZ, "2026-07-07", "a2", "", "PAYID TO ALICE 2"),
        _charge(ANZ, "2026-07-06", "b1", "", "PAYID TO BOB 9"),
        _charge(ANZ, "2026-07-05", "x1", "", "XX PAYID99"),
    ]})

    body = _groups(handler, repo)

    payid = next(g for g in body["groups"] if g["rulePattern"] == "PAYID")
    assert payid["count"] == 6  # honest: the PAYID rule reaches every one of these
    assert payid["alsoCatches"] == [
        {"merchant": "PAYID TO ALICE", "count": 2},  # biggest first
        {"merchant": None, "count": 1},              # the no-stem sweep, null line, sorts as ""
        {"merchant": "PAYID TO BOB", "count": 1},
    ]


def test_interior_reference_digits_are_not_stripped_from_a_stem(handler, rule_engine):
    # [A24] FAIL-ON-REVERT for TRAILING-only trimming. The trailing token "DEBIT" carries no digit,
    # so _TRAILING_REFERENCE matches nothing and the WHOLE description — interior "1111" and all —
    # is the stem. Two identical ones group on that full stem. If the regex stripped digit tokens
    # anywhere (not just the tail), "1111" would vanish and the pattern would over-reach. No COLES
    # merchant here, so this is a pure wording group (unlike [A6] where such rows join a COLES group).
    table, repo, _ = real_repos({ANZ: [
        _charge(ANZ, "2026-07-10", "x1", "", "COLES 1111 DIRECT DEBIT"),
        _charge(ANZ, "2026-07-09", "x2", "", "COLES 1111 DIRECT DEBIT"),
    ]})

    body = _groups(handler, repo)

    assert len(body["groups"]) == 1
    group = body["groups"][0]
    assert group["rulePattern"] == "COLES 1111 DIRECT DEBIT"  # interior 1111 preserved
    assert group["groupedBy"] == "description"
    assert group["count"] == 2
    would_file = _would_file(rule_engine, _account_rows(table, ANZ), group["rulePattern"])
    assert would_file == 2
