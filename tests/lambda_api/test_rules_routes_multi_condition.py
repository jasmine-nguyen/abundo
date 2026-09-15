"""WHIT-561: POST/PUT /rules accept a multi-condition body (conditions + logic) and validate it.
Driven through lambda_handler with a FakeRuleRepo injected, exactly like test_rules_routes.py."""

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


def _body(conditions=None, logic="all", category_id="transport"):
    if conditions is None:
        conditions = [{"field": "merchant", "operator": "contains", "value": "UBER"},
                      {"field": "amount", "operator": "less_than", "value": "30"}]
    return {"conditions": conditions, "logic": logic, "categoryId": category_id}


def test_create_multi_condition_rule_round_trips(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(_event("POST", "/rules", _body()), None)
    out = json.loads(resp["body"])
    assert resp["statusCode"] == 201
    assert out["logic"] == "all"
    assert [c["field"] for c in out["conditions"]] == ["merchant", "amount"]
    assert out["conditions"][0]["value"] == "UBER"          # text trimmed/kept
    assert out["conditions"][1]["value"] == "30"            # amount normalised to a canonical string
    assert repo.minted[0]["conditions"][1]["field"] == "amount"


def test_default_logic_is_all(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    body = _body()
    del body["logic"]
    out = json.loads(handler.lambda_handler(_event("POST", "/rules", body), None)["body"])
    assert out["logic"] == "all"


def test_bad_field_operator_pair_is_400(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    body = _body(conditions=[{"field": "amount", "operator": "contains", "value": "30"}])
    resp = handler.lambda_handler(_event("POST", "/rules", body), None)
    assert resp["statusCode"] == 400
    assert repo.minted == []


def test_bad_logic_is_400(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(_event("POST", "/rules", _body(logic="maybe")), None)
    assert resp["statusCode"] == 400


def test_non_numeric_amount_is_400(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    body = _body(conditions=[{"field": "amount", "operator": "less_than", "value": "lots"}])
    resp = handler.lambda_handler(_event("POST", "/rules", body), None)
    assert resp["statusCode"] == 400


def test_non_positive_amount_is_400(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    body = _body(conditions=[{"field": "amount", "operator": "less_than", "value": "0"}])
    resp = handler.lambda_handler(_event("POST", "/rules", body), None)
    assert resp["statusCode"] == 400


def test_bad_direction_value_is_400(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    body = _body(conditions=[{"field": "direction", "operator": "is", "value": "sideways"}])
    resp = handler.lambda_handler(_event("POST", "/rules", body), None)
    assert resp["statusCode"] == 400


def test_empty_conditions_list_is_400(handler, monkeypatch):
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    resp = handler.lambda_handler(_event("POST", "/rules", _body(conditions=[])), None)
    assert resp["statusCode"] == 400


def test_value_floor_applies_per_description_contains_condition(handler, monkeypatch):
    # A near-empty "description contains" condition would match nearly everything even inside an AND.
    repo = FakeRuleRepo()
    _inject(handler, monkeypatch, repo)
    body = _body(conditions=[{"field": "description", "operator": "contains", "value": "."},
                             {"field": "amount", "operator": "less_than", "value": "30"}])
    resp = handler.lambda_handler(_event("POST", "/rules", body), None)
    assert resp["statusCode"] == 400
    assert "letters or digits" in json.loads(resp["body"])["error"]
