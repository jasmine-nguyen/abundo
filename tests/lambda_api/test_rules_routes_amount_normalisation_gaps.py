"""WHIT-564 — ADVERSARIAL GAP coverage for amount-value normalisation, sibling to
test_rules_routes_amount_normalisation.py. That file locks create-path dedup on both write shapes;
this one locks what it did NOT: the EDIT path (id stability => no orphaned history), the flat<->multi
EDIT boundary, the budget_excluded clash dimension, amount-as-one-of-several multi conditions, the
sub-cent trailing-zero boundary, and the flat-path regressions the "route through
_validate_condition_value" rewrite introduced (direction now validated; text value.strip() parity).

Driven through lambda_handler with a FakeRuleRepo injected, exactly like the sibling suite and
test_rules_routes.py. FakeRuleRepo keys rows by id (a dedup hit does NOT append to `minted`) and
records `updated` / `deleted` so an in-place edit (id kept) is distinguishable from a move (id
changed, old id deleted).
"""

import json

from _feed_fakes import FakeCategoryRepo, WritableFeedRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = ("transport", "groceries")


def _event(method, path, body, path_params=None):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}},
             "body": json.dumps(body)}
    if path_params is not None:
        event["pathParameters"] = path_params
    return event


def _inject(handler, monkeypatch, repo, categories=_CATEGORIES):
    monkeypatch.setattr(handler, "RuleRepository", lambda: repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(handler, "TransactionRepository", lambda: WritableFeedRepo({}))


def _amount_body(value, category_id="transport"):
    return {"field": "amount", "operator": "less_than", "value": value, "categoryId": category_id}


def _multi_amount_body(value, category_id="transport"):
    return {"conditions": [{"field": "amount", "operator": "less_than", "value": value}],
            "logic": "all", "categoryId": category_id}


def _post(handler, body):
    return handler.lambda_handler(_event("POST", "/rules", body), None)


def _put(handler, rule_id, body):
    return handler.lambda_handler(
        _event("PUT", f"/rules/{rule_id}", body, path_params={"id": rule_id}), None)


# --- EDIT path: re-spelling an amount MUST NOT move the id (no orphaned history) -------------


def test_edit_amount_respelling_keeps_id_in_place(handler, monkeypatch):
    # [A9] LANDMINE: the id IS the DB key and charges are stamped filed_by_rule=<id>. Editing a
    # rule stored "30" to the equivalent "30.00" must normalise back to "30" -> SAME id -> an IN-PLACE
    # update (no move, no delete of the old id), so nothing stamped with the old id orphans.
    # FAIL-ON-REVERT: drop format(...,"f") and "30.00" keeps its zeros -> a new id -> the row MOVES
    # (repo.deleted gains the old id, body id changes), orphaning every charge the rule filed.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    created = json.loads(_post(handler, _amount_body("30"))["body"])
    rule_id = created["id"]

    resp = _put(handler, rule_id, _amount_body("30.00"))
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["id"] == rule_id                 # id unchanged -> no orphaned filed_by_rule stamps
    assert body["value"] == "30"                 # normalisation still reaches the stored value
    assert repo.deleted == []                    # NOT a move
    assert [r["id"] for r in repo.list_rules()] == [rule_id]   # still exactly one row


def test_edit_amount_across_flat_to_multi_boundary_keeps_id(handler, monkeypatch):
    # [A10] Editing a FLAT amount rule "30" into the equivalent one-condition MULTI body "30.00"
    # must still collapse to the same legacy id (single-condition collapse + normalisation), so it is
    # an in-place edit across the flat<->multi boundary, not a move onto a new id.
    # FAIL-ON-REVERT: without normalisation the multi "30.00" condition hashes to a different id ->
    # the row moves and the old id (with its history) is orphaned.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    flat = json.loads(_post(handler, _amount_body("30"))["body"])
    rule_id = flat["id"]

    resp = _put(handler, rule_id, _multi_amount_body("30.00"))
    body = json.loads(resp["body"])

    assert resp["statusCode"] == 200
    assert body["id"] == rule_id
    assert repo.deleted == []
    assert [r["id"] for r in repo.list_rules()] == [rule_id]


# --- budget_excluded is a clash dimension: two spellings, different flag => 409, not two rows -----


def test_amount_spelling_with_different_budget_flag_clashes(handler, monkeypatch):
    # [A11] budget_excluded is part of a rule's clash contract (WHIT-558). Once "30" and "30.00"
    # normalise to ONE identity, posting the second spelling with a DIFFERENT budget flag is a genuine
    # conflict on the same row -> 409, NOT a silently-stored duplicate row.
    # FAIL-ON-REVERT: without normalisation "30.00" gets its own id -> no clash -> a 201 second row,
    # exactly the duplicate WHIT-564 removes.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    first = _post(handler, {**_amount_body("30"), "budgetExcluded": False})
    assert first["statusCode"] == 201

    second = _post(handler, {**_amount_body("30.00"), "budgetExcluded": True})
    assert second["statusCode"] == 409
    assert len(repo.minted) == 1
    assert len(repo.list_rules()) == 1


# --- amount as ONE OF SEVERAL conditions: the normalised value must reach the multi id -----------


def test_multi_amount_condition_among_others_dedups(handler, monkeypatch):
    # [A17] When amount is one condition of a multi rule, its value feeds _condition_key ->
    # rule_id_for_conditions. The normalisation must apply there too, so
    # [merchant=coles AND amount<30.00] and [merchant=coles AND amount<30] are ONE rule.
    # FAIL-ON-REVERT: raw "30.00" makes the amount condition key differ -> a different multi id ->
    # two rows.
    def body(amount_value):
        return {"conditions": [{"field": "merchant", "operator": "equals", "value": "coles"},
                               {"field": "amount", "operator": "less_than", "value": amount_value}],
                "logic": "all", "categoryId": "transport"}

    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    first = json.loads(_post(handler, body("30.00"))["body"])
    second = json.loads(_post(handler, body("30"))["body"])

    assert first["id"] == second["id"]
    assert len(repo.minted) == 1
    # the stored amount condition is canonical, not "30.00"
    amount_cond = next(c for c in first["conditions"] if c["field"] == "amount")
    assert amount_cond["value"] == "30"


# --- sub-cent boundary: trailing-zero dedup, but genuinely distinct cents stay distinct ----------


def test_sub_cent_trailing_zero_dedups_but_distinct_cents_split(handler, monkeypatch):
    # [A12] Boundary the sibling suite skips: below $1. 0.10 and 0.1 are the same -> one row;
    # 0.05 is a different amount from 0.5 (not a trailing-zero variant) -> its own row.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    a = json.loads(_post(handler, _multi_amount_body("0.10"))["body"])
    b = json.loads(_post(handler, _multi_amount_body("0.1"))["body"])
    assert a["id"] == b["id"]
    assert a["conditions"][0]["value"] == "0.1"

    c = json.loads(_post(handler, _multi_amount_body("0.05", category_id="groceries"))["body"])
    d = json.loads(_post(handler, _multi_amount_body("0.5", category_id="groceries"))["body"])
    assert c["id"] != d["id"]
    assert len({a["id"], c["id"], d["id"]}) == 3
    assert len(repo.minted) == 3


# --- flat path now routes through _validate_condition_value: direction + text regressions ---------


def test_flat_direction_rule_now_validates_its_value(handler, monkeypatch):
    # [A13] Before Option B the flat path stored value.strip() with NO field-specific validation,
    # so a flat direction rule with a bogus value ("banana") was stored and matched nothing. Routing
    # the flat value through _validate_condition_value now rejects it (400) while a valid direction is
    # accepted (201).
    # FAIL-ON-REVERT: restore the raw value.strip() flat branch and "banana" is stored -> 201.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    bad = _post(handler, {"field": "direction", "operator": "is", "value": "banana",
                          "categoryId": "transport"})
    assert bad["statusCode"] == 400
    assert repo.minted == []

    good = _post(handler, {"field": "direction", "operator": "is", "value": "debit",
                           "categoryId": "transport"})
    assert good["statusCode"] == 201
    assert json.loads(good["body"])["value"] == "debit"


def test_flat_text_value_strip_and_empty_parity_preserved(handler, monkeypatch):
    # [A14] Regression parity for the common flat text rule: a surrounding-whitespace value is
    # still trimmed to its stripped form (value.strip() parity), and an empty / whitespace-only value
    # is still a 400 (the "value is required" guard the rewrite must not have dropped).
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)

    ok = _post(handler, {"field": "description", "operator": "contains", "value": "  COLES  ",
                         "categoryId": "groceries"})
    assert ok["statusCode"] == 201
    assert json.loads(ok["body"])["value"] == "COLES"          # stripped, exactly as before

    for empty in ["", "   "]:
        resp = _post(handler, {"field": "description", "operator": "contains", "value": empty,
                               "categoryId": "groceries"})
        assert resp["statusCode"] == 400                      # still rejected
    assert len(repo.minted) == 1                              # only the good rule was written
