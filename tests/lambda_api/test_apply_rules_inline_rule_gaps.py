"""ADVERSARIAL gap tests for the inline `rule` on POST /transactions/uncategorized/apply-rules
(WHIT-516) — "make a rule for this shop AND file the charges it already has", in one request.

These do NOT duplicate tests/lambda_api/test_apply_rules_inline_rule.py. That suite locks the
card's spine: one request mints + files, a preview mints nothing, the inline rule is swept ALONE
(the existing rules read only to refuse a clash — WHIT-523), an absent rule is the old path,
mint-before-sweep ordering, create_rule
failing, the floor / taxonomy / field-operator / non-object / non-string fences, the shared
floor identity, WHIT-508's hand-filed charge, create_rule's dedup pass-through, and the route
wiring.

What it does NOT lock, and this file does:

  * [A1] EVERY `rulePattern` the WHIT-515 merchant screen offers is ACCEPTED by this write half
         — asserted by feeding real output of `get_uncategorized_merchants` into the real
         `apply_rules_to_uncategorized`, on deliberately awkward names: unicode, punctuation,
         and one whose only letters/digits are DIGITS. The screen offering a group this route
         refuses is the worst bug available at this seam.
  * [A2] and the `count` the screen SHOWS is the number this route really FILES — same seam,
         arithmetic half. The fixture includes a nameless "PAYPAL *..." charge the wider rule
         sweeps in, so a count taken from the merchant bucket rather than from the rule's real
         members is caught.
  * [A3] an existing rule on the same TEXT filing elsewhere is refused (409), including across
         casing and spacing variants of the same merchant.
  * [A4] that refusal lands on the PREVIEW too, not only on the commit.
  * [A5] but the same text to the SAME category is NOT a clash — the re-tap after a capped run
         must still work, or every charge past the cap is stranded.
  * [A6] a NESTED existing rule is refused too, from either side ("COLES EXPRESS -> petrol"
         against an inline "COLES -> groceries" and the reverse). Different text, but every
         EXPRESS charge matches both, so they fight and that charge is never filed — exactly the
         nesting WHIT-515 discloses via `alsoCatches`. An equality-only guard waves it through.
         Nested rules that AGREE on the category are still fine.
  * [A7] a failure to READ her rules mints nothing (the impl suite covers create_rule failing,
         not list_rules failing while an inline rule is in flight).
  * [A8] a rejected inline rule costs no BankSync round trip at all (the impl suite asserts the
         history is not scanned; this asserts list_rules is never even called).
  * [A9] both BankSync calls succeed but every write errors: 200, rows in `failed`, and the rule
         STAYS minted — the recoverable state the mint-first comment claims.
  * [A10] the write cap with an inline rule: minted once, exactly the cap attempted, honest
          `remaining`.
  * [A11] tapping again after the cap finishes the job and rewrites NOTHING — the DB-write half
          of "safe to run twice", which the impl suite's rule-dedup test does not cover.
  * [A12] the TIME budget with an inline rule: the rule is minted, at least one row is still
          filed, and the rest is reported as `remaining`.
  * [A13] an accepted value is minted TRIMMED (the impl suite only covers whitespace values that
          are REJECTED, so the strip on the accepted path was unasserted).
  * [A14] an explicit `"rule": null` is the plain sweep, not a 400.
  * [A15] DOCUMENTS A GAP: there is no maximum length, so a 500-character value is minted
          verbatim and files nothing. Ranked in the critique; the test pins today's behaviour so
          adding a cap has to be a deliberate change.

Reuses the shared paged date-index fake (_feed_fakes), so this suite is registered in the
`feed` domain tuple of tests/shared/test_fakes_invariants.py.
"""

import json

import pytest

from _feed_fakes import SPENDING, WESTPAC, _row, WritableFeedRepo, FakeCategoryRepo


class _BankSync:
    """Records mints and, unlike the impl suite's fake, makes a minted rule VISIBLE to the next
    request's list_rules — which is what really happens between two taps of the same button."""

    def __init__(self, existing=()):
        self.existing = [dict(rule) for rule in existing]
        self.minted = []
        self.list_calls = 0

    def list_rules(self):
        self.list_calls += 1
        return [dict(rule) for rule in self.existing]

    def create_rule(self, field, operator, value, category_id):
        self.minted.append((field, operator, value, category_id))
        rule = {"id": f"enr_{len(self.minted)}", "field": field, "operator": operator,
                "value": value, "categoryId": category_id, "conditionCount": 1}
        self.existing.append(rule)
        return dict(rule)


def _apply(handler, monkeypatch, repo, body, banksync=None,
           categories=("groceries", "petrol")):
    banksync = banksync if banksync is not None else _BankSync()
    monkeypatch.setattr(handler, "list_rules", banksync.list_rules)
    monkeypatch.setattr(handler, "create_rule", banksync.create_rule)
    event = {
        "rawPath": "/transactions/uncategorized/apply-rules",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps(body),
    }
    response = handler.apply_rules_to_uncategorized(event, repo, FakeCategoryRepo(categories))
    return response, json.loads(response["body"]), banksync


def _coles_repo():
    return WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342 RICHMOND",
             merchant_name="Coles", category=None),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE",
             merchant_name="Coles", category=None),
    ]})


def _messy_repo():
    """Unfiled charges from deliberately awkward merchants: a unicode name, a punctuation-heavy
    one, and one whose only letters/digits are DIGITS — plus a nameless "PAYPAL *" charge the
    unicode merchant's rule sweeps in, so a group count taken from the merchant BUCKET rather
    than from the rule's real members would disagree with what gets filed."""
    return WritableFeedRepo({
        SPENDING: [
            _row(SPENDING, "2026-07-08", "u1", description="CAFÉ MÖRK 0042 FITZROY",
                 merchant_name="Café Mörk", category=None),
            _row(SPENDING, "2026-07-07", "u2", description="CAFÉ MÖRK 0042 FITZROY",
                 merchant_name="Café Mörk", category=None),
            _row(SPENDING, "2026-07-06", "u3", description="PAYPAL *CAFÉ MÖRK 99213",
                 merchant_name=None, category=None),
            _row(SPENDING, "2026-07-05", "p1", description="J.B. HI-FI 1234 CHADSTONE",
                 merchant_name="J.B. Hi-Fi", category=None),
            _row(SPENDING, "2026-07-04", "p2", description="J.B. HI-FI ONLINE",
                 merchant_name="J.B. Hi-Fi", category=None),
        ],
        WESTPAC: [
            _row(WESTPAC, "2026-07-03", "d1", description="1300 655 506 PAYMENT",
                 merchant_name="1300 655 506", category=None),
            _row(WESTPAC, "2026-07-02", "d2", description="DD 1300 655 506",
                 merchant_name="1300 655 506", category=None),
            _row(WESTPAC, "2026-07-01", "n1", description="NETFLIX.COM",
                 merchant_name="Netflix", category=None),
        ],
    })


def _offered_groups(handler):
    response = handler.get_uncategorized_merchants(_messy_repo(), FakeCategoryRepo(("groceries", "petrol")))
    return json.loads(response["body"])["groups"]


# --- the seam with WHIT-515 ---------------------------------------------------


def test_every_pattern_the_merchant_screen_offers_is_accepted_by_the_write_half(
    handler, monkeypatch
):
    # [A1] FAIL-ON-REVERT for the two halves agreeing on real data rather than on a shared
    # constant. The screen can only offer what group_unfiled_by_merchant produces; if this route
    # refuses any of it she taps "file this shop" and gets a 400 with no way forward.
    groups = _offered_groups(handler)
    patterns = [group["rulePattern"] for group in groups]
    # Guard the guard: an empty/collapsed group list would make the loop below vacuous.
    assert patterns == ["CAFÉ MÖRK", "1300 655 506", "J.B. HI-FI", "NETFLIX"]

    for pattern in patterns:
        response, body, banksync = _apply(
            handler, monkeypatch, _messy_repo(),
            {"dryRun": True, "rule": {"value": pattern, "categoryId": "groceries"}})
        assert response["statusCode"] == 200, (pattern, body)
        assert banksync.minted == []


def test_the_count_the_merchant_screen_shows_is_the_number_this_route_really_files(
    handler, monkeypatch
):
    # [A2] FAIL-ON-REVERT for the seam's arithmetic, asserted between two REAL production
    # functions: merchant_groups' count and the sweep's own `filed` list. "COLES — 38 charges"
    # shown immediately before a bulk write has to be the 38 that move.
    for group in _offered_groups(handler):
        repo = _messy_repo()
        _, body, _ = _apply(
            handler, monkeypatch, repo,
            {"dryRun": False, "rule": {"value": group["rulePattern"],
                                       "categoryId": "groceries"}})
        assert len(body["filed"]) == group["count"], group["rulePattern"]
        assert body["byCategory"] == {"groceries": group["count"]}
        assert len(repo.writes) == group["count"]


# --- a conflict with a rule she already has -----------------------------------


def _nested_coles_repo():
    """COLES and COLES EXPRESS — the nesting the merchant screen discloses via `alsoCatches`.
    A rule on COLES sweeps the EXPRESS charge in too."""
    return WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342 RICHMOND",
             merchant_name="Coles", category=None),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE",
             merchant_name="Coles", category=None),
        _row(SPENDING, "2026-07-01", "e1", description="COLES EXPRESS 5512",
             merchant_name="Coles Express", category=None),
    ]})


@pytest.mark.parametrize("existing_value", ["COLES", "coles", "  Coles  "])
def test_an_existing_rule_on_the_same_text_filing_elsewhere_is_refused(
    handler, monkeypatch, existing_value
):
    # [A3] She already has COLES -> petrol and the screen offers COLES; filing it to groceries
    # would leave the two rules permanently disagreeing, so every COLES charge is conflicted and
    # NEVER filed — on this run or any future one. Refused outright, and the casing/spacing
    # variants must be caught too (the same merchant is spelled inconsistently in real rules).
    repo = _nested_coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains",
                 "value": existing_value, "categoryId": "petrol", "conditionCount": 1}]
    response, body, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 409
    assert body["existingRule"]["id"] == "r1"
    assert "petrol" in body["error"]
    assert banksync.minted == [] and repo.writes == []


def test_the_preview_refuses_that_clash_too(handler, monkeypatch):
    # [A4] The refusal must land on the PREVIEW, not only the commit — otherwise the screen
    # shows her a number, she taps, and only then is she told it can't be done.
    repo = _nested_coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "petrol", "conditionCount": 1}]
    response, _, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 409
    assert banksync.minted == [] and repo.writes == []


def test_an_existing_rule_on_the_same_text_to_the_SAME_category_is_not_a_clash(
    handler, monkeypatch
):
    # [A5] The guard must not eat the legitimate re-tap: after a capped run the rule EXISTS, and
    # tapping again sends the same inline rule to the same category. A 409 there would strand
    # every charge past the cap, permanently unfilable through this screen.
    repo = _nested_coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "coles",
                 "categoryId": "groceries", "conditionCount": 1}]
    response, body, _ = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["e1", "t1", "t2"]


def test_a_NESTED_existing_rule_is_refused_too_not_just_an_exact_repeat(handler, monkeypatch):
    # [A6] The likeliest conflict of the lot, and the one an equality-only guard waves straight
    # through. An existing "COLES EXPRESS -> petrol" is different TEXT from an inline
    # "COLES -> groceries", but every EXPRESS charge matches both — so they fight, and a charge
    # two rules disagree about is never filed, on this run or any future one.
    #
    # Minting would file the 2 plain COLES charges, strand the EXPRESS one for good, and return
    # 200 with a bare `conflicted: 1`. The screen said 3. Nesting is exactly what the merchant
    # screen warns about in `alsoCatches`, so it is the shape to catch, not an exotic one.
    # Refusing is the honest answer until the more specific rule can win (WHIT-518).
    offered = json.loads(
        handler.get_uncategorized_merchants(_nested_coles_repo(), FakeCategoryRepo(("groceries", "petrol")))["body"])["groups"]
    group = next(g for g in offered if g["rulePattern"] == "COLES")
    assert group["count"] == 3
    assert group["alsoCatches"] == [{"merchant": "Coles Express", "count": 1}]

    repo = _nested_coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains",
                 "value": "COLES EXPRESS", "categoryId": "petrol", "conditionCount": 1}]
    response, body, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 409
    assert body["existingRule"]["id"] == "r1"
    assert banksync.minted == [] and repo.writes == []


def test_the_nesting_check_catches_it_from_either_side(handler, monkeypatch):
    # [A6] The same overlap the other way round: an existing rule on the WIDER text, an inline
    # rule on the narrower one. Checking containment in one direction only would leave half the
    # nested cases open.
    repo = _nested_coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "groceries", "conditionCount": 1}]
    response, body, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES EXPRESS", "categoryId": "petrol"}},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 409
    assert body["existingRule"]["id"] == "r1"
    assert banksync.minted == [] and repo.writes == []


def test_a_nested_rule_to_the_SAME_category_is_still_fine(handler, monkeypatch):
    # Overlap only matters when the two DISAGREE. "COLES EXPRESS -> groceries" and
    # "COLES -> groceries" both file to the same place, so nothing conflicts and the charges
    # file normally. Refusing on overlap alone would block a perfectly sensible pair.
    repo = _nested_coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains",
                 "value": "COLES EXPRESS", "categoryId": "groceries", "conditionCount": 1}]
    response, body, _ = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["e1", "t1", "t2"]


# --- failure modes ------------------------------------------------------------


def test_a_failure_to_read_her_rules_mints_nothing(handler, monkeypatch):
    # [A7] The inline rule must not be minted when we could not read the rules it must check for
    # a clash before minting. Minting first would leave a rule behind for a request that failed.
    repo = _coles_repo()
    banksync = _BankSync()

    def _explode():
        raise handler.BankSyncError(503, "banksync down")

    banksync.list_rules = _explode
    response, _, _ = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        banksync=banksync)

    assert response["statusCode"] >= 500
    assert banksync.minted == [] and repo.writes == []


def test_a_rejected_inline_rule_costs_no_banksync_round_trip(handler, monkeypatch):
    # [A8] A typo must be free. Reading her rules first and 400ing after makes every rejected
    # tap pay for a BankSync call, and on a BankSync outage a plain typo would 502 instead of
    # telling her what is actually wrong with the value.
    class _ExplodingRepo:
        def get_transactions_by_date_range(self, *args, **kwargs):
            raise AssertionError("history must not be scanned for a rejected rule")

    response, _, banksync = _apply(
        handler, monkeypatch, _ExplodingRepo(),
        {"dryRun": False, "rule": {"value": "BP", "categoryId": "groceries"}})

    assert response["statusCode"] == 400
    assert banksync.list_calls == 0
    assert banksync.minted == []


def test_the_rule_stays_minted_when_every_write_fails(handler, monkeypatch):
    # [A9] The recoverable state handler.py:1408-1411 promises: the rule exists, the charges
    # did not move, and tapping again finishes the job. A 500 here would be a lie (the rule DID
    # get made) and would hide which rows still need retrying.
    repo = _coles_repo()
    repo.error_ids = {"t1", "t2"}
    response, body, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert response["statusCode"] == 200
    assert body["createdRule"]["id"] == "enr_1"
    assert body["filed"] == []
    assert sorted(body["failed"]) == ["t1", "t2"]
    assert len(banksync.minted) == 1


# --- the write cap and the time budget ----------------------------------------


def test_the_write_cap_stops_the_sweep_with_the_rule_minted_once(handler, monkeypatch):
    # [A10] Asserted against the REAL cap constant, so raising or lowering it can't silently
    # desync this from production.
    cap = handler.APPLY_RULES_MAX_WRITES
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", f"t{index:04d}", description=f"COLES {index}",
             merchant_name="Coles", category=None)
        for index in range(cap + 25)
    ]})
    _, body, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert len(banksync.minted) == 1
    assert body["matched"] == cap + 25
    assert len(body["filed"]) == cap
    assert body["remaining"] == 25


def test_tapping_again_after_the_cap_finishes_the_job_and_rewrites_nothing(
    handler, monkeypatch
):
    # [A11] The DB-write half of safe-to-run-twice across the cap boundary, which the impl
    # suite's rule-dedup test does not reach. The first 300 are FILED, so the second request's
    # scan no longer sees them — no row is written twice even though the rule is now BOTH in her
    # rules and re-sent inline.
    cap = handler.APPLY_RULES_MAX_WRITES
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-01", f"t{index:04d}", description=f"COLES {index}",
             merchant_name="Coles", category=None)
        for index in range(cap + 25)
    ]})
    banksync = _BankSync()
    request = {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}}

    _, first, _ = _apply(handler, monkeypatch, repo, request, banksync=banksync)
    _, second, _ = _apply(handler, monkeypatch, repo, request, banksync=banksync)

    first_ids = {filed["id"] for filed in first["filed"]}
    second_ids = {filed["id"] for filed in second["filed"]}
    assert len(first_ids) == cap and len(second_ids) == 25
    assert first_ids.isdisjoint(second_ids)
    assert second["remaining"] == 0 and second["unfiled"] == 25
    # Exactly one write per row across BOTH requests — nothing refiled.
    assert len(repo.writes) == cap + 25
    # WHIT-523: the sweep is the inline rule ALONE, even on the re-tap when a copy of it now
    # exists in BankSync. So it is considered once, not twice.
    assert second["rulesConsidered"] == 1
    assert [entry["ruleId"] for entry in second["byRule"]] == [None]


def test_the_time_budget_stops_the_sweep_with_the_rule_already_minted(handler, monkeypatch):
    # [A12] A fixed clock, never the ambient one. The `attempted and` guard at handler.py:1432
    # is load-bearing: without it a slow rule read would return zero filed rows forever and the
    # app would retry the same request for ever.
    class _Clock:
        def __init__(self, ticks):
            self._ticks = iter(ticks)

        def monotonic(self):
            return next(self._ticks)

    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES A", merchant_name="Coles",
             category=None),
        _row(SPENDING, "2026-07-02", "t2", description="COLES B", merchant_name="Coles",
             category=None),
        _row(SPENDING, "2026-07-01", "t3", description="COLES C", merchant_name="Coles",
             category=None),
    ]})
    over = handler.APPLY_RULES_TIME_BUDGET_SECONDS + 1.0
    monkeypatch.setattr(handler, "time", _Clock([0.0] + [over] * 20))

    _, body, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert len(banksync.minted) == 1
    assert len(body["filed"]) == 1          # at least one row always moves
    assert body["matched"] == 3
    assert body["remaining"] == 2           # "tap again", and it is honest about how much


# --- value handling -----------------------------------------------------------


@pytest.mark.parametrize("value", ["  COLES  ", "\tCOLES\n", "COLES "])
def test_an_accepted_value_is_minted_trimmed(handler, monkeypatch, value):
    # [A13] The impl suite only covers whitespace values that are REJECTED, so the strip on the
    # accepted path was unasserted. It matters beyond tidiness: the minted value is what
    # BankSync stores and what the client's duplicate-rule guard folds against, and a stray
    # trailing space would make the same rule mintable twice.
    repo = _coles_repo()
    _, body, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": value, "categoryId": "groceries"}})

    assert banksync.minted == [("description", "contains", "COLES", "groceries")]
    assert body["createdRule"]["value"] == "COLES"
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_an_explicit_null_rule_is_the_plain_sweep_not_a_400(handler, monkeypatch):
    # [A14] The app serialising an absent rule as JSON null must not become a 400 — and must
    # not become a mint either.
    repo = _coles_repo()
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
                 "categoryId": "groceries", "conditionCount": 1}]
    response, body, banksync = _apply(
        handler, monkeypatch, repo, {"dryRun": False, "rule": None},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 200
    assert banksync.minted == [] and body["createdRule"] is None
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_a_very_long_value_is_minted_verbatim_and_files_nothing(handler, monkeypatch):
    # [A15] DOCUMENTS A GAP — there is no maximum length on the inline value (handler.py:1284).
    # A 500-character value clears the letters/digits floor, is sent to BankSync as-is (inside
    # the rule NAME, _rule_payload at banksync_enrichments.py:154), and matches nothing. Pinned
    # so adding a cap is a deliberate change rather than a silent one. Ranked in the critique.
    repo = _coles_repo()
    value = "COLES" + "X" * 500
    response, body, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": value, "categoryId": "groceries"}})

    assert response["statusCode"] == 200
    assert banksync.minted == [("description", "contains", value, "groceries")]
    assert body["filed"] == [] and repo.writes == []


# --- WHIT-523 scope: what the inline rule sweeps vs what it must NOT --------------


def test_the_plain_sweep_still_files_across_ALL_her_rules(handler, monkeypatch):
    # [A16] REGRESSION GUARD — the worst outcome of WHIT-523 would be the scoping leaking onto the
    # plain "Apply my rules" button (no inline rule), quietly filing only ONE of her rules. With no
    # inline `rule`, EVERY rule must still sweep: a COLES charge AND a BP charge both file, to their
    # own categories, and both rules show in byRule. Does NOT duplicate
    # test_no_inline_rule_behaves_exactly_as_before (impl suite) — that has ONE existing rule and so
    # can't tell a full sweep from a truncated one; this pins multiple rules all firing.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-04", "t1", description="COLES 0342", category=None),
        _row(SPENDING, "2026-07-03", "t2", description="COLES ONLINE", category=None),
        _row(SPENDING, "2026-07-02", "b1", description="BP 2210 SERVO", category=None),
        _row(SPENDING, "2026-07-01", "n1", description="NETFLIX.COM", category=None),
    ]})
    existing = [
        {"id": "r1", "field": "description", "operator": "contains", "value": "COLES",
         "categoryId": "groceries", "conditionCount": 1},
        {"id": "r2", "field": "description", "operator": "contains", "value": "BP 2210",
         "categoryId": "petrol", "conditionCount": 1},
    ]
    response, body, banksync = _apply(handler, monkeypatch, repo, {"dryRun": False},
                                      banksync=_BankSync(existing))

    assert response["statusCode"] == 200
    assert banksync.minted == [] and body["createdRule"] is None    # plain path mints nothing
    assert sorted(filed["id"] for filed in body["filed"]) == ["b1", "t1", "t2"]  # never n1
    assert body["byCategory"] == {"groceries": 2, "petrol": 1}
    assert body["rulesConsidered"] == 2
    assert sorted(entry["ruleId"] for entry in body["byRule"]) == ["r1", "r2"]


def test_conflicted_cannot_arise_on_the_inline_path(handler, monkeypatch):
    # [A17] The card's claim to pin: with only the inline rule sweeping, nothing is left to
    # disagree, so `conflicted` is always 0 on the inline path. Two of her EXISTING rules
    # (NETFLIX->groceries, FLIX->petrol) both hit the NETFLIX charge and disagree — under the OLD
    # "all rules + inline" sweep that charge is conflicted:1 with a sample. Neither existing rule
    # clashes with the inline COLES rule (different text), so no 409 masks it. Under WHIT-523 the
    # sweep is COLES alone: conflicted 0, no samples, and the NETFLIX charge just stays unfiled.
    # FAIL-ON-REVERT: undo the one-liner -> conflicted becomes 1 and rulesConsidered 3.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342", category=None),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE", category=None),
        _row(SPENDING, "2026-07-01", "n1", description="NETFLIX.COM", category=None),
    ]})
    existing = [
        {"id": "r1", "field": "description", "operator": "contains", "value": "NETFLIX",
         "categoryId": "groceries", "conditionCount": 1},
        {"id": "r2", "field": "description", "operator": "contains", "value": "FLIX",
         "categoryId": "petrol", "conditionCount": 1},
    ]
    response, body, _ = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 200
    assert body["conflicted"] == 0 and body["conflictedSamples"] == []
    assert body["rulesConsidered"] == 1
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]  # n1 stays unfiled
    assert body["byCategory"] == {"groceries": 2}


def test_a_nested_agreeing_rules_charge_stays_unfiled_only_inline_text_files(handler, monkeypatch):
    # [A18] The exact boundary the card names. Existing COLES EXPRESS->groceries AND
    # WOOLWORTHS->groceries both AGREE with the inline COLES->groceries, so neither clashes (no
    # 409). Under WHIT-523 the inline COLES rule files what ITS OWN text matches — including the
    # nested-narrower COLES EXPRESS charge (its description contains "COLES") — but NOT the
    # WOOLWORTHS charge, which only her other rule matches. FAIL-ON-REVERT: undo the one-liner and
    # the WOOLWORTHS charge (w1) files too. Does NOT duplicate
    # test_a_nested_rule_to_the_SAME_category_is_still_fine (impl suite): that fixture has no
    # discriminating charge, so it passes under BOTH the scoped and the all-rules sweep.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-04", "t1", description="COLES 0342 RICHMOND", category=None),
        _row(SPENDING, "2026-07-03", "t2", description="COLES ONLINE", category=None),
        _row(SPENDING, "2026-07-02", "e1", description="COLES EXPRESS 5512", category=None),
        _row(SPENDING, "2026-07-01", "w1", description="WOOLWORTHS 4410", category=None),
    ]})
    existing = [
        {"id": "r1", "field": "description", "operator": "contains", "value": "COLES EXPRESS",
         "categoryId": "groceries", "conditionCount": 1},
        {"id": "r2", "field": "description", "operator": "contains", "value": "WOOLWORTHS",
         "categoryId": "groceries", "conditionCount": 1},
    ]
    response, body, _ = _apply(
        handler, monkeypatch, repo,
        {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 200
    # e1 (COLES EXPRESS) files because the inline COLES text matches it; w1 (WOOLWORTHS) does not.
    assert sorted(filed["id"] for filed in body["filed"]) == ["e1", "t1", "t2"]  # never w1
    assert body["byCategory"] == {"groceries": 3}
    assert body["rulesConsidered"] == 1


def test_a_preview_with_other_rules_counts_only_the_inline_rule(handler, monkeypatch):
    # [A19] The screen previews before minting, so the numbers it shows must be the scoped ones.
    # With an existing BP->petrol rule and a BP charge present, the preview must count ONLY the
    # inline COLES rule: matched 2, byCategory groceries-only, rulesConsidered 1, nothing minted.
    # Does NOT duplicate test_a_preview_shows_the_numbers_without_minting_anything (impl suite):
    # that fixture has no other rules, so its matched==2 holds under the all-rules sweep too.
    # FAIL-ON-REVERT: undo the one-liner -> matched 3, byCategory gains petrol, rulesConsidered 2.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342", category=None),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE", category=None),
        _row(SPENDING, "2026-07-01", "b1", description="BP 2210 SERVO", category=None),
    ]})
    existing = [{"id": "r1", "field": "description", "operator": "contains", "value": "BP 2210",
                 "categoryId": "petrol", "conditionCount": 1}]
    response, body, banksync = _apply(
        handler, monkeypatch, repo,
        {"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}},
        banksync=_BankSync(existing))

    assert response["statusCode"] == 200
    assert body["dryRun"] is True
    assert body["matched"] == 2
    assert body["byCategory"] == {"groceries": 2}
    assert body["rulesConsidered"] == 1
    assert body["createdRule"] is None and banksync.minted == [] and repo.writes == []
