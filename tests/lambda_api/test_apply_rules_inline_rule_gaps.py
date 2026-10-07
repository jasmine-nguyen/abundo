"""ADVERSARIAL gap tests for the inline `rule` on POST /transactions/uncategorized/apply-rules
(WHIT-516) — "make a rule for this shop AND file the charges it already has", in one request.

These do NOT duplicate tests/lambda_api/test_apply_rules_inline_rule.py. That suite locks the
card's spine: one request mints + files, a preview mints nothing, the inline rule is swept ALONE
(the existing rules read only to refuse a clash — WHIT-523), an absent rule is the old path,
mint-before-sweep ordering, create_rule failing, the floor / taxonomy / field-operator /
non-object / non-string fences, the shared floor identity, WHIT-508's hand-filed charge,
create_rule's dedup pass-through, and the route wiring.

What it does NOT lock, and this file does:

  * [A1] EVERY `rulePattern` the WHIT-515 merchant screen offers is ACCEPTED by this write half.
  * [A2] and the `count` the screen SHOWS is the number this route really FILES.
  * [A3] an existing rule on the same TEXT filing elsewhere is refused (409), across casing/spacing.
  * [A4] that refusal lands on the PREVIEW too.
  * [A5] but the same text to the SAME category is NOT a clash — the re-tap after a capped run works.
  * [A6] a NESTED existing rule is refused too, from either side. Nested rules that AGREE are fine.
  * [A7] a failure to READ her rules mints nothing.
  * [A8] a rejected inline rule costs no rules-read round trip at all (list_rules never called).
  * [A9] the read + write both reachable but every write errors: 200, rows in `failed`, rule STAYS minted.
  * [A10] the write cap with an inline rule: minted once, exactly the cap attempted, honest `remaining`.
  * [A11] tapping again after the cap finishes the job and rewrites NOTHING.
  * [A12] the TIME budget with an inline rule.
  * [A13] an accepted value is minted TRIMMED.
  * [A14] an explicit `"rule": null` is the plain sweep, not a 400.
  * [A15] DOCUMENTS A GAP: no maximum length, so a 500-character value is minted verbatim.

The real TransactionRepository and RuleRepository run over one FakeTable (WHIT-625), so a minted
rule is VISIBLE to the next request's list_rules — which is what really happens between two taps
of the same button.
"""

import json

import pytest

from _feed_fakes import SPENDING, WESTPAC, FakeCategoryRepo, Repos, charge_writes, fail_writes, _row
from _rule_ingest_fakes import apply_rules_to_uncategorized


def _existing(value, category_id):
    # The kwargs of one real RuleRepository.create_rule call — a rule she already has.
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id}


def _minted(run):
    return [(r["field"], r["operator"], r["value"], r["category_id"]) for r in run.minted_rules()]


def _apply(handler, rows_by_account, body, existing=(), categories=("groceries", "petrol"),
           run=None):
    if run is None:
        run = Repos(rows_by_account, rules=existing)
    event = {
        "rawPath": "/transactions/uncategorized/apply-rules",
        "requestContext": {"http": {"method": "POST"}},
        "body": json.dumps(body),
    }
    response = apply_rules_to_uncategorized(
        handler,
        event, run.transaction_repo, FakeCategoryRepo(categories), run.rule_repo)
    return response, json.loads(response["body"]), run


def _merchants(handler, rows_by_account, categories=("groceries", "petrol")):
    response = handler.get_uncategorized_merchants(
        Repos(rows_by_account).transaction_repo, FakeCategoryRepo(categories))
    return json.loads(response["body"])["groups"]


def _coles_rows():
    return {SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342 RICHMOND",
             merchant_name="Coles"),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE",
             merchant_name="Coles"),
    ]}


def _messy_rows():
    """Unfiled charges from deliberately awkward merchants: a unicode name, a punctuation-heavy
    one, and one whose only letters/digits are DIGITS — plus a nameless "PAYPAL *" charge the
    unicode merchant's rule sweeps in, so a group count taken from the merchant BUCKET rather
    than from the rule's real members would disagree with what gets filed."""
    return {
        SPENDING: [
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


def _offered_groups(handler):
    return _merchants(handler, _messy_rows())


# --- the seam with WHIT-515 ---------------------------------------------------


def test_a_wording_group_pattern_is_accepted_and_files_its_count(handler):
    # WHIT-519 seam: a nameless-charge WORDING group (grouped by trimming the trailing reference)
    # offers "OSKO PAYMENT". The write half must accept that pattern and file exactly the count
    # the screen showed — the same offered=accepted=filed contract merchant groups have.
    osko_rows = {SPENDING: [
        _row(SPENDING, "2026-07-03", "o1", description="OSKO PAYMENT 4471123", merchant_name=""),
        _row(SPENDING, "2026-07-02", "o2", description="OSKO PAYMENT 4471124", merchant_name=""),
    ]}

    offered = _merchants(handler, osko_rows, categories=("groceries",))
    wording = next(group for group in offered if group["groupedBy"] == "description")
    assert wording["rulePattern"] == "OSKO PAYMENT"

    _, body, run = _apply(
        handler, osko_rows,
        {"dryRun": False, "rule": {"value": wording["rulePattern"], "categoryId": "groceries"}})
    assert len(body["filed"]) == wording["count"] == 2
    assert _minted(run) == [("description", "contains", "OSKO PAYMENT", "groceries")]


def test_every_pattern_the_merchant_screen_offers_is_accepted_by_the_write_half(handler):
    # [A1] FAIL-ON-REVERT for the two halves agreeing on real data rather than on a shared
    # constant. The screen can only offer what group_unfiled_by_merchant produces; if this route
    # refuses any of it she taps "file this shop" and gets a 400 with no way forward.
    groups = _offered_groups(handler)
    patterns = [group["rulePattern"] for group in groups]
    # Guard the guard: an empty/collapsed group list would make the loop below vacuous.
    assert patterns == ["CAFÉ MÖRK", "1300 655 506", "J.B. HI-FI", "NETFLIX"]

    for pattern in patterns:
        response, body, run = _apply(
            handler, _messy_rows(),
            {"dryRun": True, "rule": {"value": pattern, "categoryId": "groceries"}})
        assert response["statusCode"] == 200, (pattern, body)
        assert run.minted_rules() == []


def test_the_count_the_merchant_screen_shows_is_the_number_this_route_really_files(handler):
    # [A2] FAIL-ON-REVERT for the seam's arithmetic, asserted between two REAL production
    # functions: merchant_groups' count and the sweep's own `filed` list. "COLES — 38 charges"
    # shown immediately before a bulk write has to be the 38 that move.
    for group in _offered_groups(handler):
        _, body, run = _apply(
            handler, _messy_rows(),
            {"dryRun": False, "rule": {"value": group["rulePattern"], "categoryId": "groceries"}})
        assert len(body["filed"]) == group["count"], group["rulePattern"]
        assert body["byCategory"] == {"groceries": group["count"]}
        assert len(run.table.update_calls) == group["count"]


# --- a conflict with a rule she already has -----------------------------------


def _nested_coles_rows():
    """COLES and COLES EXPRESS — the nesting the merchant screen discloses via `alsoCatches`.
    A rule on COLES sweeps the EXPRESS charge in too."""
    return {SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342 RICHMOND",
             merchant_name="Coles"),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE",
             merchant_name="Coles"),
        _row(SPENDING, "2026-07-01", "e1", description="COLES EXPRESS 5512",
             merchant_name="Coles Express"),
    ]}


@pytest.mark.parametrize("existing_value", ["COLES", "coles", "  Coles  "])
def test_an_existing_rule_on_the_same_text_filing_elsewhere_is_refused(handler, existing_value):
    # [A3] She already has COLES -> petrol and the screen offers COLES; filing it to groceries
    # would leave the two rules permanently disagreeing, so every COLES charge is conflicted and
    # NEVER filed — on this run or any future one. Refused outright, and the casing/spacing
    # variants must be caught too (the same merchant is spelled inconsistently in real rules).
    rows = _nested_coles_rows()
    existing = [_existing(existing_value, "petrol")]
    response, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        existing=existing)

    assert response["statusCode"] == 409
    assert body["existingRule"]["id"] == run.rule_id(existing_value)
    assert "petrol" in body["error"]
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_the_preview_refuses_that_clash_too(handler):
    # [A4] The refusal must land on the PREVIEW, not only the commit — otherwise the screen
    # shows her a number, she taps, and only then is she told it can't be done.
    rows = _nested_coles_rows()
    existing = [_existing("COLES", "petrol")]
    response, _, run = _apply(
        handler, rows, {"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}},
        existing=existing)

    assert response["statusCode"] == 409
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_an_existing_rule_on_the_same_text_to_the_SAME_category_is_not_a_clash(handler):
    # [A5] The guard must not eat the legitimate re-tap: after a capped run the rule EXISTS, and
    # tapping again sends the same inline rule to the same category. A 409 there would strand
    # every charge past the cap, permanently unfilable through this screen. Seeded id-less so the
    # inline mint dedups onto it (create_rule keys on the real rule_id_for id).
    rows = _nested_coles_rows()
    existing = [_existing("coles", "groceries")]
    response, body, _ = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        existing=existing)

    assert response["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["e1", "t1", "t2"]


def test_a_NESTED_existing_rule_is_refused_too_not_just_an_exact_repeat(handler):
    # [A6] The likeliest conflict of the lot, and the one an equality-only guard waves straight
    # through. An existing "COLES EXPRESS -> petrol" is different TEXT from an inline
    # "COLES -> groceries", but every EXPRESS charge matches both — so they fight, and a charge
    # two rules disagree about is never filed, on this run or any future one.
    #
    # Minting would file the 2 plain COLES charges, strand the EXPRESS one for good, and return
    # 200 with a bare `conflicted: 1`. The screen said 3. This is the inline-MORE-GENERAL direction:
    # the sweep narrows to the inline COLES rule, which would steamroll the existing COLES EXPRESS
    # rule's charge into groceries. WHIT-518 keeps refusing THIS direction (the reverse — a more
    # specific inline — is now allowed; see the next test).
    offered = _merchants(handler, _nested_coles_rows())
    group = next(g for g in offered if g["rulePattern"] == "COLES")
    assert group["count"] == 3
    assert group["alsoCatches"] == [{"merchant": "Coles Express", "count": 1}]

    rows = _nested_coles_rows()
    existing = [_existing("COLES EXPRESS", "petrol")]
    response, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        existing=existing)

    assert response["statusCode"] == 409
    assert body["existingRule"]["id"] == run.rule_id("COLES EXPRESS")
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_a_more_specific_inline_rule_is_now_allowed(handler):
    # [WHIT-518] The reverse of the case above: an existing rule on the WIDER text ("COLES" ->
    # groceries), an inline rule on the NARROWER one ("COLES EXPRESS" -> petrol). This is the
    # inline-MORE-SPECIFIC direction, now ALLOWED — the narrowed sweep files only the inline rule's
    # OWN charges (e1), and a full "Apply my rules" would resolve the same charge to petrol by
    # most-specific-wins, so the two paths agree. The plain COLES charges (t1, t2) are untouched.
    # FAIL-ON-REVERT: a symmetric (two-way) clash check would 409 this and file nothing.
    rows = _nested_coles_rows()
    existing = [_existing("COLES", "groceries")]
    response, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES EXPRESS", "categoryId": "petrol"}},
        existing=existing)

    assert response["statusCode"] == 200
    assert [filed["id"] for filed in body["filed"]] == ["e1"]      # only the EXPRESS charge
    assert body["byCategory"] == {"petrol": 1}
    assert len(run.minted_rules()) == 1 and run.minted_rules()[0]["value"] == "COLES EXPRESS"
    assert charge_writes(run.table) == [(f"ACCOUNT#{SPENDING}", "TXN#e1")]   # t1/t2 never touched


def test_a_nested_more_general_inline_is_refused_on_the_PREVIEW_too(handler):
    # The more-general inline clash must 409 on the PREVIEW (dryRun), not only on commit — otherwise
    # the screen shows a number then fails when she taps. FAIL-ON-REVERT: an allow-all predicate -> 200.
    rows = _nested_coles_rows()
    existing = [_existing("COLES EXPRESS", "petrol")]
    response, body, run = _apply(
        handler, rows, {"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}},
        existing=existing)

    assert response["statusCode"] == 409
    assert body["existingRule"]["id"] == run.rule_id("COLES EXPRESS")
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_inline_between_a_more_general_and_a_more_specific_existing_rule_is_refused(handler):
    # A three-rule store the per-rule loop must judge one at a time: the existing "COLES" is MORE
    # GENERAL than the inline "COLES EXPRESS" (safe to be more specific than), but the existing
    # "COLES EXPRESS STATION" is MORE SPECIFIC than it and would be steamrolled. Minting must 409,
    # naming the specific rule — not be waved through just because one existing rule is safe.
    rows = _nested_coles_rows()
    existing = [_existing("COLES", "groceries"), _existing("COLES EXPRESS STATION", "coffee")]
    response, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES EXPRESS", "categoryId": "petrol"}},
        existing=existing, categories=("groceries", "petrol", "coffee"))

    assert response["statusCode"] == 409
    assert body["existingRule"]["id"] == run.rule_id("COLES EXPRESS STATION")
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_inline_specific_files_a_co_occurring_charge_a_full_sweep_would_conflict(handler):
    # BEHAVIOUR-LOCK (acceptable-for-scope, pre-dates WHIT-518): an unrelated existing "5512" ->
    # utilities rule is NOT nested with the inline "COLES EXPRESS", so it is not a clash and minting
    # is allowed. The narrowed "file this shop" sweep runs ONLY the inline rule (WHIT-523), so
    # "COLES EXPRESS 5512" is filed to petrol — even though a full "Apply my rules" would leave it
    # conflicted. Locked as CURRENT behaviour so any future change is a conscious one.
    rows = _nested_coles_rows()
    existing = [_existing("5512", "utilities")]
    response, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES EXPRESS", "categoryId": "petrol"}},
        existing=existing, categories=("groceries", "petrol", "utilities"))

    assert response["statusCode"] == 200
    assert [filed["id"] for filed in body["filed"]] == ["e1"]
    assert body["byCategory"] == {"petrol": 1}
    assert run.table.store[(f"ACCOUNT#{SPENDING}", "TXN#e1")]["category"] == "petrol"


def test_a_nested_rule_to_the_SAME_category_is_still_fine(handler):
    # Overlap only matters when the two DISAGREE. "COLES EXPRESS -> groceries" and
    # "COLES -> groceries" both file to the same place, so nothing conflicts and the charges
    # file normally. Refusing on overlap alone would block a perfectly sensible pair.
    rows = _nested_coles_rows()
    existing = [_existing("COLES EXPRESS", "groceries")]
    response, body, _ = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        existing=existing)

    assert response["statusCode"] == 200
    assert sorted(filed["id"] for filed in body["filed"]) == ["e1", "t1", "t2"]


# --- failure modes ------------------------------------------------------------


def test_a_failure_to_read_her_rules_mints_nothing(handler):
    # [A7] The inline rule must not be minted when we could not read the rules it must check for
    # a clash before minting. Minting first would leave a rule behind for a request that failed.
    # WHIT-531: the read is our store, so its failure is a DatabaseError -> 500 (our server).
    run = Repos(_coles_rows())
    run.table.fail("query")
    response, _, _ = _apply(
        handler, None, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        run=run)

    assert response["statusCode"] == 500
    assert run.minted_rules() == [] and run.table.update_calls == []


def test_a_rejected_inline_rule_costs_no_rules_read(handler):
    # [A8] A typo must be free. Reading her rules first and 400ing after makes every rejected
    # tap pay for a database read — the inline fences run BEFORE the rules read, so list_rules is
    # never even called for a bad value.
    run = Repos(_coles_rows())
    response, _, _ = _apply(
        handler, None, {"dryRun": False, "rule": {"value": "BP", "categoryId": "groceries"}},
        run=run)

    assert response["statusCode"] == 400
    assert run.table.queries == []          # no rules read, no history scan
    assert run.minted_rules() == []


def test_the_rule_stays_minted_when_every_write_fails(handler):
    # [A9] The recoverable state the mint-before-sweep ordering promises: the rule exists, the
    # charges did not move, and tapping again finishes the job. A 500 here would be a lie (the
    # rule DID get made) and would hide which rows still need retrying.
    run = Repos(_coles_rows())
    fail_writes(run.table, "t1", "t2")
    response, body, _ = _apply(
        handler, None, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        run=run)

    assert response["statusCode"] == 200
    assert body["createdRule"]["id"] == run.minted_rules()[0]["id"]
    assert body["filed"] == []
    assert sorted(body["failed"]) == ["t1", "t2"]
    assert len(run.minted_rules()) == 1


# --- the write cap and the time budget ----------------------------------------


def test_the_write_cap_stops_the_sweep_with_the_rule_minted_once(handler):
    # [A10] Asserted against the REAL cap constant, so raising or lowering it can't silently
    # desync this from production.
    cap = handler.APPLY_RULES_MAX_WRITES
    rows = {SPENDING: [
        _row(SPENDING, "2026-07-01", f"t{index:04d}", description=f"COLES {index}",
             merchant_name="Coles")
        for index in range(cap + 25)
    ]}
    _, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert len(run.minted_rules()) == 1
    assert body["matched"] == cap + 25
    assert len(body["filed"]) == cap
    assert body["remaining"] == 25


def test_tapping_again_after_the_cap_finishes_the_job_and_rewrites_nothing(handler):
    # [A11] The DB-write half of safe-to-run-twice across the cap boundary, which the impl
    # suite's rule-dedup test does not reach. The first `cap` are FILED, so the second request's
    # scan no longer sees them — no row is written twice even though the rule is now BOTH in her
    # store and re-sent inline. The SAME rule store spans both taps, so the mint from the first
    # is visible (and deduped) on the second.
    cap = handler.APPLY_RULES_MAX_WRITES
    rows = {SPENDING: [
        _row(SPENDING, "2026-07-01", f"t{index:04d}", description=f"COLES {index}",
             merchant_name="Coles")
        for index in range(cap + 25)
    ]}
    run = Repos(rows)
    request = {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}}

    _, first, _ = _apply(handler, None, request, run=run)
    _, second, _ = _apply(handler, None, request, run=run)

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


def test_the_time_budget_stops_the_sweep_with_the_rule_already_minted(handler, monkeypatch):
    # [A12] A fixed clock, never the ambient one. The `attempted and` guard is load-bearing:
    # without it a slow rule read would return zero filed rows forever and the app would retry
    # the same request for ever.
    class _Clock:
        def __init__(self, ticks):
            self._ticks = iter(ticks)

        def monotonic(self):
            return next(self._ticks)

    rows = {SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES A", merchant_name="Coles"),
        _row(SPENDING, "2026-07-02", "t2", description="COLES B", merchant_name="Coles"),
        _row(SPENDING, "2026-07-01", "t3", description="COLES C", merchant_name="Coles"),
    ]}
    over = handler.APPLY_RULES_TIME_BUDGET_SECONDS + 1.0
    monkeypatch.setattr(handler, "time", _Clock([0.0] + [over] * 20))

    _, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}})

    assert len(run.minted_rules()) == 1
    assert len(body["filed"]) == 1          # at least one row always moves
    assert body["matched"] == 3
    assert body["remaining"] == 2           # "tap again", and it is honest about how much


# --- value handling -----------------------------------------------------------


@pytest.mark.parametrize("value", ["  COLES  ", "\tCOLES\n", "COLES "])
def test_an_accepted_value_is_minted_trimmed(handler, value):
    # [A13] The impl suite only covers whitespace values that are REJECTED, so the strip on the
    # accepted path was unasserted. It matters beyond tidiness: the minted value is what the store
    # keeps and what the client's duplicate-rule guard folds against, and a stray trailing space
    # would make the same rule mintable twice.
    rows = _coles_rows()
    _, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": value, "categoryId": "groceries"}})

    assert _minted(run) == [("description", "contains", "COLES", "groceries")]
    assert body["createdRule"]["value"] == "COLES"
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_an_explicit_null_rule_is_the_plain_sweep_not_a_400(handler):
    # [A14] The app serialising an absent rule as JSON null must not become a 400 — and must
    # not become a mint either.
    rows = _coles_rows()
    existing = [_existing("COLES", "groceries")]
    response, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": None}, existing=existing)

    assert response["statusCode"] == 200
    assert run.minted_rules() == [] and body["createdRule"] is None
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]


def test_a_very_long_value_is_minted_verbatim_and_files_nothing(handler):
    # [A15] DOCUMENTS A GAP — there is no maximum length on the inline value. A 500-character
    # value clears the letters/digits floor, is stored as-is, and matches nothing. Pinned so
    # adding a cap is a deliberate change rather than a silent one. Ranked in the critique.
    rows = _coles_rows()
    value = "COLES" + "X" * 500
    response, body, run = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": value, "categoryId": "groceries"}})

    assert response["statusCode"] == 200
    assert _minted(run) == [("description", "contains", value, "groceries")]
    assert body["filed"] == [] and run.table.update_calls == []


# --- WHIT-523 scope: what the inline rule sweeps vs what it must NOT --------------


def test_the_plain_sweep_still_files_across_ALL_her_rules(handler):
    # [A16] REGRESSION GUARD — the worst outcome of WHIT-523 would be the scoping leaking onto the
    # plain "Apply my rules" button (no inline rule), quietly filing only ONE of her rules. With no
    # inline `rule`, EVERY rule must still sweep: a COLES charge AND a BP charge both file, to their
    # own categories, and both rules show in byRule.
    rows = {SPENDING: [
        _row(SPENDING, "2026-07-04", "t1", description="COLES 0342"),
        _row(SPENDING, "2026-07-03", "t2", description="COLES ONLINE"),
        _row(SPENDING, "2026-07-02", "b1", description="BP 2210 SERVO"),
        _row(SPENDING, "2026-07-01", "n1", description="NETFLIX.COM"),
    ]}
    existing = [_existing("COLES", "groceries"), _existing("BP 2210", "petrol")]
    response, body, run = _apply(handler, rows, {"dryRun": False}, existing=existing)

    assert response["statusCode"] == 200
    assert run.minted_rules() == [] and body["createdRule"] is None    # plain path mints nothing
    assert sorted(filed["id"] for filed in body["filed"]) == ["b1", "t1", "t2"]  # never n1
    assert body["byCategory"] == {"groceries": 2, "petrol": 1}
    assert body["rulesConsidered"] == 2
    assert sorted(entry["ruleId"] for entry in body["byRule"]) == sorted(
        [run.rule_id("COLES"), run.rule_id("BP 2210")])


def test_conflicted_cannot_arise_on_the_inline_path(handler):
    # [A17] The card's claim to pin: with only the inline rule sweeping, nothing is left to
    # disagree, so `conflicted` is always 0 on the inline path. Two of her EXISTING rules
    # (NETFLIX->groceries, FLIX->petrol) both hit the NETFLIX charge and disagree — under the OLD
    # "all rules + inline" sweep that charge is conflicted:1 with a sample. Neither existing rule
    # clashes with the inline COLES rule (different text), so no 409 masks it. Under WHIT-523 the
    # sweep is COLES alone: conflicted 0, no samples, and the NETFLIX charge just stays unfiled.
    rows = {SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342"),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE"),
        _row(SPENDING, "2026-07-01", "n1", description="NETFLIX.COM"),
    ]}
    existing = [_existing("NETFLIX", "groceries"), _existing("FLIX", "petrol")]
    response, body, _ = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        existing=existing)

    assert response["statusCode"] == 200
    assert body["conflicted"] == 0 and body["conflictedSamples"] == []
    assert body["rulesConsidered"] == 1
    assert sorted(filed["id"] for filed in body["filed"]) == ["t1", "t2"]  # n1 stays unfiled
    assert body["byCategory"] == {"groceries": 2}


def test_a_nested_agreeing_rules_charge_stays_unfiled_only_inline_text_files(handler):
    # [A18] The exact boundary the card names. Existing COLES EXPRESS->groceries AND
    # WOOLWORTHS->groceries both AGREE with the inline COLES->groceries, so neither clashes (no
    # 409). Under WHIT-523 the inline COLES rule files what ITS OWN text matches — including the
    # nested-narrower COLES EXPRESS charge (its description contains "COLES") — but NOT the
    # WOOLWORTHS charge, which only her other rule matches.
    rows = {SPENDING: [
        _row(SPENDING, "2026-07-04", "t1", description="COLES 0342 RICHMOND"),
        _row(SPENDING, "2026-07-03", "t2", description="COLES ONLINE"),
        _row(SPENDING, "2026-07-02", "e1", description="COLES EXPRESS 5512"),
        _row(SPENDING, "2026-07-01", "w1", description="WOOLWORTHS 4410"),
    ]}
    existing = [_existing("COLES EXPRESS", "groceries"), _existing("WOOLWORTHS", "groceries")]
    response, body, _ = _apply(
        handler, rows, {"dryRun": False, "rule": {"value": "COLES", "categoryId": "groceries"}},
        existing=existing)

    assert response["statusCode"] == 200
    # e1 (COLES EXPRESS) files because the inline COLES text matches it; w1 (WOOLWORTHS) does not.
    assert sorted(filed["id"] for filed in body["filed"]) == ["e1", "t1", "t2"]  # never w1
    assert body["byCategory"] == {"groceries": 3}
    assert body["rulesConsidered"] == 1


def test_a_preview_with_other_rules_counts_only_the_inline_rule(handler):
    # [A19] The screen previews before minting, so the numbers it shows must be the scoped ones.
    # With an existing BP->petrol rule and a BP charge present, the preview must count ONLY the
    # inline COLES rule: matched 2, byCategory groceries-only, rulesConsidered 1, nothing minted.
    rows = {SPENDING: [
        _row(SPENDING, "2026-07-03", "t1", description="COLES 0342"),
        _row(SPENDING, "2026-07-02", "t2", description="COLES ONLINE"),
        _row(SPENDING, "2026-07-01", "b1", description="BP 2210 SERVO"),
    ]}
    existing = [_existing("BP 2210", "petrol")]
    response, body, run = _apply(
        handler, rows, {"dryRun": True, "rule": {"value": "COLES", "categoryId": "groceries"}},
        existing=existing)

    assert response["statusCode"] == 200
    assert body["dryRun"] is True
    assert body["matched"] == 2
    assert body["byCategory"] == {"groceries": 2}
    assert body["rulesConsidered"] == 1
    assert body["createdRule"] is None and run.minted_rules() == [] and run.table.update_calls == []
