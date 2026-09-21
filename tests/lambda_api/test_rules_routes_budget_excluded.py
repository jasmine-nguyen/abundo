"""WHIT-558 gap: the "keep out of budget" flag through the HTTP rules routes.

The implementer pinned the flag at the repo layer (test_repository_rule_budget_excluded.py) and the
apply paths. This suite covers the ROUTE seams they didn't: a same-text/same-category create that
disagrees ONLY on the flag must 409 through the route and surface the existing rule's flag in the
body; the create/update round-trips carry it; and a legacy row written before the field reads back
budgetExcluded:false (never KeyErrors) through _rule_to_client.

Driven through lambda_handler with a FakeRuleRepo injected, exactly like test_rules_routes.py.
"""

import json

from _feed_fakes import FakeCategoryRepo, WritableFeedRepo
from _rule_fakes import FakeRuleRepo


_CATEGORIES = ("groceries", "petrol")


def _rule(value, category_id="groceries", **kw):
    return {"field": "description", "operator": "contains", "value": value,
            "category_id": category_id, **kw}


def _event(method, path, body=None, path_params=None):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    if body is not None:
        event["body"] = json.dumps(body)
    if path_params is not None:
        event["pathParameters"] = path_params
    return event


def _inject(handler, monkeypatch, rule_repo, categories=_CATEGORIES):
    monkeypatch.setattr(handler, "RuleRepository", lambda: rule_repo)
    monkeypatch.setattr(handler, "CategoryRepository", lambda: FakeCategoryRepo(categories))
    monkeypatch.setattr(handler, "TransactionRepository", lambda: WritableFeedRepo({}))


def test_create_rule_round_trips_budget_excluded_true(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "SPLITWISE", "categoryId": "groceries", "budgetExcluded": True}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert body["budgetExcluded"] is True
    assert repo.minted[0]["budget_excluded"] is True


def test_create_rule_same_text_same_category_different_flag_is_a_409(handler, monkeypatch):
    # The clash dimension surfaced at the ROUTE: a rule with the same text + category but a
    # DIFFERENT flag would fight over whether the charge is kept out of budget. The 409 body must
    # carry the EXISTING rule's flag (False here) so the app shows the truth, not the attempted True.
    # FAIL-ON-REVERT: drop the flag term from create_rule's clash test and this returns 201.
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries", budget_excluded=False)])
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(
        _event("POST", "/rules",
               {"value": "COLES", "categoryId": "groceries", "budgetExcluded": True}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 409
    assert body["existingRule"]["value"] == "COLES"
    assert body["existingRule"]["budgetExcluded"] is False   # the stored winner, not the attempt
    assert len(repo.list_rules()) == 1


def test_update_rule_toggles_the_flag_in_place_and_returns_it(handler, monkeypatch):
    repo = FakeRuleRepo(rules=[_rule("COLES", "groceries", budget_excluded=False)])
    _inject(handler, monkeypatch, repo)
    rule_id = repo.list_rules()[0]["id"]
    resp = handler.lambda_handler(
        _event("PUT", "/rules/x", {"value": "COLES", "categoryId": "groceries",
                                   "budgetExcluded": True}, path_params={"id": rule_id}), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    assert body["budgetExcluded"] is True
    assert repo.get_rule(rule_id)["budget_excluded"] is True


def test_legacy_row_without_the_field_reads_back_budget_excluded_false(handler, monkeypatch):
    # A rule written before WHIT-558 has no budget_excluded key. _rule_to_client must default it via
    # .get, never KeyError. FAIL-ON-REVERT: change bool(row.get("budget_excluded")) to
    # bool(row["budget_excluded"]) in _rule_to_client and the GET 500s on the legacy row.
    legacy = {"id": "r-legacy", "field": "description", "operator": "contains",
              "value": "OLDRULE", "category_id": "groceries", "source": "app"}
    repo = FakeRuleRepo(rules=[])
    repo._rows["r-legacy"] = legacy
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(_event("GET", "/rules"), None)
    body = json.loads(resp["body"])
    assert resp["statusCode"] == 200
    row = next(r for r in body if r["value"] == "OLDRULE")
    assert row["budgetExcluded"] is False
