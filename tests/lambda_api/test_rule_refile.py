"""WHIT-540 — editing a rule re-files the charges it already filed; deleting a rule undoes them.

Drives update_rule_route / delete_rule_route directly (like test_apply_rules drives its route), so
the store->client mapping (_rule_to_client), the re-file helper (_refile_rule_touched) and the two
stamp-conditioned repository writes are all exercised end to end against the realistic feed fake.

Rule ids come from rule_engine.rule_id_for (the id IS the folded text). Rather than import that
module at collection time (the lambda_api suite forbids it — see conftest), the OLD id is read back
from the FakeRuleRepo that derived it, and the NEW id (after a text edit) from the response body.

The invariant everything leans on: a charge still carries `filed_by_rule == <id>` ONLY while the
user hasn't hand-filed it since (a manual file REMOVEs the stamp, WHIT-536). So "scan for the
stamp" returns exactly the rule-owned, user-untouched charges — the user's own choices are excluded
by construction, and the writes below re-confirm the stamp so a tap in the scan->write gap wins.
"""

import json

from _feed_fakes import SPENDING, _row, WritableFeedRepo, FakeCategoryRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = frozenset({"groceries", "petrol", "eatingout"})


def _rule(value, category_id="groceries", field="description", operator="contains"):
    return {"field": field, "operator": operator, "value": value, "category_id": category_id}


def _seed_rule(value, category_id="groceries", field="description", operator="contains"):
    """A FakeRuleRepo holding one rule, plus the id the store derived for it (== the stamp)."""
    repo = FakeRuleRepo(rules=[_rule(value, category_id, field, operator)])
    return repo, repo.list_rules()[0]["id"]


def _put_event(rule_id, value, category_id, field="description", operator="contains"):
    return {
        "rawPath": f"/rules/{rule_id}",
        "requestContext": {"http": {"method": "PUT"}},
        "pathParameters": {"id": rule_id},
        "body": json.dumps({"value": value, "categoryId": category_id,
                            "field": field, "operator": operator}),
    }


def _delete_event(rule_id):
    return {
        "rawPath": f"/rules/{rule_id}",
        "requestContext": {"http": {"method": "DELETE"}},
        "pathParameters": {"id": rule_id},
    }


def _update(handler, rule_repo, txn_repo, event, categories=_CATEGORIES):
    resp = handler.update_rule_route(event, rule_repo, FakeCategoryRepo(categories), txn_repo)
    return resp, json.loads(resp["body"])


def _delete(handler, rule_repo, txn_repo, event):
    resp = handler.delete_rule_route(event, rule_repo, txn_repo)
    return resp, json.loads(resp["body"])


def _row_at(repo, txn_id, account=SPENDING):
    return repo._find_row(f"ACCOUNT#{account}", f"TXN#{txn_id}")


# --- edit a description rule: material value change re-evaluates ----------------


def test_edit_description_value_refiles_matches_and_clears_non_matches(handler):
    # "coles" -> "coles express" (a real value edit -> a NEW id). A charge that still matches the new
    # value moves to the new target and is re-keyed; one that no longer matches is un-filed.
    rule_repo, old = _seed_rule("coles", "groceries")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "still", description="COLES EXPRESS PETROL",
             category="groceries", filed_by_rule=old),
        _row(SPENDING, "2026-07-01", "gone", description="COLES 1",
             category="groceries", filed_by_rule=old),
    ]})

    resp, body = _update(handler, rule_repo, repo, _put_event(old, "coles express", "petrol"))
    new = body["id"]

    assert resp["statusCode"] == 200 and new != old and body["remaining"] == 0
    still = _row_at(repo, "still")
    assert still["category"] == "petrol" and still["filed_by_rule"] == new  # re-filed + re-keyed
    gone = _row_at(repo, "gone")
    assert "category" not in gone and "filed_by_rule" not in gone           # no longer matches -> cleared


def test_edit_description_target_only_moves_every_owned_charge_in_place(handler):
    # A target-only edit keeps the id (id == hash of the folded value). The match set is unchanged,
    # so every owned charge just moves to the new target — nothing is re-evaluated or cleared.
    rule_repo, rid = _seed_rule("coles", "groceries")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "a", description="COLES 1", category="groceries", filed_by_rule=rid),
        _row(SPENDING, "2026-07-01", "b", description="ALDI", category="groceries", filed_by_rule=rid),
    ]})

    _, body = _update(handler, rule_repo, repo, _put_event(rid, "coles", "petrol"))

    assert body["id"] == rid and body["remaining"] == 0
    # "ALDI" would NOT match "coles" — but because this is an in-place edit we do NOT re-evaluate,
    # so it moves too (it was owned by the rule). FAIL-ON-REVERT: re-evaluate on an in-place edit and
    # "b" is wrongly cleared.
    assert _row_at(repo, "a")["category"] == "petrol"
    assert _row_at(repo, "b")["category"] == "petrol"
    assert _row_at(repo, "a")["filed_by_rule"] == rid


# --- edit a CATEGORY rule: never re-evaluate (the WHIT-540 blocker) -------------


def test_edit_category_rule_refiles_without_reevaluating(handler):
    # A `category equals FOOD_AND_DRINK -> groceries` rule OVERWROTE the charge's category to
    # "groceries" when it filed it. Editing the rule's match value changes the id, which would
    # normally re-evaluate — but re-running "category equals SUPERMARKETS" against a charge now
    # storing "groceries" never matches, so it would WRONGLY clear a correctly-filed charge.
    # FAIL-ON-REVERT: drop the `field != "category"` guard in _refile_rule_touched and "t1" is
    # cleared instead of re-filed.
    rule_repo, old = _seed_rule("FOOD_AND_DRINK", "groceries", field="category", operator="equals")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="WOOLIES", category="groceries", filed_by_rule=old),
    ]})

    _, body = _update(handler, rule_repo, repo,
                     _put_event(old, "SUPERMARKETS", "petrol", field="category", operator="equals"))
    new = body["id"]

    assert new != old                          # value changed -> id changed
    t1 = _row_at(repo, "t1")
    assert t1["category"] == "petrol"          # re-filed to the new target, NOT cleared
    assert t1["filed_by_rule"] == new
    assert body["remaining"] == 0


# --- tap-wins and isolation -----------------------------------------------------


def test_edit_leaves_a_charge_the_user_refiled_since(handler):
    # The user hand-filed "t1" after the rule filed it, so its stamp was REMOVEd (WHIT-536). This
    # guards the SCAN-LEVEL filter: with no stamp it isn't in `touched`, so no write is attempted
    # (asserted via repo.writes == []). The write CONDITION's own tap-wins guard is
    # fail-on-revert-covered in test_repository_transaction.py.
    rule_repo, old = _seed_rule("coles", "groceries")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1", category="coffee"),  # no stamp
    ]})

    _update(handler, rule_repo, repo, _put_event(old, "coles", "petrol"))

    assert _row_at(repo, "t1")["category"] == "coffee"   # user's choice stands
    assert repo.writes == []                             # never even attempted


def test_edit_leaves_charges_owned_by_other_rules(handler):
    rule_repo, old = _seed_rule("coles", "groceries")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "mine", description="COLES 1", category="groceries", filed_by_rule=old),
        _row(SPENDING, "2026-07-01", "theirs", description="ALDI", category="groceries", filed_by_rule="other-rule"),
    ]})

    _update(handler, rule_repo, repo, _put_event(old, "coles", "petrol"))

    assert _row_at(repo, "theirs")["category"] == "groceries"       # untouched
    assert _row_at(repo, "theirs")["filed_by_rule"] == "other-rule"


# --- delete a rule: undo its fills ----------------------------------------------


def test_delete_clears_every_charge_the_rule_filed(handler):
    rule_repo, rid = _seed_rule("coles", "groceries")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "a", description="COLES 1", category="groceries", filed_by_rule=rid),
        _row(SPENDING, "2026-07-01", "b", description="COLES 2", category="groceries", filed_by_rule=rid),
    ]})

    resp, body = _delete(handler, rule_repo, repo, _delete_event(rid))

    assert resp["statusCode"] == 200 and body == {"id": rid, "remaining": 0}
    for txn_id in ("a", "b"):
        row = _row_at(repo, txn_id)
        assert "category" not in row and "filed_by_rule" not in row   # back to unfiled


def test_delete_leaves_a_charge_the_user_refiled_since(handler):
    # The user hand-filed "kept" after the rule filed it, so its stamp was REMOVEd (WHIT-536). This
    # guards the SCAN-LEVEL filter: an unstamped row isn't in `touched`, so clear_rule_fill is never
    # even attempted on it. (The clear_rule_fill CONDITION itself — refusing a row whose stamp no
    # longer matches — is fail-on-revert-covered in test_repository_transaction.py.)
    rule_repo, rid = _seed_rule("coles", "groceries")
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "kept", description="COLES 1", category="coffee"),  # stamp gone
    ]})

    _delete(handler, rule_repo, repo, _delete_event(rid))

    assert _row_at(repo, "kept")["category"] == "coffee"


def test_delete_of_an_unknown_rule_undoes_nothing(handler):
    # Idempotent double-tap: deleting "deadbeef" scans for that id and finds nothing owned by it.
    repo = WritableFeedRepo({SPENDING: [
        _row(SPENDING, "2026-07-02", "t1", description="COLES 1", category="groceries",
             filed_by_rule="some-rule"),
    ]})

    resp, body = _delete(handler, FakeRuleRepo(), repo, _delete_event("deadbeef"))

    assert resp["statusCode"] == 200 and body["remaining"] == 0
    assert _row_at(repo, "t1")["category"] == "groceries"   # not this delete's business


# --- the write budget: a rule on more charges than one request can finish -------


def test_remaining_counts_charges_beyond_the_write_budget(handler, monkeypatch):
    monkeypatch.setattr(handler, "APPLY_RULES_MAX_WRITES", 2)
    rule_repo, rid = _seed_rule("coles", "groceries")
    rows = [_row(SPENDING, f"2026-07-{n:02d}", f"t{n}", description="COLES",
                 category="groceries", filed_by_rule=rid) for n in range(1, 6)]
    repo = WritableFeedRepo({SPENDING: rows})

    _, body = _delete(handler, rule_repo, repo, _delete_event(rid))

    assert body["remaining"] == 3          # 5 owned, 2 cleared this request
    cleared = sum(1 for n in range(1, 6) if "category" not in _row_at(repo, f"t{n}"))
    assert cleared == 2
