"""Tests for GET /transactions/uncategorized/merchants (WHIT-515) — the charges that still
need filing, grouped by merchant, biggest group first.

"Apply my rules" can only file what an existing rule covers. What is left is merchants the
user has never written a rule for, and hundreds of those is the problem this endpoint exists
to shrink: N charges is nowhere near N merchants.

The counts here are load-bearing — WHIT-516 mints a rule from a group and writes with it — so
a group's count is what its rule would ACTUALLY file, evaluated the same literal
`description contains VALUE` way rule_engine does. That is why COLES reports 50 when 12 of them
are really COLES EXPRESS, and why it also has to say so.

Reuses FakeFeedRepo so the deep-page case (a merchant whose charges sit beyond page 1) is
genuinely exercised — the same reason the count suite does.
"""

import json

import pytest

from _feed_fakes import ANZ, SPENDING, WESTPAC, _row, FakeFeedRepo, FakeCategoryRepo


def _groups(handler, repo, taxonomy=()):
    resp = handler.get_uncategorized_merchants(repo, FakeCategoryRepo(set(taxonomy)))
    assert resp["statusCode"] == 200
    return json.loads(resp["body"])


def _charge(account_id, date, txn_id, merchant, description, category=None):
    return _row(account_id, date, txn_id, merchant_name=merchant,
                description=description, category=category)


def test_groups_unfiled_charges_by_merchant_biggest_first(handler):
    repo = FakeFeedRepo({ANZ: [
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


def test_a_nested_merchant_keeps_its_own_group_and_the_wider_one_discloses_it(handler):
    # FAIL-ON-REVERT for the dangerous case. A rule on "COLES" really does catch COLES
    # EXPRESS, so the COLES group counts 5 — but dropping the smaller group (or merging the
    # two) would let one tap file her petrol as groceries, permanently. Both groups stay, and
    # the wider one names what else it sweeps in.
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "c1", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-09", "c2", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-08", "c3", "COLES", "COLES ONLINE"),
        _charge(ANZ, "2026-07-07", "e1", "COLES EXPRESS", "COLES EXPRESS 1123"),
        _charge(ANZ, "2026-07-06", "e2", "COLES EXPRESS", "COLES EXPRESS 1123"),
    ]})

    body = _groups(handler, repo)

    coles, express = body["groups"]
    assert (coles["rulePattern"], coles["count"]) == ("COLES", 5)
    assert coles["alsoCatches"] == [{"merchant": "COLES EXPRESS", "count": 2}]
    assert (express["rulePattern"], express["count"]) == ("COLES EXPRESS", 2)
    assert express["alsoCatches"] == []
    assert body["ungrouped"]["count"] == 0


def test_rule_pattern_comes_from_the_whole_group_not_one_row(handler):
    # FAIL-ON-REVERT. The NEWEST charge's description doesn't contain the merchant name at all,
    # so it yields no clean slice. Deriving the rule from one representative row would pick
    # that one and collapse a 3-charge group to nothing; deriving it from the whole group keeps
    # the group and leaves the odd row out rather than mis-filing it.
    repo = FakeFeedRepo({ANZ: [
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
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "k1", "COLES", "Coles Online"),
        _charge(ANZ, "2026-07-09", "k2", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-08", "k3", "COLES", "COLES 0342 RICHMOND"),
    ]})

    body = _groups(handler, repo)

    assert body["groups"][0]["rulePattern"] == "COLES"
    assert body["groups"][0]["count"] == 3  # matching stays case-insensitive


def test_a_merchant_too_short_to_rule_on_is_left_ungrouped(handler):
    # FAIL-ON-REVERT for the 4-character floor. A rule on "BP" would file every BPAY transfer
    # as petrol. BP is left ungrouped (she files those by hand); BPAY clears the floor.
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "b1", "BP", "BP 2210 RICHMOND"),
        _charge(ANZ, "2026-07-09", "b2", "BP", "BP 2210 RICHMOND"),
        _charge(ANZ, "2026-07-08", "p1", "BPAY", "BPAY BILL 88213"),
    ]})

    body = _groups(handler, repo)

    assert [group["rulePattern"] for group in body["groups"]] == ["BPAY"]
    assert body["groups"][0]["count"] == 1
    assert body["ungrouped"]["count"] == 2


def test_a_charge_with_no_merchant_name_is_ungrouped_not_dropped(handler):
    # Merchant identity unknown -> no group (grouping on the full description would make a
    # group per charge). It still has to show up in `ungrouped` and in `unfiled`, or the
    # numbers stop reconciling with the badge.
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "n1", "", "OSKO PAYMENT 4471123"),
        _charge(ANZ, "2026-07-09", "w1", "WOOLWORTHS", "WOOLWORTHS 1234 KEW"),
    ]})

    body = _groups(handler, repo)

    assert [group["merchant"] for group in body["groups"]] == ["WOOLWORTHS"]
    assert body["unfiled"] == 2
    assert body["ungrouped"] == {"count": 1, "samples": ["OSKO PAYMENT 4471123"]}


def test_nameless_charges_sharing_wording_become_one_actionable_group(handler):
    # WHIT-519: the card's own example. Three OSKO payments carry no merchant name and a
    # different reference each, so they never form a merchant group. Trimming the trailing
    # reference leaves "OSKO PAYMENT", which repeats -> one actionable group, tagged as
    # grouped-by-wording, and the pile is cleared.
    repo = FakeFeedRepo({ANZ: [
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
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "o1", "", "OSKO PAYMENT 4471123"),
        _charge(ANZ, "2026-07-09", "w1", "WOOLWORTHS", "WOOLWORTHS 1234 KEW"),
    ]})

    body = _groups(handler, repo)

    assert [group["rulePattern"] for group in body["groups"]] == ["WOOLWORTHS"]
    assert body["ungrouped"] == {"count": 1, "samples": ["OSKO PAYMENT 4471123"]}


def test_wording_groups_do_not_merge_to_the_shared_opening(handler):
    # FAIL-ON-REVERT against direction B's failure mode. Two DoorDash holds and two Uber holds
    # all open "POS AUTHORISATION" — but trimming only the trailing reference keeps the payee,
    # so they form TWO specific groups, never one "POS AUTHORISATION" rule that files every
    # pending card hold as one thing.
    repo = FakeFeedRepo({ANZ: [
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
    repo = FakeFeedRepo({ANZ: [
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
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "b1", "", "BP 4471123"),
        _charge(ANZ, "2026-07-09", "b2", "", "BP 4471124"),
    ]})

    body = _groups(handler, repo)

    assert body["groups"] == []
    assert body["ungrouped"]["count"] == 2


def test_a_wording_group_discloses_the_nameless_charges_it_also_sweeps(handler):
    # FAIL-ON-REVERT for the critic's blind-disclosure fix. A "TRANSFER TO" stem (from two
    # PayID-to-phone rows) also reaches "TRANSFER TO JOHN" / "TRANSFER TO JANE". Those must be
    # NAMED in alsoCatches by their own stem, not silently swept. Key nameless sweeps as one
    # null line (the old behaviour) and this reddens.
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "t1", "", "TRANSFER TO 0412345678"),
        _charge(ANZ, "2026-07-09", "t2", "", "TRANSFER TO 0498765432"),
        _charge(ANZ, "2026-07-08", "j1", "", "TRANSFER TO JOHN 20260710"),
        _charge(ANZ, "2026-07-07", "k1", "", "TRANSFER TO JANE 20260711"),
    ]})

    body = _groups(handler, repo)

    transfer = next(g for g in body["groups"] if g["rulePattern"] == "TRANSFER TO")
    assert transfer["count"] == 4  # honest: the rule really files all four
    assert transfer["alsoCatches"] == [
        {"merchant": "TRANSFER TO JANE", "count": 1},
        {"merchant": "TRANSFER TO JOHN", "count": 1},
    ]


def test_a_wording_group_discloses_a_named_merchant_it_reaches(handler):
    # The only route out for a merchant name too short to slice today: nameless "SQ*SEDDON EATRY"
    # holds form a wording group, and a named SEDDONS EATERY charge whose description carries the
    # same stem is disclosed (named), each keeping its own group.
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "s1", "", "SQ*SEDDON EATRY 4412"),
        _charge(ANZ, "2026-07-09", "s2", "", "SQ*SEDDON EATRY 4413"),
        _charge(ANZ, "2026-07-08", "n1", "SEDDONS EATERY", "SQ*SEDDON EATRY 4414"),
    ]})

    body = _groups(handler, repo)

    stem_group = next(g for g in body["groups"] if g["groupedBy"] == "description")
    assert stem_group["rulePattern"] == "SQ*SEDDON EATRY"
    assert stem_group["count"] == 3
    assert stem_group["alsoCatches"] == [{"merchant": "SEDDONS EATERY", "count": 1}]


def test_wording_group_pattern_is_a_literal_substring_of_every_sample(handler):
    # The minted value must be findable in the charges it claims to file (contains is literal
    # and does not collapse whitespace), or the preview count is a lie.
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "o1", "", "OSKO PAYMENT 4471123"),
        _charge(ANZ, "2026-07-09", "o2", "", "OSKO PAYMENT 4471124"),
    ]})

    body = _groups(handler, repo)
    group = body["groups"][0]
    for sample in group["samples"]:
        assert group["rulePattern"].lower() in sample.lower()


def test_existing_merchant_groups_are_tagged_grouped_by_merchant(handler):
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "w1", "WOOLWORTHS", "WOOLWORTHS 1234 KEW"),
        _charge(ANZ, "2026-07-09", "w2", "WOOLWORTHS", "WOOLWORTHS 9987 KEW"),
    ]})

    body = _groups(handler, repo)

    assert body["groups"][0]["groupedBy"] == "merchant"


def test_already_filed_charges_are_excluded_everywhere(handler):
    # FAIL-ON-REVERT. A charge she has already filed must not swell a group's count, must not
    # appear in alsoCatches, and must not be in `unfiled` — otherwise the preview promises
    # writes that WHIT-508's conditional write will refuse.
    repo = FakeFeedRepo({ANZ: [
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
    repo = FakeFeedRepo({
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
    repo = FakeFeedRepo({ANZ: rows})

    body = _groups(handler, repo, taxonomy={"groceries"})

    assert [(group["rulePattern"], group["count"]) for group in body["groups"]] == [("ALDI", 2)]
    assert len([call for call in repo.calls if call[0] == ANZ]) > 1  # genuinely paged


def test_every_group_count_is_what_the_rule_would_really_file(handler, rule_engine):
    # FAIL-ON-REVERT for the invariant the whole feature rests on. Every other count assertion
    # here is computed by the module under test, so a matcher that drifted looser — stripping
    # punctuation, say — would pass all of them while quietly overstating. This checks the
    # counts against the OTHER module, the one that does the filing for real.
    #
    # NICOLE'S CAFE is the trap: punctuation-stripped, "nicolescafe" contains "coles". A COLES
    # rule must not reach it, and the group count must not include it.
    rows = [
        _charge(ANZ, "2026-07-10", "c1", "COLES", "COLES 0342 RICHMOND"),
        _charge(ANZ, "2026-07-09", "c2", "COLES", "COLES ONLINE"),
        _charge(ANZ, "2026-07-08", "e1", "COLES EXPRESS", "COLES EXPRESS 1123"),
        _charge(ANZ, "2026-07-07", "n1", "NICOLE'S CAFE", "NICOLE'S CAFE BRUNSWICK"),
        _charge(ANZ, "2026-07-06", "n2", "NICOLE'S CAFE", "NICOLE'S CAFE BRUNSWICK"),
    ]
    body = _groups(handler, FakeFeedRepo({ANZ: rows}), taxonomy={"groceries"})

    def still_unfiled(category):
        return category != "income" and category != "groceries"

    for group in body["groups"]:
        rule = {"id": "r", "field": "description", "operator": "contains",
                "value": group["rulePattern"], "categoryId": "groceries"}
        plan = rule_engine.plan_rule_application([rule], rows, still_unfiled)
        assert plan["by_rule"][0]["count"] == group["count"], group["rulePattern"]

    coles = next(g for g in body["groups"] if g["rulePattern"] == "COLES")
    assert coles["count"] == 3  # c1, c2, e1 — never the two NICOLE'S CAFE charges


def test_a_description_whose_lowercasing_changes_length_yields_no_rule(handler):
    # Lowercasing "İ" produces TWO characters, so a position found in the lowered description
    # points past where the shop name really starts in the original. Here that slides the slice
    # off "MERCHANT" onto "ERCHANT " — a rule that would match charges at random. Better to
    # leave these unfiled than to offer a rule built on a misread.
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "u1", "MERCHANT", "İMERCHANT 123"),
        _charge(ANZ, "2026-07-09", "u2", "MERCHANT", "İMERCHANT 456"),
    ]})

    body = _groups(handler, repo)

    assert body["groups"] == []
    assert body["ungrouped"]["count"] == 2


def test_equal_sized_groups_are_ordered_by_pattern(handler):
    # Two groups the same size must come back in a fixed order, or the list reshuffles between
    # refreshes and she loses her place halfway down a long tail.
    repo = FakeFeedRepo({ANZ: [
        _charge(ANZ, "2026-07-10", "z1", "ZARA", "ZARA MELBOURNE"),
        _charge(ANZ, "2026-07-09", "a1", "ALDI", "ALDI 771 KEW"),
        _charge(ANZ, "2026-07-08", "m1", "MYER", "MYER CITY"),
    ]})

    body = _groups(handler, repo)

    assert [group["rulePattern"] for group in body["groups"]] == ["ALDI", "MYER", "ZARA"]


def test_swept_charges_with_no_merchant_name_share_one_disclosure_line(handler):
    # FAIL-ON-REVERT, both ways. The disclosure has to cover the messy descriptions —
    # "PAYPAL *COLES ONLINE" carries no merchant name but a COLES rule files it just the same —
    # AND it has to stay readable: those descriptions carry a per-charge reference, so naming
    # them individually would turn the warning into one line per charge.
    repo = FakeFeedRepo({ANZ: [
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


def test_scans_whole_history_with_no_date_floor(handler):
    repo = FakeFeedRepo({ANZ: [_charge(ANZ, "2026-07-10", "a1", "ALDI", "ALDI 771 KEW")]})

    handler.get_uncategorized_merchants(repo, FakeCategoryRepo(set()))

    anz_call = next(call for call in repo.calls if call[0] == ANZ)
    assert anz_call[1] is None and anz_call[2] is None


def test_empty_history_returns_no_groups(handler):
    body = _groups(handler, FakeFeedRepo({}), taxonomy={"groceries"})
    assert body == {"unfiled": 0, "groups": [], "ungrouped": {"count": 0, "samples": []}}


def test_route_wires_to_get_uncategorized_merchants(handler, monkeypatch):
    repo = FakeFeedRepo({ANZ: [_charge(ANZ, "2026-07-10", "a1", "ALDI", "ALDI 771 KEW")]})
    monkeypatch.setattr(handler, "TransactionRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(set()))

    resp = handler.lambda_handler({
        "rawPath": "/transactions/uncategorized/merchants",
        "requestContext": {"http": {"method": "GET"}},
    }, None)

    assert resp["statusCode"] == 200
    assert json.loads(resp["body"])["groups"][0]["rulePattern"] == "ALDI"


def test_post_to_the_merchants_path_is_not_routed(handler, monkeypatch):
    # The route is method-gated, so a POST falls through to 404 rather than running the scan.
    def _boom(*args, **kwargs):
        raise AssertionError("get_uncategorized_merchants must not run for POST")

    monkeypatch.setattr(handler, "get_uncategorized_merchants", _boom)
    monkeypatch.setattr(handler, "TransactionRepository", lambda: FakeFeedRepo({}))
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(set()))

    resp = handler.lambda_handler({
        "rawPath": "/transactions/uncategorized/merchants",
        "requestContext": {"http": {"method": "POST"}},
    }, None)

    assert resp["statusCode"] == 404


def test_unbounded_pagination_raises(handler):
    class _NeverEndsRepo:
        def get_transactions_by_date_range(self, account_id, start, end, limit=20, cursor=None):
            return [_charge(account_id, "2026-01-01", "x", "ALDI", "ALDI 771")], {"pk": "p", "sk": "s"}

    with pytest.raises(RuntimeError, match="did not terminate"):
        handler.get_uncategorized_merchants(_NeverEndsRepo(), FakeCategoryRepo(set()))
