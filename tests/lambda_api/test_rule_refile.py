"""WHIT-540 — editing a rule re-files the charges it already filed; deleting a rule undoes them.

Drives update_rule_route / delete_rule_route directly (like test_apply_rules drives its route), so
the store->client mapping (rule_book.rule_from_row), the re-file helper (RuleBook.refile_touched) and the two
stamp-conditioned repository writes are all exercised end to end: the real TransactionRepository and
RuleRepository run over one FakeTable.

Rule ids come from rule_engine.rule_id_for (the id IS the folded text). The OLD id is read back from
the real RuleRepository that minted it, and the NEW id (after a text edit) from the response body.

The invariant everything leans on: a charge still carries `filed_by_rule == <id>` ONLY while the
user hasn't hand-filed it since (a manual file REMOVEs the stamp, WHIT-536). So "scan for the
stamp" returns exactly the rule-owned, user-untouched charges — the user's own choices are excluded
by construction, and the writes below re-confirm the stamp so a tap in the scan->write gap wins.
"""

import json

from _api_event import api_event
from _feed_fakes import (
    ANZ, SPENDING, FakeCategoryRepo, charge_writes, real_repos, rule_delete_event, rule_put_event,
    _row, stored,
)


_CATEGORIES = frozenset({"groceries", "petrol", "eatingout", "transport"})


def _rule(value, category_id="groceries", field="description", operator="contains", **extra):
    return {"field": field, "operator": operator, "value": value, "category_id": category_id,
            **extra}


def _seed_rule(value, category_id="groceries", field="description", operator="contains", **extra):
    """Real repos over one table holding one rule, plus the id the store minted (== the stamp)."""
    table, txn_repo, rule_repo = real_repos(rules=[_rule(value, category_id, field, operator, **extra)])
    return table, txn_repo, rule_repo, rule_repo.list_rules()[0]["id"]


def _update(handler, rule_repo, txn_repo, event, categories=_CATEGORIES):
    resp = handler.update_rule_route(event, rule_repo, FakeCategoryRepo(categories), txn_repo)
    return resp, json.loads(resp["body"])


def _delete(handler, rule_repo, txn_repo, event):
    resp = handler.delete_rule_route(event, rule_repo, txn_repo)
    return resp, json.loads(resp["body"])


# --- edit a description rule: material value change re-evaluates ----------------


def test_edit_description_value_refiles_matches_and_clears_non_matches(handler):
    # "coles" -> "coles express" (a real value edit -> a NEW id). A charge that still matches the new
    # value moves to the new target and is re-keyed; one that no longer matches is un-filed.
    table, repo, rule_repo, old = _seed_rule("coles", "groceries")
    table.seed(
        _row(SPENDING, "2026-07-02", "still", description="COLES EXPRESS PETROL",
             category="groceries", filed_by_rule=old),
        _row(SPENDING, "2026-07-01", "gone", description="COLES 1",
             category="groceries", filed_by_rule=old),
    )

    resp, body = _update(handler, rule_repo, repo, rule_put_event(old, "coles express", "petrol"))
    new = body["id"]

    assert resp["statusCode"] == 200 and new != old and body["remaining"] == 0
    still = stored(table, "still")
    assert still["category"] == "petrol" and still["filed_by_rule"] == new  # re-filed + re-keyed
    gone = stored(table, "gone")
    assert "category" not in gone and "filed_by_rule" not in gone           # no longer matches -> cleared


def test_tightening_a_merchant_first_multi_rule_reevaluates_its_charges(handler):
    # THE WHIT-561 B1 REGRESSION LOCK. Two UBER charges were filed by a MERCHANT-first multi rule
    # "merchant contains uber AND amount < 30". Tighten it to amount < 10 -> petrol. The rule's
    # first flat field is `merchant`, NOT `description` — under the old `field == "description"`
    # gate the edit would blindly re-file both. With the fix (re-evaluate any rule that doesn't
    # match on `category`) the $25 charge is CLEARED and the $5 one re-filed under the new id.
    # FAIL-ON-REVERT: restore `field == "description"` and the $25 charge moves to petrol.
    under_30 = [{"field": "merchant", "operator": "contains", "value": "uber"},
                {"field": "amount", "operator": "less_than", "value": "30"}]
    under_10 = [{"field": "merchant", "operator": "contains", "value": "uber"},
                {"field": "amount", "operator": "less_than", "value": "10"}]
    table, repo, rule_repo, old = _seed_rule(
        "uber", "transport", field="merchant", conditions=under_30, logic="all")
    table.seed(
        _row(SPENDING, "2026-07-02", "t25", description="UBER TRIP", merchant_name="UBER",
             amount=-25, category="transport", filed_by_rule=old),
        _row(SPENDING, "2026-07-01", "t5", description="UBER TRIP", merchant_name="UBER",
             amount=-5, category="transport", filed_by_rule=old),
    )
    event = api_event("PUT", f"/rules/{old}", path_params={"id": old},
                      body={"conditions": under_10, "logic": "all", "categoryId": "petrol"})

    _, body = _update(handler, rule_repo, repo, event)
    new = body["id"]

    assert new != old
    cleared = stored(table, "t25")
    assert "category" not in cleared and "filed_by_rule" not in cleared   # no longer matches
    refiled = stored(table, "t5")
    assert refiled["category"] == "petrol" and refiled["filed_by_rule"] == new   # still matches


def test_turning_a_rules_flag_on_does_not_exclude_already_filed_charges(handler):
    # WHIT-558 "forward only": the re-file path re-keys category + stamp, never budget_excluded. A
    # rule (flag OFF) already filed a charge; the user edits the target and turns "keep out of
    # budget" ON. The charge moves but stays counted until it is filed fresh. FAIL-ON-REVERT if
    # the re-file path ever starts carrying the flag: this row gains budget_excluded.
    table, repo, rule_repo, rid = _seed_rule("coles", "groceries", budget_excluded=False)
    table.seed(
        _row(SPENDING, "2026-07-02", "a", description="COLES 1",
             category="groceries", filed_by_rule=rid),
    )

    resp, _ = _update(handler, rule_repo, repo,
                      rule_put_event(rid, "coles", "petrol", budgetExcluded=True))

    assert resp["statusCode"] == 200
    # The rule row DID take the flag (forward, for future fills)…
    assert rule_repo.get_rule(rid)["budget_excluded"] is True
    row = stored(table, "a")
    assert row["category"] == "petrol"              # re-filed to the new target
    assert "budget_excluded" not in row             # …but the OLD charge is untouched (forward only)


# --- tap-wins and isolation -----------------------------------------------------


def test_edit_leaves_a_charge_the_user_refiled_since(handler):
    # The user hand-filed "t1" after the rule filed it, so its stamp was REMOVEd (WHIT-536). This
    # guards the SCAN-LEVEL filter: with no stamp it isn't in `touched`, so no write is attempted
    # (asserted via charge_writes(table) == []). The write CONDITION's own tap-wins guard is
    # fail-on-revert-covered in test_repository_transaction.py.
    table, repo, rule_repo, old = _seed_rule("coles", "groceries")
    table.seed(
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1", category="coffee"),  # no stamp
    )

    _update(handler, rule_repo, repo, rule_put_event(old, "coles", "petrol"))

    assert stored(table, "t1")["category"] == "coffee"   # user's choice stands
    assert charge_writes(table) == []                           # never even attempted


# --- delete a rule: undo its fills ----------------------------------------------


def test_delete_clears_every_charge_the_rule_filed(handler):
    table, repo, rule_repo, rid = _seed_rule("coles", "groceries")
    table.seed(
        _row(SPENDING, "2026-07-02", "a", description="COLES 1", category="groceries", filed_by_rule=rid),
        _row(ANZ, "2026-07-01", "b", description="COLES 2", category="groceries", filed_by_rule=rid),
    )

    resp, body = _delete(handler, rule_repo, repo, rule_delete_event(rid))

    assert resp["statusCode"] == 200 and body == {"id": rid, "remaining": 0}
    for txn_id, account in (("a", SPENDING), ("b", ANZ)):    # across every account
        row = stored(table, txn_id, account)
        assert "category" not in row and "filed_by_rule" not in row   # back to unfiled


# --- the write budget: a rule on more charges than one request can finish -------


def test_remaining_counts_charges_beyond_the_write_budget(handler, monkeypatch):
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 2)
    table, repo, rule_repo, rid = _seed_rule("coles", "groceries")
    rows = [_row(SPENDING, f"2026-07-{n:02d}", f"t{n}", description="COLES",
                 category="groceries", filed_by_rule=rid) for n in range(1, 6)]
    table.seed(*rows)

    _, body = _delete(handler, rule_repo, repo, rule_delete_event(rid))

    assert body["remaining"] == 3          # 5 owned, 2 cleared this request
    cleared = sum(1 for n in range(1, 6) if "category" not in stored(table, f"t{n}"))
    assert cleared == 2
