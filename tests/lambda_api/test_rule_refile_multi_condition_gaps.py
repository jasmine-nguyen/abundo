"""WHIT-561 GAP tests: editing a MULTI-condition rule (WHIT-540 re-file path).

The multi rule is CREATED through create_rule_route first, so its id is the real canonical id (the
lambda_api suite forbids importing rule_engine at collection time). Then charges are stamped with
that id and the rule is PUT-edited. Probes:
  * in-place edit (same conditions, category change): id stable, conditions preserved on the row,
    owned charges re-filed to the new target.
  * conditions-changing edit on a DESCRIPTION-first multi rule: id moves (old row deleted, new
    written) AND RuleBook.refile_touched re-evaluates via rule_matches -> a charge that no longer
    matches the tightened conditions is CLEARED.
  * conditions-changing edit on a MERCHANT-first multi rule ALSO re-evaluates (WHIT-561 B1 fix):
    the safe-to-re-evaluate test is "does not match on `category`", NOT "first field is
    description", so a merchant/amount rule's stale filings are cleared, not blindly moved.
"""

import json

from _api_event import api_event
from _feed_fakes import SPENDING, FakeCategoryRepo, real_repos, _row, stored


_CATEGORIES = frozenset({"transport", "groceries", "petrol"})


def _create_event(conditions, logic="all", category_id="transport"):
    return api_event(
        "POST",
        "/rules",
        body={"conditions": conditions, "logic": logic,
              "categoryId": category_id},
    )


def _put_event(rule_id, conditions, logic="all", category_id="transport"):
    return api_event(
        "PUT",
        f"/rules/{rule_id}",
        body={"conditions": conditions, "logic": logic,
              "categoryId": category_id},
        path_params={"id": rule_id},
    )


def _mint(handler, rule_repo, transaction_repo, conditions, logic="all", category_id="transport"):
    # A non-spread create never reads the transaction repo; it only satisfies the signature.
    resp = handler.create_rule_route(
        _create_event(conditions, logic, category_id), rule_repo, FakeCategoryRepo(_CATEGORIES),
        transaction_repo)
    return json.loads(resp["body"])["id"]


_UBER_UNDER_30 = [{"field": "merchant", "operator": "contains", "value": "uber"},
                  {"field": "amount", "operator": "less_than", "value": "30"}]


def test_in_place_category_edit_preserves_conditions_and_keeps_the_id(handler):
    # [G-rf1] Edit ONLY the target category of a multi rule. The conditions are unchanged, so the id
    # is stable; the stored row must keep its conditions/logic (the in-place update re-writes them so
    # they can't go stale), and the owned charge is re-filed to the new target under the SAME id.
    table, repo, rule_repo = real_repos()
    rid = _mint(handler, rule_repo, repo, _UBER_UNDER_30, category_id="transport")

    table.seed(
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", merchant_name="UBER",
             amount=-25, category="transport", filed_by_rule=rid))

    resp = handler.update_rule_route(
        _put_event(rid, _UBER_UNDER_30, category_id="groceries"),
        rule_repo, FakeCategoryRepo(_CATEGORIES), repo)
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["id"] == rid                                   # id stable
    assert body["conditions"] == _UBER_UNDER_30 and body["logic"] == "all"
    rule_row = rule_repo.get_rule(rid)
    assert rule_row["conditions"] == _UBER_UNDER_30            # conditions preserved on the row
    assert rule_row["category_id"] == "groceries"
    row = stored(table, "t1")
    assert row["category"] == "groceries" and row["filed_by_rule"] == rid   # re-filed in place


def test_conditions_change_moves_the_id_and_deletes_the_old_row(handler):
    # [G-rf2] Tighten a DESCRIPTION-first multi rule's amount condition. The conditions changed, so
    # the id MOVES: the old row is deleted, a new row written, and the response carries the new id.
    conditions = [{"field": "description", "operator": "contains", "value": "uber"},
                  {"field": "amount", "operator": "less_than", "value": "30"}]
    tighter = [{"field": "description", "operator": "contains", "value": "uber"},
               {"field": "amount", "operator": "less_than", "value": "10"}]
    table, repo, rule_repo = real_repos()
    old = _mint(handler, rule_repo, repo, conditions)

    resp = handler.update_rule_route(
        _put_event(old, tighter), rule_repo, FakeCategoryRepo(_CATEGORIES), repo)
    body = json.loads(resp["body"])
    new = body["id"]

    assert new != old
    assert rule_repo.get_rule(old) is None                    # old row deleted
    assert rule_repo.get_rule(new)["conditions"] == tighter    # new row written
    assert [rule["id"] for rule in rule_repo.list_rules()] == [new]


def test_conditions_change_on_a_description_multi_reevaluates_and_clears_a_non_match(handler):
    # [G-rf3] THE WHIT-540 re-evaluation for a multi rule. A $25 UBER charge was filed by
    # "description contains uber AND amount < 30". The rule is edited to amount < 10 (a DESCRIPTION-
    # first multi whose id changed) -> RuleBook.refile_touched re-evaluates via rule_matches: $25 is not
    # < $10, so the charge is CLEARED (not blindly moved). FAIL-ON-REVERT: if rule_matches ignored the
    # amount condition, the charge would be wrongly re-filed instead of cleared.
    conditions = [{"field": "description", "operator": "contains", "value": "uber"},
                  {"field": "amount", "operator": "less_than", "value": "30"}]
    tighter = [{"field": "description", "operator": "contains", "value": "uber"},
               {"field": "amount", "operator": "less_than", "value": "10"}]
    table, repo, rule_repo = real_repos()
    old = _mint(handler, rule_repo, repo, conditions)

    table.seed(
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", amount=-25,
             category="transport", filed_by_rule=old))

    handler.update_rule_route(_put_event(old, tighter), rule_repo,
                              FakeCategoryRepo(_CATEGORIES), repo)

    row = stored(table, "t1")
    assert "category" not in row and "filed_by_rule" not in row   # no longer matches -> cleared


def test_conditions_change_on_a_description_multi_reevaluates_and_refiles_a_match(handler):
    # [G-rf4] Same edit, but a $5 charge STILL matches amount < 10 -> re-filed to the new id and
    # re-keyed. Guards that the re-evaluation isn't clearing everything.
    conditions = [{"field": "description", "operator": "contains", "value": "uber"},
                  {"field": "amount", "operator": "less_than", "value": "30"}]
    tighter = [{"field": "description", "operator": "contains", "value": "uber"},
               {"field": "amount", "operator": "less_than", "value": "10"}]
    table, repo, rule_repo = real_repos()
    old = _mint(handler, rule_repo, repo, conditions, category_id="transport")

    table.seed(
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", amount=-5,
             category="transport", filed_by_rule=old))

    resp = handler.update_rule_route(
        _put_event(old, tighter, category_id="petrol"), rule_repo,
        FakeCategoryRepo(_CATEGORIES), repo)
    new = json.loads(resp["body"])["id"]

    row = stored(table, "t1")
    assert row["category"] == "petrol" and row["filed_by_rule"] == new   # still matches -> re-filed


def test_conditions_change_on_a_merchant_first_multi_reevaluates_and_clears_a_non_match(handler):
    # [G-rf5] THE B1 REGRESSION LOCK. A $25 UBER charge was filed by a MERCHANT-first multi rule
    # "merchant contains uber AND amount < 30". Tighten it to amount < 10. The rule's first flat
    # field is `merchant`, NOT `description` — under the old `field == "description"` gate the edit
    # would blindly RE-FILE the charge to the new target without re-checking, leaving a stale filing
    # ($25 is not < $10). With the WHIT-561 fix (re-evaluate any rule that doesn't match on
    # `category`) the charge is correctly CLEARED. FAIL-ON-REVERT: restore `field == "description"`
    # and this charge is wrongly moved to `petrol` instead of cleared.
    tighter = [{"field": "merchant", "operator": "contains", "value": "uber"},
               {"field": "amount", "operator": "less_than", "value": "10"}]
    table, repo, rule_repo = real_repos()
    old = _mint(handler, rule_repo, repo, _UBER_UNDER_30, category_id="transport")

    table.seed(
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", merchant_name="UBER",
             amount=-25, category="transport", filed_by_rule=old))

    handler.update_rule_route(
        _put_event(old, tighter, category_id="petrol"), rule_repo,
        FakeCategoryRepo(_CATEGORIES), repo)

    row = stored(table, "t1")
    assert "category" not in row and "filed_by_rule" not in row   # no longer matches -> cleared


def test_conditions_change_on_a_merchant_first_multi_reevaluates_and_refiles_a_match(handler):
    # [G-rf6] B1 companion: a $5 UBER charge STILL matches the tightened merchant-first rule
    # (amount < 10) -> re-filed to the new target under the new id. Guards the re-evaluation isn't
    # clearing every merchant-first charge.
    tighter = [{"field": "merchant", "operator": "contains", "value": "uber"},
               {"field": "amount", "operator": "less_than", "value": "10"}]
    table, repo, rule_repo = real_repos()
    old = _mint(handler, rule_repo, repo, _UBER_UNDER_30, category_id="transport")

    table.seed(
        _row(SPENDING, "2026-07-01", "t1", description="UBER TRIP", merchant_name="UBER",
             amount=-5, category="transport", filed_by_rule=old))

    resp = handler.update_rule_route(
        _put_event(old, tighter, category_id="petrol"), rule_repo,
        FakeCategoryRepo(_CATEGORIES), repo)
    new = json.loads(resp["body"])["id"]

    row = stored(table, "t1")
    assert row["category"] == "petrol" and row["filed_by_rule"] == new   # still matches -> re-filed
